/**
 * Шифрование cookie-сессий в записи пользователя.
 *
 * Что и зачем. Логин и пароль БАРС уже шифруются (`backend/utils/crypto.ts`),
 * но сессионные cookie БАРС и OWA лежали в SQLite открытым текстом. Утечка
 * файла базы (бэкап, ошибочный rsync, чтение локальным пользователем) давала
 * живые сессии личного кабинета и почты без расшифровки пароля. Теперь обе
 * cookie-сессии шифруются AES-256-GCM тем же ключом `ENCRYPTION_SECRET_KEY`,
 * у каждой — свой случайный IV и authentication tag.
 *
 * Формат хранения: `enc:v1:<iv>:<tag>:<ciphertext>` (base64url-безопасные
 * компоненты, разделитель — двоеточие). Префикс нужен по двум причинам:
 *   1. отличить зашифрованное от легаси-плейнтекста при чтении;
 *   2. не зашифровать одно и то же дважды.
 *
 * Обратная совместимость. Строка без префикса считается легаси-плейнтекстом и
 * возвращается как есть. Поэтому приложение продолжает работать со старой
 * базой, а запись переводится в шифр при первом же сохранении. Разово все
 * записи переводит `migrateCookieEncryption()` (см. `--migrate-cookies` в
 * `backend/server/main.ts`).
 *
 * Ошибка расшифровки не роняет процесс: повреждённая/чужая запись трактуется
 * как «сессии нет», пользователь просто войдёт заново. Иначе один битый
 * пользователь ломал бы чтение всей базы.
 */

import { decrypt, encrypt } from '../../backend/utils/crypto.ts';
import { getDb } from '../sqlite.ts';

const PREFIX = 'enc:v1:';

/** Поля записи пользователя, в которых лежат сериализованные cookie. */
const COOKIE_FIELDS = ['barsAuth', 'owaAuth'] as const;

type StoredUserJson = Record<string, unknown>;

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Шифрует значение, если оно ещё не зашифровано. Пустое — не трогаем. */
export function encryptSecret(value: string): string {
  if (!value || isEncryptedSecret(value)) return value;

  const payload = encrypt(value);
  return `${PREFIX}${payload.iv}:${payload.tag}:${payload.encryptedData}`;
}

/** Расшифровывает значение; легаси-плейнтекст возвращает как есть. */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;

  const [iv, tag, data] = value.slice(PREFIX.length).split(':');
  if (!iv || !tag || !data) {
    console.error('[userSecrets] повреждённый формат зашифрованных cookies — считаю сессию отсутствующей');
    return '';
  }

  try {
    return decrypt(data, iv, tag);
  } catch (err: unknown) {
    console.error(
      '[userSecrets] не удалось расшифровать cookies (ключ сменён или запись повреждена) — сессия сброшена:',
      err instanceof Error ? err.message : err,
    );
    return '';
  }
}

/**
 * Копия записи для хранения: cookie-сессии зашифрованы.
 *
 * Возвращает исходный объект, если шифровать нечего — чтобы diff в
 * `JsonDocument.saveUsers` не считал запись изменившейся зря.
 */
export function encodeUserSecrets(user: StoredUserJson): StoredUserJson {
  let changed = false;
  const next: StoredUserJson = { ...user };

  for (const field of COOKIE_FIELDS) {
    const auth = user[field];
    if (!auth || typeof auth !== 'object') continue;

    const record = auth as Record<string, unknown>;
    const cookies = record.cookiesJson;
    if (typeof cookies !== 'string' || cookies === '' || isEncryptedSecret(cookies)) continue;

    next[field] = { ...record, cookiesJson: encryptSecret(cookies) };
    changed = true;
  }

  return changed ? next : user;
}

/** Копия записи из хранилища: cookie-сессии расшифрованы. */
export function decodeUserSecrets(user: StoredUserJson): StoredUserJson {
  let changed = false;
  const next: StoredUserJson = { ...user };

  for (const field of COOKIE_FIELDS) {
    const auth = user[field];
    if (!auth || typeof auth !== 'object') continue;

    const record = auth as Record<string, unknown>;
    const cookies = record.cookiesJson;
    if (typeof cookies !== 'string' || !isEncryptedSecret(cookies)) continue;

    next[field] = { ...record, cookiesJson: decryptSecret(cookies) };
    changed = true;
  }

  return changed ? next : user;
}

export interface CookieMigrationResult {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Разовая миграция: шифрует cookies у всех записей, где они ещё открыты.
 *
 * Запускать при остановленном сервисе — иначе кэш `JsonDocument` в памяти
 * процесса может перезаписать строки старым содержимым.
 */
export function migrateCookieEncryption(): CookieMigrationResult {
  const db = getDb();
  const rows = db.prepare('SELECT user_id, data FROM users').all() as Array<{
    user_id: string;
    data: string;
  }>;
  const update = db.prepare('UPDATE users SET data = ? WHERE user_id = ?');

  let updated = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const row of rows) {
      let user: StoredUserJson;
      try {
        user = JSON.parse(row.data) as StoredUserJson;
      } catch {
        skipped += 1;
        continue;
      }

      const encoded = encodeUserSecrets(user);
      if (encoded === user) continue;

      update.run(JSON.stringify(encoded), row.user_id);
      updated += 1;
    }
  })();

  return { scanned: rows.length, updated, skipped };
}
