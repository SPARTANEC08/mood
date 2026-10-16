/**
 * Публичный вход в почтовый слой.
 *
 * Источник почты — OWA-скрапинг (`OwaMailClient`). IMAP-клиент
 * (`osepMailClient.ts`) оставлен как deprecated и здесь намеренно не
 * реэкспортируется, чтобы новый код его не тянул.
 */

export { OwaMailClient } from './owaMailClient.ts';
export { MailAuthError, MailTimeoutError, MailUnreachableError } from './mailErrors.ts';
export { peekMailPreview, putMailPreview, clearMailPreview, type MailPreview } from './mailPreviewCache.ts';
export type { OsepCredentials, OsepMessageBrief, OsepFolderStatus, OsepMessage, FetchMessagesOptions } from './types.js';
