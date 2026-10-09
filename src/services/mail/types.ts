/**
 * Типы данных почтового сервиса МЭИ (ОСЭП / mail.mpei.ru).
 */

export interface OsepCredentials {
  user: string;
  pass: string;
}

export interface OsepFolderStatus {
  total: number;
  unseen: number;
}

export interface OsepMessage {
  uid: number;
  date: Date;
  from: string;      // ФИО или email отправителя
  fromAddress: string;
  subject: string;
  snippet: string;   // Первые 150 символов текста без переносов и HTML
  hasAttachments: boolean;
  attachmentNames: string[];
  isSeen: boolean;
}

export interface FetchMessagesOptions {
  onlyUnread: boolean;
  limit: number;
}

/**
 * Краткая карточка письма — только метаданные из IMAP ENVELOPE и BODYSTRUCTURE.
 *
 * Тело письма при этом не скачивается. Нужна там, где требуется лишь понять,
 * что письмо новое: отправитель, тема, дата и наличие вложений.
 */
export interface OsepMessageBrief {
  uid: number;
  date: Date;
  from: string;
  subject: string;
  hasAttachments: boolean;
}
