/**
 * /api/mail — непрочитанные письма корпоративной почты ОСЭП (источник — OWA).
 *
 * Почту штатно обновляет фоновый нотификатор (раз в 20 минут, тот же цикл, что
 * и пуши), а маршрут отдаёт готовое превью из `mailPreviewCache`. Если превью
 * ещё нет (свежий процесс, первый заход до круга нотификатора) — маршрут сам
 * один раз забирает список через `OwaMailClient` и кэширует его, чтобы блок
 * почты не был пустым.
 *
 * IMAP (:993) не используется: его режет Forefront TMG. Источник — веб-интерфейс
 * `https://mail.mpei.ru/owa` (см. `owaMailClient.ts`).
 *
 * Контракт ответа (`MailResponse`) не менялся: `{ total, unseen, messages }`.
 * Изменился только код отказа: 409 `mail_reauth_required` вместо 401. PWA-токен
 * здесь валиден, поэтому 401 означал бы «разлогиньте всё приложение» и рано или
 * поздно сработал бы в общем обработчике. Тело содержит подтип причины, чтобы
 * клиент не показывал «проверьте пароль» при сломанной форме или 2FA.
 */

import type { FastifyInstance } from 'fastify';

import { MAIL_PREVIEW_LIMIT } from '../../services/bars/barsSnapshotCache.ts';
import {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
} from '../../services/mail/mailErrors.ts';
import { peekMailPreview, putMailPreview } from '../../services/mail/mailPreviewCache.ts';
import { forgetOwaClient, withOwaClient } from '../../services/mail/owaClientRegistry.ts';
import { type StoredUser, userStore } from '../../../db/storage/userStore.ts';
import { requireBars } from '../middleware/auth.ts';

export async function registerMailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mail', async (request, reply) => {
    const student = requireBars(request);

    try {
      const preview = peekMailPreview(student.userId) ?? (await loadPreview(student));

      if (!preview) {
        // Данных ещё нет и нотификатор не успел — отдаём пустой список, не ошибку.
        return reply.send({ total: 0, unseen: 0, messages: [] });
      }

      return reply.send({
        total: preview.total,
        unseen: preview.unseen,
        messages: preview.messages,
      });
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
 * Одноразовый заход в OWA, если превью ещё нет. Бросает типизированные ошибки
 * (`MailUnreachableError`/`MailAuthError`/`MailTimeoutError`) — маршрут их ловит.
 *
 * Клиент берётся из реестра на пользователя, поэтому параллельный круг
 * нотификатора не перезапишет cookies отдельного jar'а.
 */
async function loadPreview(student: StoredUser) {
  await withOwaClient(student, async (mail) => {
    const status = await mail.getInboxStatus();
    const briefs = await mail.fetchMessageBriefs({ limit: MAIL_PREVIEW_LIMIT, onlyUnread: true });

    // Сессия могла быть поднята заново — сохраняем cookies для следующих вызовов.
    userStore.setOwaAuth(student.userId, mail.serializeCookies());

    putMailPreview(student.userId, {
      total: status.total,
      unseen: status.unread,
      messages: briefs.map((b) => ({
        uid: b.uid,
        from: b.from,
        subject: b.subject,
        date: b.date.toISOString(),
        isSeen: b.isSeen,
        hasAttachments: b.hasAttachments,
      })),
    });
  });

  return peekMailPreview(student.userId);
}
