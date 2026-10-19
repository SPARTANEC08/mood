/**
 * Авторизация PWA: долгоживущий токен для веб-версии приложения.
 *
 * Зачем это вообще нужно.
 *
 * Приложение открывается как обычный сайт и как PWA с иконки на домашнем
 * экране, то есть вне Telegram. Подписи Telegram (initData) там не существует
 * вовсе, и каждый запрос падал бы с 401. Поэтому личность подтверждается
 * собственным токеном, выдаваемым после входа логином и паролем БАРС.
 *
 * Что здесь НЕ делается и почему.
 *
 * - Не вводится JWT. JWT требует библиотеки, `exp` в секундах и целой системы
 *   refresh-токенов на стороне клиента. Здесь нужен один непрозрачный секрет,
 *   который сервер умеет проверить сам, и ничего больше: формат
 *   base64url(id).base64url(exp).base64url(hmac) читается глазами и не требует
 *   ни зависимостей, ни разбора заголовков.
 * - Ключ отдельный (PWA_AUTH_SECRET), а не общий с ENCRYPTION_SECRET_KEY.
 *   Секреты должны быть независимы: утечка одного не должна давать возможность
 *   подделать подпись другого, а смена ENCRYPTION_SECRET_KEY (ротация) не должна
 *   одновременно выкидывать из приложения всех студентов.
 * - KDF нет, ключ используется «как есть» — ровно как в utils/crypto.ts.
 *   Значение обязано быть высокоэнтропийным, поэтому генерируется оно
 *   командой node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   и скриптом backend/scripts/pwa-setup.mjs.
 *
 * Почему 90 дней.
 *
 * Это компромисс между удобством и безопасностью. Токен — единственный секрет,
 * лежащий в localStorage телефона: длинный срок сводит к минимуму случаи, когда
 * студент вынужден возвращаться в бота, а короткий превращал бы PWA в
 * неудобство (и переустановка приложения после года учёбы стала бы нормой).
 * 90 дней совпадает с академическим семестром: за это время пользователь
 * гарантированно открывает бота, а кнопка «Открыть в браузере» продлевает токен
 * без всяких дополнительных механизмов.
 *
 * Токен несёт userId — тот же идентификатор, по которому бо�� и PWA видят
 * одного и того же человека. Он не расширяет прав: все права (доступ к БАРС,
 * группа) сервер берёт из userStore по userId.
 *
 * В самом токене нет ни логина, ни пароля, ни Telegram ID: подделать можно
 * было бы содержимое, но подпись делает его бесполезным без PWA_AUTH_SECRET.
 */

import crypto from 'node:crypto';

/** Срок жизни токена: 90 дней. */
export const PWA_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Длина ключа в байтах — как у AES-256 в utils/crypto.ts. */
const KEY_LENGTH_BYTES = 32;

/**
 * Ошибка конфигурации секрета PWA.
 *
 * Бросается только при реальной попытке выдать токен, чтобы отсутствие
 * переменной не ломало запуск бота и Mini App — они от неё не зависят.
 */
export class PwaAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PwaAuthConfigError';
  }
}

/**
 * Приводит PWA_AUTH_SECRET к буферу ровно в 32 байта.
 *
 * Форматы те же, что у ENCRYPTION_SECRET_KEY в utils/crypto.ts:
 * 1) 64 hex-символа -> 32 байта;
 * 2) произвольная строка длиной ровно 32 байта в UTF-8.
 *
 * Именно «те же» — чтобы оператору не приходилось держать в голове два разных
 * правила для двух похожих секретов.
 */
function normalizePwaKey(raw: string | undefined): Buffer {
  const value = (raw ?? '').trim();

  if (!value) {
    throw new PwaAuthConfigError(
      'PWA_AUTH_SECRET не задан. Сгенерируйте 32-байтный ключ (64 hex-символа) командой ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))".',
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const asBytes = Buffer.from(value, 'utf-8');
  if (asBytes.length === KEY_LENGTH_BYTES) {
    return asBytes;
  }

  throw new PwaAuthConfigError(
    `PWA_AUTH_SECRET имеет неверную длину: ${asBytes.length} байт, требуется ${KEY_LENGTH_BYTES} байт ` +
      '(64 hex-символа либо ровно 32 символа).',
  );
}

/** Настроен ли PWA-секрет. Без него PWA просто не работает, а не падает. */
export function isPwaAuthConfigured(): boolean {
  try {
    normalizePwaKey(process.env.PWA_AUTH_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Подпись `${userId}.${expiresAt}` ключом PWA. */
function sign(userId: string, expiresAt: number): Buffer {
  const key = normalizePwaKey(process.env.PWA_AUTH_SECRET);
  return crypto.createHmac('sha256', key).update(`${userId}.${expiresAt}`).digest();
}

/**
 * Хэш токена для хранения в базе.
 *
 * В users.json лежит только хэш: сам токен — единственный секрет сессии, и
 * держать его в базе рядом с расшифрованными кодами было бы всё равно, что
 * отдавать сессии вместе с утечкой файла.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

/**
 * Выдаёт токен на PWA_TOKEN_TTL_MS.
 *
 * Состав: base64url(telegramId).base64url(expiresAtMs).base64url(подпись).
 * Ничего кроме номера Telegram и времени жизни в токене нет — все права
 * (доступ к БАРС, группа) сервер берёт из userStore по telegramId.
 */
export function issuePwaToken(
  userId: string,
  ttlMs: number = PWA_TOKEN_TTL_MS,
): { token: string; expiresAt: number } {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('issuePwaToken(): нужен userId.');
  }

  const expiresAt = Date.now() + ttlMs;
  const payload = `${base64UrlEncode(userId)}.${base64UrlEncode(String(expiresAt))}`;
  const signature = base64UrlEncodeBuffer(sign(userId, expiresAt));

  return { token: `${payload}.${signature}`, expiresAt };
}

/**
 * Проверяет токен и достаёт из него userId.
 *
 * Порядок проверок важен: сначала формат и длина, потом подпись, и только
 * потом срок. Обратный порядок дал бы утечку через время ответа: атакующий
 * перебирал бы время истечения и по задержке понимал, какие токены ещё живы.
 *
 * Любая неудача — это null, а не исключение: вызывающий код трактует null
 * как «токена нет» и переходит к обычному отказу, ничего не утекая наружу.
 */
export function verifyPwaToken(token: string): { userId: string; expiresAt: number } | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [idPart, expPart, sigPart] = parts;
  if (!idPart || !expPart || !sigPart) return null;

  const userId = base64UrlDecode(idPart);
  const expiresAt = Number(base64UrlDecode(expPart));
  if (!userId) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  // Подпись должна совпасть ДО проверки срока — иначе время ответа стало бы
  // побочным каналом утечки (см. выше).
  let expected: Buffer;
  try {
    expected = sign(userId, expiresAt);
  } catch {
    // Секрет не настроен: проверять нечем.
    return null;
  }

  const provided = base64UrlDecodeBuffer(sigPart);
  if (!provided || provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  if (Date.now() >= expiresAt) return null;

  return { userId, expiresAt };
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function base64UrlEncodeBuffer(value: Buffer): string {
  return value.toString('base64url');
}

/** base64url -> строка. Node 20 умеет base64url штатно. */
function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function base64UrlDecodeBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}