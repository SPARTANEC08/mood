/**
 * Журнал действий администратора.
 *
 * Пишется только из админских маршрутов: кто, что и когда сделал. Нужен,
 * чтобы после «куда делся пользователь» и «кто разослал это» был ответ, а не
 * поиск по journald. Хранится последние 500 записей.
 */

import { randomUUID } from 'node:crypto';

import { JsonStore } from '../jsonStore.ts';

export interface AdminAuditEntry {
  id: string;
  at: string;
  adminUserId: string;
  adminName: string;
  /** Машинное имя действия: broadcast, user_delete, maintenance, … */
  action: string;
  /** Кого касается (userId, логин, «все»). */
  target?: string;
  /** Короткое описание для человека. */
  details?: string;
}

const store = new JsonStore<AdminAuditEntry>('admin_audit.json');

/** Сколько записей держим. */
const MAX_ENTRIES = 500;

export const adminAuditStore = {
  record(entry: Omit<AdminAuditEntry, 'id' | 'at'>): AdminAuditEntry {
    const record: AdminAuditEntry = {
      ...entry,
      id: randomUUID(),
      at: new Date().toISOString(),
    };

    store.set(record.id, record);
    trim();
    return record;
  },

  /** Новые сверху. */
  list(limit = 50): AdminAuditEntry[] {
    return store
      .values()
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, Math.max(1, limit));
  },
};

function trim(): void {
  const all = store.values().sort((a, b) => a.at.localeCompare(b.at));
  const extra = all.length - MAX_ENTRIES;
  if (extra <= 0) return;

  for (const entry of all.slice(0, extra)) {
    store.delete(entry.id);
  }
}
