/**
 * Назначенные администраторы бота.
 *
 * Два источника прав, объединяемых `isAdmin`:
 *   - `ADMIN_TELEGRAM_IDS` в env — «корневые» админы. Их нельзя снять из бота:
 *     иначе можно случайно остаться без доступа к админке;
 *   - этот стор — админы, назначенные через бота.
 *
 * Отдельный файл `admins.json` (JsonStore), потому что это плоская карта
 * «telegramId → запись» и потому что права не должны лежать в users.json:
 * users.json — персональные данные студентов, а список админов — служебный.
 */

import { JsonStore } from '../jsonStore.ts';

export interface AdminRecord {
  telegramId: number;
  /** ISO-время назначения. */
  addedAt: string;
  /** Кто назначил (telegramId админа). */
  addedBy: number;
}

const store = new JsonStore<AdminRecord>('admins.json');

/** Разбирает ADMIN_TELEGRAM_IDS: список через запятую, мусор игнорируется. */
export function envAdminIds(): number[] {
  const raw = process.env.ADMIN_TELEGRAM_IDS ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
}

/** Админ из env: снять его нельзя. */
export function isEnvAdmin(telegramId: number): boolean {
  return envAdminIds().includes(telegramId);
}

/** Единая проверка прав: env + назначенные. */
export function isAdmin(telegramId: number): boolean {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return false;
  return isEnvAdmin(telegramId) || store.get(telegramId) !== undefined;
}

/** Назначенные через бота (без env-админов). */
export function listAssignedAdmins(): AdminRecord[] {
  return store
    .values()
    .slice()
    .sort((a, z) => a.addedAt.localeCompare(z.addedAt));
}

/**
 * Назначает админа. Возвращает false, если он уже админ (env или назначен):
 * повторная запись не нужна и сбивала бы дату назначения.
 */
export function addAdmin(telegramId: number, addedBy: number): boolean {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return false;
  if (isAdmin(telegramId)) return false;

  store.set(telegramId, {
    telegramId,
    addedAt: new Date().toISOString(),
    addedBy,
  });
  return true;
}

/**
 * Снимает назначенного админа. Env-админа снять нельзя — возвращаем false.
 * Если записи нет, тоже false.
 */
export function removeAdmin(telegramId: number): boolean {
  if (isEnvAdmin(telegramId)) return false;
  return store.delete(telegramId) !== undefined;
}
