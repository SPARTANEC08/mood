import { JsonStore } from '../utils/jsonStore.ts';
import { TelegramFileRef } from './homeworkStore.ts';

export interface ImportantMessage {
  id: string;
  groupName: string;
  title: string;
  text: string;
  files: TelegramFileRef[];
  authorName?: string;
  authorId?: number;
  createdAt: string;
  channelMessageIds?: number[];
}

const store = new JsonStore<ImportantMessage>('important.json');

export const importantStore = {
  get(id: string): ImportantMessage | undefined {
    return store.get(id);
  },

  /** Новые сверху */
  getForGroup(groupName: string): ImportantMessage[] {
    const g = groupName.trim().toLowerCase();
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

  setChannelMessages(id: string, channelMessageIds: number[], files: TelegramFileRef[]): void {
    const rec = store.get(id);
    if (!rec) return;
    store.set(id, { ...rec, channelMessageIds, files });
  },
};
