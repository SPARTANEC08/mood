/**
 * Хранилища на SQLite с прежним API `JsonStore` / `JsonDocument`.
 *
 * Классы оставлены с теми же методами, чтобы модули данных не переписывать:
 * - `JsonStore<T>` — плоская карта «ключ → запись» (ДЗ, «Важное», снимки,
 *   админы, bot flows). Пишет/читает строки `records`, а не файл целиком.
 * - `JsonDocument<T>` — документ целиком (объявления, регистрация, статистика,
 *   согласия). Хранится одной строкой `documents`.
 *
 * Исключение — `users.json`: он разложен по строкам таблицы `users` и пишется
 * диффом (изменившиеся пользователи), а не всем документом. Это самый горячий
 * путь: раньше любой patch переписывал ~100 КБ.
 */

import { getDb, databaseFile } from './sqlite.ts';

const USERS_DOCUMENT = 'users.json';

interface UserRow {
  user_id: string;
  data: string;
}

/** Плоский стор: одна строка на ключ. */
export class JsonStore<T> {
  private readonly storeKey: string;
  private cache: Record<string, T> | null = null;
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();

  constructor(fileName: string) {
    this.storeKey = fileName;
  }

  all(): Record<string, T> {
    if (this.cache) return this.cache;

    const rows = getDb()
      .prepare('SELECT key, value FROM records WHERE store = ?')
      .all(this.storeKey) as Array<{ key: string; value: string }>;

    const out: Record<string, T> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value) as T;
      } catch {
        // Битая строка не должна ронять всё хранилище.
      }
    }

    this.cache = out;
    return out;
  }

  values(): T[] {
    return Object.values(this.all());
  }

  get(key: string | number): T | undefined {
    return this.all()[String(key)];
  }

  set(key: string | number, value: T): void {
    this.stage(key, value);
    this.save();
  }

  delete(key: string | number): T | undefined {
    const removed = this.remove(key);
    if (removed !== undefined) this.save();
    return removed;
  }

  stage(key: string | number, value: T): void {
    const id = String(key);
    this.all()[id] = value;
    this.dirty.add(id);
    this.removed.delete(id);
  }

  remove(key: string | number): T | undefined {
    const id = String(key);
    const existing = this.all()[id];
    if (existing !== undefined) {
      delete this.all()[id];
      this.dirty.delete(id);
      this.removed.add(id);
    }
    return existing;
  }

  save(): void {
    if (this.dirty.size === 0 && this.removed.size === 0) return;

    const db = getDb();
    const data = this.all();
    const upsert = db.prepare(
      'INSERT INTO records(store, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(store, key) DO UPDATE SET value = excluded.value',
    );
    const remove = db.prepare('DELETE FROM records WHERE store = ? AND key = ?');

    try {
      db.transaction(() => {
        for (const key of this.dirty) {
          const value = data[key];
          if (value === undefined) continue;
          upsert.run(this.storeKey, key, JSON.stringify(value));
        }
        for (const key of this.removed) remove.run(this.storeKey, key);
      })();

      this.dirty.clear();
      this.removed.clear();
    } catch (err: unknown) {
      console.error(
        `[SqliteStore] не удалось сохранить ${this.storeKey}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Документ: одна строка `documents`. `users.json` — особая ветка с таблицей
 * пользователей и записью только изменившихся строк.
 */
export class JsonDocument<T extends object> {
  private readonly name: string;
  private readonly decodeUser?: (user: Record<string, unknown>) => Record<string, unknown>;
  private readonly encodeUser?: (user: Record<string, unknown>) => Record<string, unknown>;
  private cache: T | null = null;
  /** Последнее сохранённое состояние пользователей: userId → JSON. */
  private persistedUsers: Map<string, string> | null = null;
  /**
   * Кто изменился с прошлого сохранения.
   *
   * `users.json` — самый горячий документ: нотификатор патчит по пользователю
   * (cookie OWA, снимки, флаги), и раньше каждый такой патч стрингифицировал
   * ВСЕХ пользователей, чтобы найти изменения. Теперь пишутся только те, кого
   * пометил userStore.
   */
  private readonly dirtyUsers = new Set<string>();
  /** Полная перезапись нужна только после replace() — сброса базы. */
  private fullUsersRewrite = false;

  constructor(
    fileName: string,
    options: {
      /** Преобразование записи при чтении (например, расшифровка cookie). */
      decodeUser?: (user: Record<string, unknown>) => Record<string, unknown>;
      /** Преобразование записи при записи (шифрование cookie). */
      encodeUser?: (user: Record<string, unknown>) => Record<string, unknown>;
    } = {},
  ) {
    this.name = fileName;
    this.decodeUser = options.decodeUser;
    this.encodeUser = options.encodeUser;
  }

  read(): T {
    if (this.cache) return this.cache;

    if (this.name === USERS_DOCUMENT) {
      this.cache = this.readUsers() as T;
      return this.cache;
    }

    const row = getDb()
      .prepare('SELECT value FROM documents WHERE name = ?')
      .get(this.name) as { value: string } | undefined;

    if (!row) {
      this.cache = {} as T;
      return this.cache;
    }

    try {
      this.cache = JSON.parse(row.value) as T;
    } catch {
      this.cache = {} as T;
    }
    return this.cache;
  }

  stage(doc: T): void {
    this.cache = doc;
  }

  save(): void {
    if (this.name === USERS_DOCUMENT) {
      this.saveUsers();
      return;
    }

    try {
      getDb()
        .prepare(
          'INSERT INTO documents(name, value) VALUES (?, ?) ' +
            'ON CONFLICT(name) DO UPDATE SET value = excluded.value',
        )
        .run(this.name, JSON.stringify(this.read()));
    } catch (err: unknown) {
      console.error(
        `[SqliteDocument] не удалось сохранить ${this.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  replace(doc: T): void {
    this.cache = doc;
    // Сброс базы: сравнивать построчно не с чем — пишем/удаляем всё.
    if (this.name === USERS_DOCUMENT) this.fullUsersRewrite = true;
    this.save();
  }

  drop(): void {
    this.cache = null;
    this.persistedUsers = null;
    this.dirtyUsers.clear();
    this.fullUsersRewrite = false;

    if (this.name === USERS_DOCUMENT) {
      getDb().exec('DELETE FROM users');
      return;
    }

    getDb().prepare('DELETE FROM documents WHERE name = ?').run(this.name);
  }

  /**
   * Помечает пользователя изменённым перед save().
   *
   * Вызывается только из userStore: он единственный владелец документа users.
   */
  markUserChanged(userId: string): void {
    this.dirtyUsers.add(userId);
  }

  /** Абсолютный путь к БД — нужен скриптам сброса/бэкапа. */
  get path(): string {
    return databaseFile;
  }

  /* ───────────────────────────── users ───────────────────────────── */

  private readUsers(): object {
    const rows = getDb()
      .prepare('SELECT user_id, data FROM users')
      .all() as UserRow[];

    const users: Record<string, unknown> = {};
    const byTelegramId: Record<string, string> = {};
    const byBarsLoginHash: Record<string, string> = {};
    const persisted = new Map<string, string>();

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        // Расшифровка cookie происходит здесь, один раз на процесс: дальше
        // приложение работает с обычным плейнтекстом, как раньше.
        const user = this.decodeUser ? this.decodeUser(parsed) : parsed;
        users[row.user_id] = user;
        // Сравнение изменений при записи идёт по плейнтексту, иначе новый
        // случайный IV делал бы каждую запись «изменившейся» при каждом save.
        persisted.set(row.user_id, JSON.stringify(user));
        if (typeof user.telegramId === 'number') {
          byTelegramId[String(user.telegramId)] = row.user_id;
        }
        if (typeof user.barsLoginHash === 'string' && user.barsLoginHash) {
          byBarsLoginHash[user.barsLoginHash] = row.user_id;
        }
      } catch {
        // Битый JSON пользователя пропускаем, остальные остаются доступны.
      }
    }

    this.persistedUsers = persisted;
    return { users, index: { byTelegramId, byBarsLoginHash } };
  }

  private saveUsers(): void {
    // Ничего не помечено — писать нечего. Это главный выигрыш: патч одного
    // пользователя больше не перебирает и не стрингифицирует всех.
    if (!this.fullUsersRewrite && this.dirtyUsers.size === 0) return;

    const doc = this.read() as unknown as {
      users?: Record<string, Record<string, unknown>>;
    };
    const users = doc.users ?? {};

    const previous = this.persistedUsers ?? new Map<string, string>();
    const db = getDb();
    const { upsert, remove } = userStatements(db);

    // Полная перезапись — только после replace(): тогда смотрим и на записи,
    // которых в документе больше нет.
    const ids = this.fullUsersRewrite
      ? new Set([...Object.keys(users), ...previous.keys()])
      : new Set(this.dirtyUsers);

    try {
      db.transaction(() => {
        for (const userId of ids) {
          const user = users[userId];

          if (!user) {
            if (previous.delete(userId)) remove.run(userId);
            continue;
          }

          const plainJson = JSON.stringify(user);
          if (previous.get(userId) === plainJson) continue;

          // В строку кладём зашифрованную копию (cookie), а сравнение
          // «изменилось ли» идёт по плейнтексту.
          const stored = this.encodeUser ? this.encodeUser(user) : user;
          const json = this.encodeUser ? JSON.stringify(stored) : plainJson;
          const now = new Date().toISOString();
          const telegramId = typeof user.telegramId === 'number' ? user.telegramId : null;
          const hash = typeof user.barsLoginHash === 'string' ? user.barsLoginHash : '';

          upsert.run(
            userId,
            hash,
            telegramId,
            json,
            typeof user.createdAt === 'string' ? user.createdAt : now,
            typeof user.updatedAt === 'string' ? user.updatedAt : now,
          );

          previous.set(userId, plainJson);
        }
      })();

      this.persistedUsers = previous;
      this.dirtyUsers.clear();
      this.fullUsersRewrite = false;
    } catch (err: unknown) {
      console.error(
        '[SqliteDocument] не удалось сохранить users.json:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Подготовленные запросы к таблице users.
 *
 * Раньше `db.prepare` вызывался на каждое сохранение — мелочь, но на горячем
 * пути (патч пользователя в круге нотификатора) она складывалась в тысячи
 * лишних разборов SQL в сутки.
 */
let cachedStatements: {
  db: ReturnType<typeof getDb>;
  upsert: import('better-sqlite3').Statement;
  remove: import('better-sqlite3').Statement;
} | null = null;

function userStatements(db: ReturnType<typeof getDb>) {
  if (cachedStatements?.db === db) return cachedStatements;

  cachedStatements = {
    db,
    upsert: db.prepare(
      'INSERT INTO users(user_id, bars_login_hash, telegram_id, data, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET ' +
        '  bars_login_hash = excluded.bars_login_hash, ' +
        '  telegram_id = excluded.telegram_id, ' +
        '  data = excluded.data, ' +
        '  created_at = excluded.created_at, ' +
        '  updated_at = excluded.updated_at',
    ),
    remove: db.prepare('DELETE FROM users WHERE user_id = ?'),
  };

  return cachedStatements;
}
