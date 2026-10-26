/**
 * Удаление аккаунта из приложения.
 *
 * Отдельный маршрут, а не DELETE /api/auth/me: подтверждение приходит телом,
 * и случайный запрос без строки «УДАЛИТЬ» не должен стирать данные. Требуется
 * только действующий PWA-токен, а не сессия БАРС: человек вправе удалить
 * аккаунт, даже если личный кабинет давно истёк.
 */

import type { FastifyInstance } from 'fastify';

import { deleteAccount } from '../../services/account/deleteAccount.ts';
import { requireUser } from '../middleware/auth.ts';

const CONFIRMATION = 'УДАЛИТЬ';

function confirmed(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;

  const value = (body as { confirmation?: unknown }).confirmation;
  // Регистр важен: подтверждение должно быть набрано ровно так, как показано
  // в интерфейсе. Иначе «удалить» проскочило бы незаметно для человека.
  return typeof value === 'string' && value.trim() === CONFIRMATION;
}

export function registerAccountRoutes(app: FastifyInstance): void {
  app.post('/api/account/delete', async (request, reply) => {
    const user = requireUser(request);

    if (!confirmed(request.body)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Введите «${CONFIRMATION}», чтобы подтвердить удаление аккаунта.`,
      });
    }

    await deleteAccount(user);
    console.log('[Account] аккаунт удалён');

    return reply.send({ ok: true });
  });
}
