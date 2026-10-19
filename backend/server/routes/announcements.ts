/**
 * Уведомления внутри PWA.
 *
 * Маршруты под обычной авторизацией PWA и требуют входа в БАРС: объявления
 * показываются только реальным студентам. Ответ маленький, поэтому опрашивать
 * его раз в 30 секунд дёшево — файл читается из памяти процесса.
 */

import type { FastifyInstance } from 'fastify';

import { announcementStore } from '../../../db/storage/announcementStore.ts';
import { requireBars } from '../middleware/auth.ts';

export function registerAnnouncementRoutes(app: FastifyInstance): void {
  /** Следующее непрочитанное объявление (или null). */
  app.get('/api/announcements/next', async (request, reply) => {
    const student = requireBars(request);
    return reply.send({ item: announcementStore.nextFor(student.userId) });
  });

  /** «Закрыть»: объявление больше не показывается этому пользователю. */
  app.post('/api/announcements/:id/dismiss', async (request, reply) => {
    const student = requireBars(request);
    const { id } = request.params as { id: string };

    announcementStore.dismiss(student.userId, id);
    return reply.send({ ok: true });
  });
}
