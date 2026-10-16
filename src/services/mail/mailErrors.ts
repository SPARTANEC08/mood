/**
 * Ошибки почтового клиента OWA (mail.mpei.ru/owa).
 *
 * Разделены по СМЫСЛУ, а не по коду ответа: вызывающему коду нужно решить, что
 * делать — перелогиниться, показать «нужен VPN», повторить или подождать. HTTP-
 * статусы (403/401/504) наружу выставляет тот, кто ловит эти ошибки.
 */

/** 403 от Forefront TMG (Network Access Message) — почта недоступна без сети/VPN МЭИ. */
export class MailUnreachableError extends Error {
  constructor(message = 'Почта недоступна. Возможно, нужен VPN МЭИ.') {
    super(message);
    this.name = 'MailUnreachableError';
  }
}

/** 401 OWA / возврат на форму входа: сессия истекла или неверный пароль. */
export class MailAuthError extends Error {
  constructor(message = 'Не удалось войти в почту OWA.') {
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
