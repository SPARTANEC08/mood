/**
 * Рассылка из админки PWA.
 *
 * Каналы на пользователя:
 *   - лента/модалка в приложении (announcementStore);
 *   - Web Push (если есть подписка и push не выключен).
 *
 * «Всем» — все не гостевые аккаунты. Личная рассылка адресуется одному
 * пользователю: объявление в ленте помечается targetUserId и видно только ему.
 *
 * Задача идёт в фоне: HTTP отвечает jobId, клиент опрашивает прогресс.
 */

import type { StoredUser } from '../../../db/storage/userStore.ts';
import { userStore } from '../../../db/storage/userStore.ts';
import { announcementStore } from '../../../db/storage/announcementStore.ts';
import { adminAuditStore } from '../../../db/storage/adminAuditStore.ts';
import { sendBroadcastPush } from '../notifications/webPush.ts';
import { adminName } from '../../utils/adminAuth.ts';
import { bumpJob, createJob, finishJob, runningJob, type AdminJob } from './jobs.ts';

export interface BroadcastInput {
  text: string;
  url?: string;
  /** Личная рассылка: только этому пользователю. */
  targetUserId?: string;
  /** Каналы доставки. По умолчанию лента + push. */
  channels?: { feed: boolean; push: boolean };
  admin: StoredUser;
}

/**
 * Запускает рассылку. Возвращает job или null, если уже идёт другая.
 */
export function startBroadcast(input: BroadcastInput): AdminJob | null {
  if (runningJob('broadcast')) return null;

  const recipients = resolveRecipients(input.targetUserId);
  const job = createJob('broadcast', recipients.length);

  void runBroadcast(job, input, recipients);
  return job;
}

function resolveRecipients(targetUserId?: string): StoredUser[] {
  if (targetUserId) {
    const user = userStore.getByUserId(targetUserId);
    return user ? [user] : [];
  }

  return userStore.all().filter((user) => user.isGuest !== true);
}

async function runBroadcast(
  job: AdminJob,
  input: BroadcastInput,
  recipients: StoredUser[],
): Promise<void> {
  const text = input.text.trim();
  const channels = input.channels ?? { feed: true, push: true };

  try {
    // Лента одна на всех (или адресная). Для push-only пишем скрытую запись,
    // чтобы сообщение осталось в истории админки.
    if (channels.feed) {
      announcementStore.create(text, input.admin.userId, input.targetUserId, {
        feed: true,
        url: input.url,
        channels,
      });
      bumpJob(job.id, { progress: { feed: 1 } });
    } else {
      announcementStore.create(text, input.admin.userId, input.targetUserId, {
        feed: false,
        url: input.url,
        channels,
      });
    }

    let done = 0;

    if (channels.push) {
      for (const user of recipients) {
        if (user.pushEnabled !== false && (user.pushSubscriptions?.length ?? 0) > 0) {
          try {
            const delivered = await sendBroadcastPush(user, text, input.url);
            bumpJob(job.id, { progress: delivered ? { push: 1 } : { failed: 1 } });
          } catch {
            bumpJob(job.id, { progress: { failed: 1 } });
          }
        } else {
          bumpJob(job.id, { progress: { skippedPush: 1 } });
        }

        done += 1;
        bumpJob(job.id, { done });
      }
    } else {
      done = recipients.length;
      bumpJob(job.id, { done });
    }

    finishJob(job.id);

    adminAuditStore.record({
      adminUserId: input.admin.userId,
      adminName: adminName(input.admin),
      action: input.targetUserId ? 'message_personal' : 'message_all',
      target: input.targetUserId ?? 'все',
      details: `получателей: ${recipients.length}, каналы: ${[
        channels.feed ? 'лента' : '',
        channels.push ? 'push' : '',
      ].filter(Boolean).join('+')}, текст: ${text.slice(0, 80)}`,
    });
  } catch (err: unknown) {
    finishJob(job.id, err instanceof Error ? err.message : String(err));
  }
}
