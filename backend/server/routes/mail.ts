/**
 * /api/mail — статус корпоративной почты ОСЭП (источник — OWA).
 *
 * Приложение не читает письма: ни темы, ни отправителя, ни тело. Маршрут отдаёт
 * только `{ total, unseen }` — сколько всего и сколько непрочитанных. Этого
 * достаточно для строки «Почта» в «Кабинете».
 *
 * Почту штатно обновляет фоновый нотификатор (раз в 20 минут, тот же цикл, что
 * и пуши), а маршрут отдаёт готовый статус из `mailStatusCache`. Если статуса
 * ещё нет (свежий процесс, первый заход до круга нотификатора) — маршрут сам
 * один раз забирает счётчики и минимальные ID писем.
 *
 * IMAP (:993) не используется: его режет Forefront TMG. Источник — веб-интерфейс
 * `https://mail.mpei.ru/owa` (см. `owaMailClient.ts`).
 *
 * Ошибка входа в OWA — 409 `mail_reauth_required` (не 401): PWA-токен здесь
 * валиден, и 401 разлогинил бы всё приложение. В теле — подтип причины, чтобы
 * клиент не показывал «проверьте пароль» при сломанной форме или 2FA.
 */

import type { FastifyInstance } from 'fastify';

import {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
} from '../../services/mail/mailErrors.ts';
import {
  MAIL_CHECK_LIMIT,
  peekMailStatus,
  putMailStatus,
} from '../../services/mail/mailStatusCache.ts';
import { forgetOwaClient, withOwaClient } from '../../services/mail/owaClientRegistry.ts';
import { type StoredUser, userStore } from '../../../db/storage/userStore.ts';
import { requireBars } from '../middleware/auth.ts';

export async function registerMailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mail', async (request, reply) => {
    const student = requireBars(request);

    try {
      const status = peekMailStatus(student.userId) ?? (await loadStatus(student));

      if (!status) {
        // Данных ещё нет и нотификатор не успел — отдаём нули, не ошибку.
        return reply.send({ total: 0, unseen: 0 });
      }

      return reply.send({ total: status.total, unseen: status.unseen });
    } catch (err: unknown) {
      if (err instanceof MailUnreachableError) {
        return reply.code(503).send({ error: 'mail_unreachable', message: err.message });
      }
      if (err instanceof MailAuthError) {
        // Сессия OWA недействительна: забываем её и клиента, БАРС не трогаем.
        userStore.clearOwaAuth(student.userId);
        forgetOwaClient(student.userId);
        return reply.code(409).send({
          error: 'mail_reauth_required',
          reason: err.reason,
          message: MAIL_AUTH_MESSAGES[err.reason],
        });
      }
      if (err instanceof MailTimeoutError) {
        return reply.code(504).send({ error: 'mail_timeout', message: err.message });
      }
      throw err;
    }
  });
}

/**
 * Одноразовый заход в OWA, если статуса ещё нет. Бросает типизированные ошибки
 * (`MailUnreachableError`/`MailAuthError`/`MailTimeoutError`) — маршрут их ловит.
 *
 * Клиент берётся из реестра на пользователя, поэтому параллельный круг
 * нотификатора не перезапишет cookies отдельного jar'а.
 */
async function loadStatus(student: StoredUser) {
  await withOwaClient(student, async (mail) => {
    // Счётчики + минимальные ID (только дата получения). Содержимое не читаем.
    const [status, ids] = await Promise.all([
      mail.getInboxStatus(),
      mail.fetchMessageIds({ limit: MAIL_CHECK_LIMIT }),
    ]);

    // Сессия могла быть поднята заново — сохраняем cookies для следующих вызовов.
    userStore.setOwaAuth(student.userId, mail.serializeCookies());

    putMailStatus(student.userId, {
      total: status.total,
      unseen: status.unread,
      lastUid: ids.reduce((max, message) => Math.max(max, message.uid), 0),
    });
  });

  return peekMailStatus(student.userId);
}
