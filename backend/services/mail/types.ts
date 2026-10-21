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

/**
 * Минимум для проверки «есть ли новое письмо».
 *
 * Тема, отправитель, вложения и тело не запрашиваются: приложению нужно только
 * понять, что письмо появилось, и посчитать количество. UID — время получения
 * в миллисекундах (OWA ItemId сессионный и для диффа не годится).
 */
export interface OsepMessageId {
  uid: number;
  date: Date;
}
