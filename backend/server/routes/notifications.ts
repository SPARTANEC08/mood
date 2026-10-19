/**
 * Включение и выключение уведомлений в Telegram.
 *
 * Зачем это в PWA, если у бота есть кнопка «Выключить уведомления». Дело в
 * симметрии: выключить можно было из двух мест, а включить обратно — только
 * из бота, и человек, который его закрыл, оказывался в тупике. Теперь
 * состояние подписки видно и меняется прямо в «Кабинете».
 *
 * Авторизация здесь requireUser, а не requireBars, и это осознанно. Подписка на
 * уведомления не зависит от личного кабинета: сессия БАРС может истечь (или её
 * может не быть никогда, если человек только что вошёл), а кнопка «Выключить»
 * должна работать всегда. Креды БАРС нужны нотификатору для сбора данных, но
 * не этому маршруту — он меняет одно поле в своей же записи.
 */

import type { FastifyInstance } from 'fastify';

import { userStore } from '../../../db/storage/userStore.ts';
import { requireUser } from '../middleware/auth.ts';

/** Тело запроса: один флаг. Всё остальное игнорируется. */
function readEnabled(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;

  const value = (body as { enabled?: unknown }).enabled;

  return typeof value === 'boolean' ? value : null;
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/notifications/toggle — включить или выключить уведомления.
   *
   * Идемпотентно: повторный вызов с тем же значением даёт тот же ответ и не
   * меняет ничего. Отдельного ответа «а не подключено» здесь нет намеренно —
   * флаг честно запоминается, и включение без привязки Telegram просто не
   * приведёт к уведомлениям, пока человек не привяжет аккаунт в боте.
   */
  app.post('/api/notifications/toggle', async (request, reply) => {
    const user = requireUser(request);
    const enabled = readEnabled(request.body);

    if (enabled === null) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Передайте { enabled: true } или { enabled: false }.',
      });
    }

    userStore.patchByUserId(user.userId, { notificationsEnabled: enabled });

    return reply.send({ ok: true, enabled, telegramId: user.telegramId ?? null });
  });

  /**
   * GET /api/notifications/state — текущее состояние подписки.
   *
   * Отдельный маршрут не обязателен: состояние есть в bootstrap. Оставлен
   * потому, что «Кабинет» перечитывает его при возврате на вкладку, и ходить
   * ради одного поля за полным bootstrap было бы расточительно — тот ходит в
   * БАРС.
   */
  app.get('/api/notifications/state', async (request, reply) => {
    const user = requireUser(request);

    return reply.send({
      telegramId: user.telegramId ?? null,
      notificationsEnabled: user.notificationsEnabled !== false,
    });
  });
}