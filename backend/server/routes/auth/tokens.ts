/**
 * Выдача и отзыв PWA-токена.
 *
 * Токен — единственный способ авторизовать запросы приложения (заголовок
 * X-PWA-Token). Здесь только его жизненный цикл: выпуск при успешном входе,
 * отзыв ровно текущего токена при выходе и выпуск нового при истечении. Формат
 * самого токена — в utils/pwaAuth.ts и не меняется.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { userStore, type StoredUser } from '../../../../db/storage/userStore.ts';
import { hashToken, issuePwaToken } from '../../../utils/pwaAuth.ts';
import { requireUser } from '../../middleware/auth.ts';
import type { PwaTokenResponse } from '../../types.ts';
import { buildProfile } from './helpers.ts';

/** Выдаёт токен и кладёт его хэш в запись пользователя. */
export function issueToken(user: StoredUser): PwaTokenResponse {
  userStore.pruneTokens(user.userId);

  const issued = issuePwaToken(user.userId);
  userStore.addToken(user.userId, hashToken(issued.token), new Date(issued.expiresAt));

  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    userId: user.userId,
    profile: buildProfile(user),
  };
}

/** Токен из заголовка запроса — нужен для отзыва конкретного токена. */
export function requestToken(request: FastifyRequest): string {
  const raw = request.headers['x-pwa-token'];
  return (typeof raw === 'string' ? raw : '').replace(/^(Bearer|Token)\s+/i, '').trim();
}

export function registerTokenRoutes(app: FastifyInstance): void {
  /**
   * POST /api/auth/logout — отзыв текущего токена.
   *
   * Отзывается ровно один токен, а не все: человек может быть подписан на
   * двух устройствах, и выход на телефоне не должен выкидывать его с планшета.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    const user = requireUser(request);
    const token = requestToken(request);

    if (token) userStore.revokeToken(user.userId, hashToken(token));

    return reply.send({ ok: true });
  });

  /**
   * POST /api/auth/refresh — выдача нового токена вместо истёкшего.
   *
   * Токен выпускается заново, а не продлевается подписью: иначе отозванный
   * токен снова стал бы рабочим, потому что refresh не знает, что его уже
   * отозвали. Старый хэш удаляется, новый кладётся.
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    const user = requireUser(request);
    const token = requestToken(request);

    if (token) userStore.revokeToken(user.userId, hashToken(token));

    return reply.send(issueToken(user));
  });
}
