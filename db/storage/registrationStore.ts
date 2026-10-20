/**
 * Рубильник регистрации новых аккаунтов.
 *
 * Старые записи продолжают входить: ограничение проверяется только там, где
 * создаётся НОВАЯ запись (`completeRegistration`). Поэтому выключение не
 * выкидывает никого из уже зарегистрированных.
 *
 * Состояние живёт в JSON рядом с остальными данными и переключается из
 * админ-меню бота. По умолчанию — ЗАКРЫТО: файла нет → новые не создаются.
 */

import { JsonDocument } from '../jsonStore.ts';

interface RegistrationDocument {
  /** true — новые аккаунты создавать можно. */
  open: boolean;
}

const document = new JsonDocument<RegistrationDocument>('registration.json');

function read(): RegistrationDocument {
  const doc = document.read();
  return { open: doc?.open === true };
}

export const registrationStore = {
  /** Открыта ли регистрация новых аккаунтов. */
  isOpen(): boolean {
    return read().open;
  },

  setOpen(open: boolean): void {
    document.replace({ open });
  },

  /** Переключает и возвращает новое состояние. */
  toggle(): boolean {
    const open = !read().open;
    document.replace({ open });
    return open;
  },
};
