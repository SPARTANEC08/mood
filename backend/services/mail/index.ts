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
export {
  peekMailStatus,
  putMailStatus,
  clearMailStatus,
  MAIL_CHECK_LIMIT,
  type MailStatus,
} from './mailStatusCache.ts';
export type { OsepCredentials, OsepMessageId, OsepFolderStatus } from './types.js';
