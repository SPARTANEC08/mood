/**
 * Уведомления внутри приложения (PWA).
 *
 * Админ отправляет текст из бота, а приложение показывает его модальным окном
 * всем, кто авторизован в БАРС. Объявления живут очередью: новое не затирает
 * предыдущее, а встаёт в конец.
 *
 * Закрытие запоминается по пользователю (`dismissed[userId]`), поэтому после
 * «Закрыть» объявление больше не всплывает на этом аккаунте. Сами объявления
 * удаляются только когда их накопится больше MAX_ITEMS — тогда же чистим и
 * отметки, чтобы файл не рос.
 *
 * Хранилище — JsonDocument: запись атомарная, права 0600, как у остальных
 * данных приложения.
 */

import { randomUUID } from 'node:crypto';

import { JsonDocument } from '../jsonStore.ts';

export interface AppAnnouncement {
  id: string;
  text: string;
  createdAt: string;
  /** Telegram ID админа, отправившего объявление (для разбора инцидентов). */
  createdBy?: number;
}

interface AnnouncementsDocument {
  items: AppAnnouncement[];
  /** userId → id объявлений, которые этот пользователь уже закрыл. */
  dismissed: Record<string, string[]>;
}

/** Сколько объявлений держим; старые уходят вместе со своими отметками. */
const MAX_ITEMS = 100;

const document = new JsonDocument<AnnouncementsDocument>('announcements.json');

function read(): AnnouncementsDocument {
  const doc = document.read();
  if (!doc || typeof doc !== 'object') return { items: [], dismissed: {} };

  doc.items ??= [];
  doc.dismissed ??= {};
  return doc;
}

function commit(doc: AnnouncementsDocument): void {
  document.stage(doc);
  document.save();
}

export const announcementStore = {
  /** Ставит объявление в очередь. */
  create(text: string, createdBy?: number): AppAnnouncement {
    const doc = read();
    const item: AppAnnouncement = {
      id: randomUUID(),
      text: text.trim(),
      createdAt: new Date().toISOString(),
      createdBy,
    };

    doc.items.push(item);

    while (doc.items.length > MAX_ITEMS) {
      const removed = doc.items.shift();
      if (!removed) break;
      for (const ids of Object.values(doc.dismissed)) {
        const index = ids.indexOf(removed.id);
        if (index >= 0) ids.splice(index, 1);
      }
    }

    commit(doc);
    return item;
  },

  /** Первое непрочитанное объявление пользователя или null. */
  nextFor(userId: string): AppAnnouncement | null {
    const doc = read();
    const dismissed = new Set(doc.dismissed[userId] ?? []);
    return doc.items.find((item) => !dismissed.has(item.id)) ?? null;
  },

  /**
   * Все объявления с признаком прочтения для конкретного пользователя.
   *
   * Новые сверху. «Прочитано» здесь означает «закрыто этим пользователем»:
   * отдельного поля в хранилище нет, отметки живут в `dismissed`.
   */
  listForUser(userId: string): Array<AppAnnouncement & { read: boolean }> {
    const doc = read();
    const dismissed = new Set(doc.dismissed[userId] ?? []);

    return [...doc.items]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({ ...item, read: dismissed.has(item.id) }));
  },

  /** Сколько объявлений пользователь ещё не закрывал. */
  unreadCount(userId: string): number {
    const doc = read();
    const dismissed = new Set(doc.dismissed[userId] ?? []);
    return doc.items.reduce((count, item) => count + (dismissed.has(item.id) ? 0 : 1), 0);
  },

  /** Закрывает все текущие объявления пользователя. */
  dismissAll(userId: string): number {
    const doc = read();
    const dismissed = new Set(doc.dismissed[userId] ?? []);
    let added = 0;

    for (const item of doc.items) {
      if (dismissed.has(item.id)) continue;
      dismissed.add(item.id);
      added += 1;
    }

    if (added === 0) return 0;

    doc.dismissed[userId] = [...dismissed];
    commit(doc);
    return added;
  },

  /** Убирает отметки пользователя о закрытых объявлениях. */
  forgetUser(userId: string): void {
    const doc = read();
    if (!(userId in doc.dismissed)) return;
    delete doc.dismissed[userId];
    commit(doc);
  },

  /** Удаляет объявления, созданные указанным Telegram-аккаунтом. */
  removeByCreator(telegramId: number): number {
    const doc = read();
    const removed = new Set<string>();

    doc.items = doc.items.filter((item) => {
      if (item.createdBy !== telegramId) return true;
      removed.add(item.id);
      return false;
    });

    if (removed.size === 0) return 0;

    for (const ids of Object.values(doc.dismissed)) {
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (removed.has(ids[index])) ids.splice(index, 1);
      }
    }

    commit(doc);
    return removed.size;
  },

  /** Отмечает объявление закрытым. false — такого объявления уже нет. */
  dismiss(userId: string, id: string): boolean {
    const doc = read();
    if (!doc.items.some((item) => item.id === id)) return false;

    const ids = new Set(doc.dismissed[userId] ?? []);
    ids.add(id);
    doc.dismissed[userId] = [...ids];
    commit(doc);
    return true;
  },

  all(): AppAnnouncement[] {
    return read().items;
  },

  /** Только для скриптов/тестов. */
  reset(): void {
    document.replace({ items: [], dismissed: {} });
  },
};
