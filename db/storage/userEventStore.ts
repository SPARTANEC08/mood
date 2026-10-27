/**
 * События для уведомлений внутри приложения.
 *
 * Telegram получает только тип события. Здесь хранится то же событие с
 * деталями для PWA: дисциплина и балл, номер/дата приказа, статус стипендии.
 * Для почты деталей нет — только «новое письмо».
 *
 * id детерминированный (`userId + ключ события`): если нотификатор повторит
 * круг после сбоя Telegram, то же событие не появится в приложении дважды.
 * Прочитанное помечается `read_at` и больше не показывается.
 */

import { getDb } from '../sqlite.ts';

export type UserEventKind = 'grade' | 'mail' | 'order' | 'scholarship';

export interface UserEvent {
  id: string;
  userId: string;
  kind: UserEventKind;
  label: string;
  details: string[];
  createdAt: string;
  readAt?: string | null;
}

export interface NewUserEvent {
  userId: string;
  key: string;
  kind: UserEventKind;
  label: string;
  details: string[];
  createdAt: string;
}

/** Сколько последних событий держим на пользователя. */
const MAX_EVENTS_PER_USER = 50;

interface EventRow {
  id: string;
  user_id: string;
  kind: string;
  label: string;
  details: string;
  created_at: string;
  read_at: string | null;
}

/**
 * Приводит старые детали к нынешнему виду.
 *
 * До этой версии в базе лежали строки «Дисциплина КТ2: 15 (+5)» и сводка
 * «За неделю: +N». Переписывать историю в SQLite ради подписи не нужно:
 * нормализуем при чтении. Новые записи уже приходят в нужном формате и
 * проходят через ту же функцию без изменений.
 */
function normalizeDetails(details: string[]): string[] {
  return details
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('За неделю:'))
    .map((line) => {
      const grade = /^(.*?)\s+КТ(\d+):(.*)$/.exec(line);
      if (grade) return `${grade[1]} · КМ${grade[2]}:${grade[3]}`;
      return line.replace(/КТ(\d+)/g, 'КМ$1');
    });
}

function fromRow(row: EventRow): UserEvent {
  let details: string[] = [];
  try {
    const parsed = JSON.parse(row.details);
    if (Array.isArray(parsed)) details = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // битые детали не должны ломать уведомление
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as UserEventKind,
    label: row.label,
    details: normalizeDetails(details),
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export const userEventStore = {
  /** Добавляет событие; повтор с тем же ключом игнорируется. */
  add(event: NewUserEvent): void {
    const db = getDb();
    const id = `${event.userId}:${event.key}`;

    db.prepare(
      'INSERT OR IGNORE INTO user_events(id, user_id, kind, label, details, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      event.userId,
      event.kind,
      event.label,
      JSON.stringify(event.details),
      event.createdAt,
    );

    // Держим только последние N событий пользователя.
    db.prepare(
      'DELETE FROM user_events WHERE user_id = ? AND id NOT IN (' +
        'SELECT id FROM user_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)',
    ).run(event.userId, event.userId, MAX_EVENTS_PER_USER);
  },

  /**
   * Первое непрочитанное событие пользователя.
   *
   * `since` — дата регистрации: события, созданные раньше, не отдаём. Для
   * новых аккаунтов это страховка от старых записей после миграции/восстановления.
   */
  nextFor(userId: string, since?: string): UserEvent | null {
    const row = getDb()
      .prepare(
        'SELECT id, user_id, kind, label, details, created_at, read_at ' +
          'FROM user_events WHERE user_id = ? AND read_at IS NULL ' +
          'AND (? IS NULL OR created_at >= ?) ' +
          'ORDER BY created_at ASC LIMIT 1',
      )
      .get(userId, since ?? null, since ?? null) as EventRow | undefined;

    return row ? fromRow(row) : null;
  },

  /**
   * Вся история событий пользователя для центра уведомлений.
   *
   * Новые сверху. Порядок при одинаковом `created_at` добивается по id, чтобы
   * список не «прыгал» между запросами: нотификатор пишет пачку событий одним
   * временем.
   */
  listForUser(userId: string, since?: string): UserEvent[] {
    const rows = getDb()
      .prepare(
        'SELECT id, user_id, kind, label, details, created_at, read_at ' +
          'FROM user_events WHERE user_id = ? AND (? IS NULL OR created_at >= ?) ' +
          'ORDER BY created_at DESC, id DESC',
      )
      .all(userId, since ?? null, since ?? null) as EventRow[];

    return rows.map(fromRow);
  },

  /** Сколько событий ещё не прочитано (созданных после регистрации). */
  unreadCount(userId: string, since?: string): number {
    const row = getDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM user_events ' +
          'WHERE user_id = ? AND read_at IS NULL AND (? IS NULL OR created_at >= ?)',
      )
      .get(userId, since ?? null, since ?? null) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  /** Отмечает прочитанными события пользователя после регистрации. */
  markAllRead(userId: string, since?: string): number {
    const result = getDb()
      .prepare(
        'UPDATE user_events SET read_at = ? ' +
          'WHERE user_id = ? AND read_at IS NULL AND (? IS NULL OR created_at >= ?)',
      )
      .run(new Date().toISOString(), userId, since ?? null, since ?? null);

    return result.changes;
  },

  /** Отмечает событие прочитанным. false — события нет или оно уже прочитано. */
  markRead(userId: string, id: string): boolean {
    const result = getDb()
      .prepare('UPDATE user_events SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), userId, id);
    return result.changes > 0;
  },

  clearForUser(userId: string): void {
    getDb().prepare('DELETE FROM user_events WHERE user_id = ?').run(userId);
  },

  reset(): void {
    getDb().exec('DELETE FROM user_events');
  },
};

