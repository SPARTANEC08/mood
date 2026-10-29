/**
 * Типы юридических документов и согласий.
 *
 * Отдельный модуль без импортов из storage/server, чтобы его могли
 * использовать и база, и маршруты, и клиентские проверки без циклов.
 */

/**
 * Типы акцептов.
 *
 * processing — обработка ПДн; dissemination — показ имени/материалов группе;
 * push — передача типа события в push-сервис браузера; terms — пользовательское
 * соглашение; guest — гостевой режим; age — подтверждение 18+.
 */
export type LegalDocId =
  | 'processing'
  | 'dissemination'
  | 'push'
  | 'terms'
  | 'guest'
  | 'age';

/** Сохранённый факт акцепта конкретной версии документа. */
export interface ConsentSnapshot {
  version: string;
  acceptedAt: string;
  ip?: string;
  method: 'pwa' | 'bot';
}

/** Запись журнала согласий (append-only, для доказательства). */
export interface ConsentLogRecord extends ConsentSnapshot {
  id: string;
  userId: string;
  type: LegalDocId;
  revokedAt?: string;
}

/** Метаданные документа для выдачи клиенту. */
export interface LegalDocument {
  id: LegalDocId;
  version: string;
  title: string;
  shortTitle: string;
  /** Полный текст на сайте приложения. */
  url: string;
  /** Требуется ли активный акцепт для продолжения работы. */
  required: boolean;
}

/** Статус согласий: что принято, что требуется, где читать тексты. */
export interface LegalStatus {
  consentRequired: boolean;
  missing: LegalDocId[];
  accepted: Array<{
    id: LegalDocId;
    version: string;
    acceptedAt: string;
  }>;
  documents: LegalDocument[];
  policy: {
    id: string;
    version: string;
    title: string;
    url: string;
  };
}
