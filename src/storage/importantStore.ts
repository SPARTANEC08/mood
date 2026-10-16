import { JsonStore } from '../utils/jsonStore.ts';
import type { ServerFileRef } from './fileStore.ts';

export interface ImportantMessage {
  id: string;
  groupName: string;
  title: string;
  text: string;
  files: ServerFileRef[];
  authorName?: string;
  /** userId автора: идентификатор общий для бота и PWA. */
  authorId?: string;
  createdAt: string;
}

const store = new JsonStore<ImportantMessage>('important.json');

/**
 * Группа объявления приводится к тому же виду, что и в getForGroup().
 */
function sameGroup(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const importantStore = {
  get(id: string): ImportantMessage | undefined {
    return store.get(id);
  },

  /**
   * Объявление по ID, но только если оно принадлежит указанной группе.
   *
   * Единственная безопасная точка чтения для Telegram-обработчиков: глобальный
   * get(id) отдавал объявление любой группы по угаданному callback_data.
   * Пустая группа не имеет доступа ни к чему — иначе записи с незаполненным
   * groupName стали бы видны всем.
   */
  getForGroupAndId(groupName: string, id: string): ImportantMessage | undefined {
    if (!groupName.trim()) return undefined;
    const msg = store.get(id);
    return msg && sameGroup(msg.groupName, groupName) ? msg : undefined;
  },

  /** Удаление объявления, если оно принадлежит указанной группе. */
  deleteForGroupAndId(groupName: string, id: string): ImportantMessage | undefined {
    if (!this.getForGroupAndId(groupName, id)) return undefined;
    return store.delete(id);
  },

  /** Новые сверху. Пустая группа не видит ничего (см. getForGroupAndId). */
  getForGroup(groupName: string): ImportantMessage[] {
    const g = groupName.trim().toLowerCase();
    if (!g) return [];
    return store
      .values()
      .filter((m) => m.groupName.trim().toLowerCase() === g)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  /** Все объявления */
  all(): ImportantMessage[] {
    return store.values();
  },

  save(msg: ImportantMessage): void {
    store.set(msg.id, msg);
  },

  delete(id: string): ImportantMessage | undefined {
    return store.delete(id);
  },
};
