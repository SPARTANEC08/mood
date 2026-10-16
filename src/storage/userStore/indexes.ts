/**
 * Индексы users.json и ключевые помощники.
 *
 * Индексы (byTelegramId, byBarsLoginHash) — производные данные от записей, и
 * единственный надёжный способ не дать им разъехаться — пересобирать из записей
 * (reindex), а не поддерживать вручную. Здесь же живёт разрешение ключа
 * (Telegram ID ↔ userId) и текущее время записи.
 *
 * Модуль не знает про файл и запись на диск — только про форму документа.
 */

import type { StoredUser } from '../userStore.ts';

/**
 * Файл users.json целиком.
 *
 * Индексы лежат рядом с записями в одном файле, а не «строятся при чтении»:
 * поиск по telegramId идёт на каждом сообщении бота, а перебор всех записей
 * ради одного пользователя — лишняя работа в самом горячем пути.
 */
export interface UsersDocument {
  users: Record<string, StoredUser>;
  index: {
    byTelegramId: Record<string, string>;
    byBarsLoginHash: Record<string, string>;
  };
}

export function emptyDocument(): UsersDocument {
  return { users: {}, index: { byTelegramId: {}, byBarsLoginHash: {} } };
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Пересобирает индекс по записям.
 *
 * Нужен после любой операции, меняющей ключи. Индексы — производные данные,
 * поэтому единственный надёжный способ не разъехаться с записями — построить
 * их заново, а не поддерживать вручную в каждом месте: любое забытое место
 * потом стоило бы часов отладки «почему пользователь не находится».
 */
export function reindex(doc: UsersDocument): void {
  const byTelegramId: Record<string, string> = {};
  const byBarsLoginHash: Record<string, string> = {};

  for (const user of Object.values(doc.users)) {
    // typeof, а не проверка на null: null означает «отвязан», и такая запись
    // обязана выпасть из индекса, иначе findUserByTelegramId вернул бы её и
    // бот считал бы, что уведомления подключены.
    if (typeof user.telegramId === 'number') byTelegramId[String(user.telegramId)] = user.userId;
    if (user.barsLoginHash) byBarsLoginHash[user.barsLoginHash] = user.userId;
  }

  doc.index = { byTelegramId, byBarsLoginHash };
}

/**
 * Приводит ключ записи к userId.
 *
 * Методы принимают и Telegram ID, и userId: бот знает только Telegram ID, а
 * PWA — только userId, и заставлять каждого перестраивать свой вызов было бы
 * ценой без пользы. Внутри это одно и то же: Telegram ID разрешается через
 * индекс в тот же userId.
 */
export function resolveUserId(doc: UsersDocument, key: number | string): string | undefined {
  if (typeof key === 'number') return doc.index.byTelegramId[String(key)];
  return doc.users[key] ? key : doc.index.byBarsLoginHash[key];
}
