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

  try {
    // Лента одна на всех (или адресная) — создаём до отправки, чтобы человек,
    // открывший приложение во время рассылки, уже видел объявление.
    announcementStore.create(text, input.admin.userId, input.targetUserId);
    bumpJob(job.id, { progress: { feed: 1 } });

    let done = 0;

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

    finishJob(job.id);

    adminAuditStore.record({
      adminUserId: input.admin.userId,
      adminName: adminName(input.admin),
      action: input.targetUserId ? 'broadcast_personal' : 'broadcast_all',
      target: input.targetUserId ?? 'все',
      details: `получателей: ${recipients.length}, текст: ${text.slice(0, 80)}`,
    });
  } catch (err: unknown) {
    finishJob(job.id, err instanceof Error ? err.message : String(err));
  }
}
