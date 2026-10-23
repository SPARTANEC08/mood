/**
 * Уведомления внутри PWA.
 *
 * Маршруты под обычной авторизацией PWA и требуют входа в БАРС: объявления
 * показываются только реальным студентам. Ответ маленький, поэтому опрашивать
 * его раз в 30 секунд дёшево — файл читается из памяти процесса.
 */

import type { FastifyInstance } from 'fastify';

import { announcementStore } from '../../../db/storage/announcementStore.ts';
import { userEventStore } from '../../../db/storage/userEventStore.ts';
import { requireBars } from '../middleware/auth.ts';

export function registerAnnouncementRoutes(app: FastifyInstance): void {
  /** Следующее непрочитанное объявление (или null). Старый контракт. */
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

  /**
   * Следующее уведомление для приложения: сначала рассылка админа, затем
   * события (оценки/письмо/приказ/стипендия) с деталями.
   */
  app.get('/api/notifications/next', async (request, reply) => {
    const student = requireBars(request);

    const broadcast = announcementStore.nextFor(student.userId);
    if (broadcast) {
      return reply.send({
        item: {
          kind: 'broadcast',
          id: broadcast.id,
          text: broadcast.text,
          createdAt: broadcast.createdAt,
        },
      });
    }

    const event = userEventStore.nextFor(student.userId);
    return reply.send({
      item: event
        ? {
            kind: event.kind,
            id: event.id,
            label: event.label,
            details: event.details,
            createdAt: event.createdAt,
          }
        : null,
    });
  });

  /** «Закрыть»: рассылка откладывается, событие помечается прочитанным. */
  app.post('/api/notifications/:id/read', async (request, reply) => {
    const student = requireBars(request);
    const { id } = request.params as { id: string };

    const eventRead = userEventStore.markRead(student.userId, id);
    if (!eventRead) announcementStore.dismiss(student.userId, id);

    return reply.send({ ok: true });
  });
}
