/**
 * Администраторы, назначенные из PWA.
 *
 * Отдельно от `adminsStore` (тот хранит Telegram ID): после отказа от Telegram
 * права должны жить на userId, иначе админку не открыть без мессенджера.
 * Env-админы сюда не попадают — их нельзя снять из интерфейса.
 */

import { JsonStore } from '../jsonStore.ts';

export interface PwaAdminRecord {
  userId: string;
  addedAt: string;
  /** userId того, кто назначил (для аудита). */
  addedBy?: string;
}

const store = new JsonStore<PwaAdminRecord>('pwa_admins.json');

export const pwaAdminsStore = {
  has(userId: string): boolean {
    return store.get(userId) !== undefined;
  },

  list(): PwaAdminRecord[] {
    return store
      .values()
      .slice()
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  },

  /** true — запись создана, false — уже был админом. */
  add(userId: string, addedBy?: string): boolean {
    if (store.get(userId)) return false;

    store.set(userId, {
      userId,
      addedAt: new Date().toISOString(),
      addedBy,
    });
    return true;
  },

  remove(userId: string): boolean {
    return store.delete(userId) !== undefined;
  },

  /** Убирает запись при удалении пользователя. */
  forget(userId: string): void {
    store.delete(userId);
  },
};
