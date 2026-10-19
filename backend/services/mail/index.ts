/**
 * Публичный вход в почтовый слой.
 *
 * Источник почты — OWA-скрапинг (`OwaMailClient`). IMAP-клиент удалён
 * полностью: порт 993 режется Forefront TMG, и почта доступна только через
 * веб-интерфейс.
 */

export { OwaMailClient } from './owaMailClient.ts';
export {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
  type MailAuthReason,
} from './mailErrors.ts';
export { forgetOwaClient, owaClientCacheStats, withOwaClient } from './owaClientRegistry.ts';
export { peekMailPreview, putMailPreview, clearMailPreview, type MailPreview } from './mailPreviewCache.ts';
export type { OsepCredentials, OsepMessageBrief, OsepFolderStatus, OsepMessage, FetchMessagesOptions } from './types.js';
