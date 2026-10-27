/**
 * Включение и выключение push-уведомлений.
 *
 * Telegram-канал удалён: уведомления живут в приложении. Флаг pushEnabled не
 * отменяет подписку браузера — только доставку, чтобы включение обратно не
 * требовало нового системного разрешения.
 *
 * Авторизация — requireUser, а не requireBars: подписка не зависит от сессии
 * БАРС и должна переключаться всегда.
 */

import type { FastifyInstance } from 'fastify';

import { userStore } from '../../../db/storage/userStore.ts';
import { requireUser } from '../middleware/auth.ts';

function readEnabled(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { enabled?: unknown }).enabled;
  return typeof value === 'boolean' ? value : null;
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/notifications/toggle', async (request, reply) => {
    const user = requireUser(request);
    const enabled = readEnabled(request.body);

    if (enabled === null) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Передайте { enabled: true } или { enabled: false }.',
      });
    }

    userStore.patchByUserId(user.userId, { pushEnabled: enabled });
    const updated = userStore.getByUserId(user.userId);

    return reply.send({
      ok: true,
      enabled,
      pushEnabled: updated?.pushEnabled !== false,
      pushDevices: updated?.pushSubscriptions?.length ?? 0,
    });
  });

  app.get('/api/notifications/state', async (request, reply) => {
    const user = requireUser(request);

    return reply.send({
      pushEnabled: user.pushEnabled !== false,
      pushDevices: user.pushSubscriptions?.length ?? 0,
    });
  });
}
