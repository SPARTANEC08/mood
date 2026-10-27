/**
 * Внешние ссылки, которые открываются из приложения.
 *
 * Почта ОСЭП живёт отдельно от Mood, и ссылка нужна в двух местах: в центре
 * уведомлений и в модалке нового письма. Один адрес в одном файле — чтобы
 * кнопки не разъехались.
 */
export const OSEP_MAIL_URL = 'https://mail.mpei.ru/owa/#path=/mail';

/** Поддержка и канал — одни и те же адреса в профиле, боте и инструкциях. */
export const SUPPORT_URL = 'https://t.me/mood_mpei_sup';
export const CHANNEL_URL = 'https://t.me/mood_mpei';
