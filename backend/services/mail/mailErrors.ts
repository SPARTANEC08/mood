/**
 * Ошибки почтового клиента OWA (mail.mpei.ru/owa).
 *
 * Разделены по СМЫСЛУ, а не по коду ответа: вызывающему коду нужно решить, что
 * делать — перелогиниться, показать «нужен VPN», повторить или подождать. HTTP-
 * статусы (503/504/409) наружу выставляет тот, кто ловит эти ошибки.
 */

/** 403 от Forefront TMG (Network Access Message) — почта недоступна без сети/VPN МЭИ. */
export class MailUnreachableError extends Error {
  constructor(message = 'Почта недоступна. Возможно, нужен VPN МЭИ.') {
    super(message);
    this.name = 'MailUnreachableError';
  }
}

/**
 * Почему OWA не пустил. Подтип нужен, чтобы не говорить «проверьте пароль»
 * там, где пароль ни при чём (сломалась форма, сервер вернул вход, включена 2FA).
 */
export type MailAuthReason =
  /** POST логина вернул 401 или форму входа с ошибкой. */
  | 'invalid_credentials'
  /** POST прошёл, но session-cookie не появился. */
  | 'no_session_cookie'
  /** После POST снова отдалась страница входа без явной ошибки. */
  | 'returned_login_page'
  /** Форма логина не найдена / нет hidden-полей / контракт изменился. */
  | 'broken_form'
  /** 401 → перелогин → снова 401. */
  | 'session_expired_after_relogin'
  /** OWA показал страницу 2FA/SSO. Интерактивного входа нет. */
  | 'two_factor_required';

/** 401 OWA / возврат на форму входа: сессия истекла, неверный пароль или 2FA. */
export class MailAuthError extends Error {
  constructor(
    message = 'Не удалось войти в почту OWA.',
    readonly reason: MailAuthReason = 'invalid_credentials',
  ) {
    super(message);
    this.name = 'MailAuthError';
  }
}

/** Таймаут обращения к OWA. */
export class MailTimeoutError extends Error {
  constructor(message = 'Почта OWA не ответила вовремя.') {
    super(message);
    this.name = 'MailTimeoutError';
  }
}

/**
 * Человеческий текст по подтипу отказа. Один источник правды и для API, и для
 * CLI-скриптов: иначе пользователь снова начнёт читать «проверьте пароль» при
 * сломанной форме.
 */
export const MAIL_AUTH_MESSAGES: Record<MailAuthReason, string> = {
  invalid_credentials: 'Не удалось войти в почту. Проверьте логин и пароль БАРС.',
  no_session_cookie: 'Почта МЭИ вернула неожиданный ответ. Попробуйте позже.',
  returned_login_page: 'Почта МЭИ вернула неожиданный ответ. Попробуйте позже.',
  broken_form: 'Почта МЭИ вернула неожиданный ответ. Попробуйте позже.',
  session_expired_after_relogin: 'Сессия почты истекла. Войдите в приложение заново.',
  two_factor_required: 'Почта требует дополнительное подтверждение. Войдите через mail.mpei.ru/owa.',
};
