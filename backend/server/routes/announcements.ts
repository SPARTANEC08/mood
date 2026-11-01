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
import type {
  AppNotificationItem,
  NotificationsFeedResponse,
} from '../types.ts';

/**
 * Объединяет две очереди в одну ленту.
 *
 * Объявления администратора и события нотификатора живут отдельно: первые —
 * общие для всех, вторые — персональные. В центре уведомлений человек должен
 * видеть единый список, поэтому слияние делается здесь, на чтении, а не
 * дублированием записей в двух хранилищах.
 */
function buildFeed(userId: string, since?: string): NotificationsFeedResponse {
  const events: AppNotificationItem[] = userEventStore.listForUser(userId, since).map((event) => ({
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt,
    read: event.readAt !== null && event.readAt !== undefined,
    label: event.label,
    details: event.details,
    data: event.data ?? undefined,
  }));

  const broadcasts: AppNotificationItem[] = announcementStore
    .listForUser(userId, since)
    .map((item) => ({
      id: item.id,
      kind: 'broadcast',
      createdAt: item.createdAt,
      read: item.read,
      label: 'Объявление',
      text: item.text,
    }));

  const items = [...events, ...broadcasts].sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt);
    return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
  });

  return {
    items,
    unread: items.reduce((count, item) => count + (item.read ? 0 : 1), 0),
  };
}

export function registerAnnouncementRoutes(app: FastifyInstance): void {
  /** Следующее непрочитанное объявление (или null). Старый контракт. */
  app.get('/api/announcements/next', async (request, reply) => {
    const student = requireBars(request);
    // Раньше регистрации объявлений не существовало — не показываем их.
    return reply.send({ item: announcementStore.nextFor(student.userId, student.createdAt) });
  });

  /** «Закрыть»: объявление больше не показывается этому пользователю. */
  app.post('/api/announcements/:id/dismiss', async (request, reply) => {
    const student = requireBars(request);
    const { id } = request.params as { id: string };

    announcementStore.dismiss(student.userId, id);
    return reply.send({ ok: true });
  });

  /**
   * Вся лента уведомлений: объявления админа и события, новые сверху.
   *
   * Список нужен центру уведомлений. Отдельный маршрут для «следующего»
   * остаётся ниже: на нём работает текущая модалка и старые установленные
   * версии приложения.
   */
  app.get('/api/notifications', async (request, reply) => {
    const student = requireBars(request);
    return reply.send(buildFeed(student.userId, student.createdAt));
  });

  /**
   * Только счётчики для бейджа на колокольчике.
   *
   * Лёгкий ответ, который приложение опрашивает раз в минуту: тянуть весь
   * список ради одной цифры незачем.
   */
  app.get('/api/notifications/unread-count', async (request, reply) => {
    const student = requireBars(request);
    const events = userEventStore.unreadCount(student.userId, student.createdAt);
    const broadcasts = announcementStore.unreadCount(student.userId, student.createdAt);

    return reply.send({
      unread: events + broadcasts,
      events,
      broadcasts,
    });
  });

  /** «Прочитать все»: события помечаются прочитанными, объявления закрываются. */
  app.post('/api/notifications/read-all', async (request, reply) => {
    const student = requireBars(request);

    userEventStore.markAllRead(student.userId, student.createdAt);
    announcementStore.dismissAll(student.userId, student.createdAt);

    return reply.send({ ok: true, unread: 0 });
  });

  /**
   * Следующее уведомление для приложения: сначала рассылка админа, затем
   * события (оценки/письмо/приказ/стипендия) с деталями.
   */
  app.get('/api/notifications/next', async (request, reply) => {
    const student = requireBars(request);

    const broadcast = announcementStore.nextFor(student.userId, student.createdAt);
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

    const event = userEventStore.nextFor(student.userId, student.createdAt);
    return reply.send({
      item: event
        ? {
            kind: event.kind,
            id: event.id,
            label: event.label,
            details: event.details,
            data: event.data ?? undefined,
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
