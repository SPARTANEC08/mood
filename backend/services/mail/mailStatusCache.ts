/**
 * Статус почты ОСЭП: сколько писем и когда. Без содержимого.
 *
 * Раньше здесь лежало «превью» — тема, отправитель, вложения. Теперь приложение
 * не читает письма: ему нужны только количество непрочитанных для строки
 * «Почта» и UID последнего письма для проверки «пришло ли новое».
 *
 * Заполняет кэш фоновый нотификатор (он и так ходит в OWA раз в 20 минут).
 * Значение НЕ удаляется по TTL: если очередной заход не удался, лучше показать
 * последнее известное число, чем пустоту.
 */

export interface MailStatus {
  /** Всего писем в ящике (для диагностики; в интерфейсе не показывается). */
  total: number;
  /** Непрочитанных сейчас. */
  unseen: number;
  /** UID последнего известного письма (время получения, ms). */
  lastUid: number;
  /** Когда статус обновлён (ms). */
  updatedAt: number;
}

/** Сколько последних писем запрашиваем, чтобы найти новые UID. */
export const MAIL_CHECK_LIMIT = 50;

const statuses = new Map<string, MailStatus>();

/** Потолок по числу пользователей: запись крошечная, но людей много. */
const MAX_STATUSES = 500;

export function putMailStatus(
  userId: string,
  status: { total: number; unseen: number; lastUid: number },
): void {
  if (statuses.size >= MAX_STATUSES && !statuses.has(userId)) {
    const oldest = [...statuses.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) statuses.delete(oldest[0]);
  }

  statuses.set(userId, { ...status, updatedAt: Date.now() });
}

/** Статус из памяти без похода в почту. null — нотификатор ещё не собрал его. */
export function peekMailStatus(userId: string): MailStatus | null {
  return statuses.get(userId) ?? null;
}

export function clearMailStatus(userId: string): void {
  statuses.delete(userId);
}
