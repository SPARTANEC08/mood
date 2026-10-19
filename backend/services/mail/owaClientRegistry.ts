/**
 * Один OWA-клиент на пользователя.
 *
 * Зачем реестр. До него `/api/mail` и фоновый нотификатор создавали отдельный
 * `OwaMailClient` на каждый вызов. У каждого был свой cookie jar, и оба
 * сохраняли cookies в одну запись `StoredUser.owaAuth`. Если OWA держит одну
 * активную сессию (или ротирует canary при каждом входе), клиенты выбивали друг
 * друга: один логинился, второй перезаписывал cookies, первый получал 401 и
 * логинился снова. Снаружи это выглядело как «постоянно не удалось войти».
 *
 * Теперь клиент живёт в памяти по `userId`, а доступ к нему сериализован:
 * параллельные запросы (вкладка профиля + круг нотификатора) используют один
 * jar и не логинятся одновременно.
 *
 * TTL и потолок — как у клиентов БАРС (`barsServiceFactory`): без них реестр
 * превратился бы в утечку памяти на долгоживущем процессе.
 */

import { readOwaCredentials } from '../bars/barsServiceFactory.ts';
import type { StoredUser } from '../../../db/storage/userStore.ts';
import { OwaMailClient } from './owaMailClient.ts';

/** Клиент бездействует дольше этого — вытесняется. */
const OWA_CLIENT_TTL_MS = 30 * 60 * 1000;

/** Больше этого клиентов одновременно держать нельзя. */
const OWA_CLIENT_LIMIT = 60;

interface CachedOwaClient {
  client: OwaMailClient;
  usedAt: number;
  /**
   * Отпечаток учётных данных. Меняется при повторном входе в БАРС (новый
   * `savedAt`) — старый клиент с прежним паролем после этого не годится.
   */
  stamp: string;
}

const clients = new Map<string, CachedOwaClient>();

/**
 * Хвосты очередей по userId: новый вызов ждёт завершения предыдущего.
 * Значение — промис, который никогда не reject'ится, иначе цепочка ломалась бы.
 */
const tails = new Map<string, Promise<unknown>>();

function credentialsStamp(user: StoredUser): string {
  return `${user.barsAuth?.savedAt ?? ''}`;
}

/** Вытесняет давно неиспользованные и лишние сверх потолка клиенты. */
function evict(now: number): void {
  for (const [userId, entry] of clients) {
    if (now - entry.usedAt > OWA_CLIENT_TTL_MS) clients.delete(userId);
  }

  while (clients.size >= OWA_CLIENT_LIMIT) {
    const oldest = clients.keys().next();
    if (oldest.done) break;
    clients.delete(oldest.value);
  }
}

/** Берёт клиента из реестра или создаёт нового с сохранёнными cookies. */
function acquire(user: StoredUser): OwaMailClient {
  const now = Date.now();
  const stamp = credentialsStamp(user);
  const cached = clients.get(user.userId);

  if (cached && cached.stamp === stamp) {
    cached.usedAt = now;
    // Переставляем в конец: Map обходит ключи в порядке вставки.
    clients.delete(user.userId);
    clients.set(user.userId, cached);
    return cached.client;
  }

  evict(now);

  const { login, password } = readOwaCredentials(user);
  const client = new OwaMailClient(
    { user: login, pass: password },
    { cookiesJson: user.owaAuth?.cookiesJson },
  );

  clients.set(user.userId, { client, usedAt: now, stamp });
  return client;
}

/**
 * Выполняет операцию с OWA под мьютексом пользователя.
 *
 * Именно `withOwaClient`, а не «дай клиента»: если бы вызывающий код держал
 * ссылку между await, мьютекс можно было бы обойти. Здесь весь сетевой заход
 * (вход, GetFolder, FindItem) идёт внутри одной очереди.
 */
export async function withOwaClient<T>(
  user: StoredUser,
  run: (client: OwaMailClient) => Promise<T>,
): Promise<T> {
  const previous = tails.get(user.userId) ?? Promise.resolve();

  const current = previous.then(async () => run(acquire(user)));
  // Хвост не должен нести ошибку: иначе следующий вызов унаследует reject.
  const tail = current.catch(() => undefined);
  tails.set(user.userId, tail);

  try {
    return await current;
  } finally {
    if (tails.get(user.userId) === tail) tails.delete(user.userId);
  }
}

/**
 * Забывает клиента: после `clearOwaAuth`, смены пароля или ошибки входа.
 * Без этого следующий запрос переиспользовал бы jar с недействительной сессией.
 */
export function forgetOwaClient(userId: string): void {
  clients.delete(userId);
}

/** Сколько клиентов сейчас в памяти. Только для тестов и диагностики. */
export function owaClientCacheStats(): { clients: number; queues: number } {
  return { clients: clients.size, queues: tails.size };
}
