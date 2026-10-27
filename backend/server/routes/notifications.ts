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

/** Тело запроса: флаг и необязательный канал. */
function readToggle(body: unknown): { channel: 'telegram' | 'push'; enabled: boolean } | null {
  if (!body || typeof body !== 'object') return null;

  const { enabled, channel } = body as { enabled?: unknown; channel?: unknown };
  if (typeof enabled !== 'boolean') return null;

  return { channel: channel === 'push' ? 'push' : 'telegram', enabled };
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/notifications/toggle — включить или выключить канал уведомлений.
   *
   * Идемпотентно: повторный вызов с тем же значением даёт тот же ответ и не
   * меняет ничего. Отдельного ответа «а не подключено» здесь нет намеренно —
   * флаг честно запоминается, и включение без привязки Telegram просто не
   * приведёт к уведомлениям, пока человек не привяжет аккаунт в боте.
   *
   * `channel` необязателен: старый клиент присылает только `enabled` и
   * продолжает управлять Telegram. Push — независимый флаг.
   */
  app.post('/api/notifications/toggle', async (request, reply) => {
    const user = requireUser(request);
    const toggle = readToggle(request.body);

    if (!toggle) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Передайте { enabled: true } или { enabled: false }.',
      });
    }

    userStore.patchByUserId(
      user.userId,
      toggle.channel === 'push'
        ? { pushEnabled: toggle.enabled }
        : { notificationsEnabled: toggle.enabled },
    );

    const updated = userStore.getByUserId(user.userId);

    return reply.send({
      ok: true,
      channel: toggle.channel,
      enabled: toggle.enabled,
      telegramId: user.telegramId ?? null,
      pushEnabled: updated?.pushEnabled !== false,
      pushDevices: updated?.pushSubscriptions?.length ?? 0,
    });
  });

  /**
   * GET /api/notifications/state — текущее состояние подписок.
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
      pushEnabled: user.pushEnabled !== false,
      pushDevices: user.pushSubscriptions?.length ?? 0,
    });
  });
}