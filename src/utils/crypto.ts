import crypto from 'node:crypto';

/**
 * Утилита шифрования персональных данных пользователя (логин/пароль БАРС МЭИ).
 *
 * Алгоритм: AES-256-GCM.
 * - Ключ берётся из переменной окружения ENCRYPTION_SECRET_KEY и обязан быть ровно 32 байтами.
 *   Поддерживаются два формата: 64 hex-символа либо произвольная строка длиной 32 символа (UTF-8).
 * - Для каждого шифрования генерируется уникальный случайный IV (12 байт).
 * - GCM возвращает 16-байтовый authentication tag, который хранится отдельно.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

export interface EncryptedPayload {
  encryptedData: string;
  iv: string;
  tag: string;
}

/**
 * Ошибка конфигурации ключа шифрования. Бросается только при реальной попытке
 * зашифровать/расшифровать данные, чтобы не ломать запуск бота без секрета.
 */
export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigError';
  }
}

/**
 * Приводит значение из .env к буферу ключа ровно в 32 байта.
 */
function normalizeKey(raw: string | undefined): Buffer {
  const value = (raw ?? '').trim();

  if (!value) {
    throw new EncryptionConfigError(
      'ENCRYPTION_SECRET_KEY не задан. Укажите 32-байтный ключ в .env (64 hex-символа или 32 символа).',
    );
  }

  // 1) HEX-формат: 64 символа -> 32 байта
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  // 2) Произвольная строка, ровно 32 байта в UTF-8
  const asBytes = Buffer.from(value, 'utf-8');
  if (asBytes.length === KEY_LENGTH_BYTES) {
    return asBytes;
  }

  throw new EncryptionConfigError(
    `ENCRYPTION_SECRET_KEY имеет неверную длину: ${asBytes.length} байт, требуется ${KEY_LENGTH_BYTES} байт ` +
      '(64 hex-символа либо ровно 32 символа).',
  );
}

/**
 * Возвращает ключ шифрования, валидируя его длину.
 */
export function getEncryptionKey(): Buffer {
  return normalizeKey(process.env.ENCRYPTION_SECRET_KEY);
}

/**
 * Проверяет, что ключ шифрования корректно настроен, не бросая исключений.
 */
export function isEncryptionConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Шифрует строку алгоритмом AES-256-GCM.
 */
export function encrypt(text: string): EncryptedPayload {
  if (typeof text !== 'string') {
    throw new TypeError('encrypt(): текст должен быть строкой.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Расшифровывает строку, ранее зашифрованную функцией encrypt().
 */
export function decrypt(encryptedData: string, iv: string, tag: string): string {
  if (!encryptedData || !iv || !tag) {
    throw new EncryptionConfigError('decrypt(): отсутствуют данные, IV или authentication tag.');
  }

  const key = getEncryptionKey();

  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(tag, 'base64');

  if (ivBuf.length !== IV_LENGTH_BYTES) {
    throw new EncryptionConfigError(`decrypt(): некорректный IV (${ivBuf.length} байт вместо ${IV_LENGTH_BYTES}).`);
  }
  if (tagBuf.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new EncryptionConfigError(
      `decrypt(): некорректный authentication tag (${tagBuf.length} байт вместо ${AUTH_TAG_LENGTH_BYTES}).`,
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(tagBuf);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Утилита «зашифровать или упасть» для сервисных слоев.
 */
export function encryptOrThrow(text: string): EncryptedPayload {
  return encrypt(text);
}