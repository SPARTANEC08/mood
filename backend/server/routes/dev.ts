/**
 * Личная статистика владельца — источник данных для страницы /dev/.
 *
 * Маршрут вне префикса `/api`: глобальный `authHook` навешен только на `/api`,
 * поэтому существующая логика доступа не меняется. Доступ закрыт собственным
 * токеном (`DEV_STATS_TOKEN`), сравнение — без утечки по времени.
 *
 * Один запрос отдаёт всю страницу — окно всегда 24 часа. Ответ кэшируется на
 * 30 секунд, чтобы частые F5 не пересчитывали агрегаты.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getStats, isDevStatsEnabled, isDevTokenValid } from '../devStats.ts';

/** Время жизни кэша ответа. */
const CACHE_MS = 30_000;

let cache: { at: number; key: string; data: unknown } | null = null;

function extractToken(request: FastifyRequest): string {
  const header = request.headers['x-dev-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const query = request.query as Record<string, unknown> | undefined;
  const key = query?.key;
  return typeof key === 'string' ? key.trim() : '';
}

export async function registerDevRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dev-api/stats', async (request, reply) => {
    if (!isDevStatsEnabled()) {
      return reply.code(404).send({ error: 'dev_stats_disabled' });
    }

    if (!isDevTokenValid(extractToken(request))) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Нужен токен доступа к /dev.' });
    }

    const key = 'window';

    reply.header('Cache-Control', 'no-store');

    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_MS) {
      return reply.send(cache.data);
    }

    const data = getStats();
    cache = { at: now, key, data };
    return reply.send(data);
  });
}
