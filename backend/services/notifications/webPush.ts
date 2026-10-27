/**
 * Web Push (VAPID) — второй канал уведомлений, рядом с Telegram.
 *
 * Зачем свой канал, а не Firebase/OneSignal: приложение уже ставится как PWA,
 * браузеры поддерживают стандартный Web Push, а внешний сервис добавил бы
 * зависимость и увёл бы адреса устройств третьей стороне. Здесь подписки
 * лежат в записи пользователя, а payload шифруется ключами самого браузера.
 *
 * В push уходит ТОЛЬКО тип события: на экране блокировки не должно быть ни
 * оценок, ни тем писем. Конкретика живёт внутри приложения.
 */

import { createRequire } from 'node:module';

import type { PushSubscriptionRecord, StoredUser } from '../../../db/storage/userStore.ts';
import { userStore } from '../../../db/storage/userStore.ts';
import type { NotificationEvent } from './notifier/diff.ts';

/*
 * web-push — CommonJS-пакет без статически видимых named-экспортов. В ESM
 * `import { sendNotification }` падает на этапе связывания модуля, поэтому
 * берём его через createRequire: в собранном dist это обычный require.
 */
const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof import('web-push');

/** Сколько устройств одного человека храним. Старые вытесняются новыми. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** Сколько push-сервис может держать уведомление, если устройство офлайн. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Куда ведёт тап по уведомлению.
 *
 * Ссылки относительные и открывают приложение на нужной вкладке: маршрутизации
 * в приложении нет, вкладка выбирается по `?tab=` при старте (см. ScheduleApp).
 */
const PUSH_URLS: Record<NotificationEvent['kind'], string> = {
  grade: '/?tab=grades',
  mail: '/?tab=profile',
  order: '/?tab=profile',
  scholarship: '/?tab=profile',
};

let configured: boolean | null = null;

/** Публичный VAPID-ключ для браузера. Пустая строка — канал не настроен. */
export function getVapidPublicKey(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VAPID_PUBLIC_KEY ?? '').trim();
}

/**
 * Настраивает VAPID один раз за процесс.
 *
 * Ключи проверяются лениво, а не на старте: приложение умеет работать без
 * push-канала (только Telegram), и отсутствие ключей не должно мешать
 * остальным разделам. Предупреждение печатается один раз, а не на каждое
 * событие каждого пользователя.
 */
export function configureWebPush(env: NodeJS.ProcessEnv = process.env): boolean {
  if (configured !== null) return configured;

  const publicKey = getVapidPublicKey(env);
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (env.VAPID_SUBJECT ?? '').trim() || 'mailto:noreply@mood.local';

  if (!publicKey || !privateKey) {
    console.warn('[Push] VAPID-ключи не заданы — push-канал выключен.');
    configured = false;
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  } catch (err: unknown) {
    console.error('[Push] Не удалось настроить VAPID:', errorMessage(err));
    configured = false;
  }

  return configured;
}

/** Сбрасывает кэш настройки. Нужен тестам и смене ключей без рестарта. */
export function resetWebPushConfiguration(): void {
  configured = null;
}

/** Ссылка для тапа по уведомлению. */
export function pushUrlFor(kind: NotificationEvent['kind']): string {
  return PUSH_URLS[kind] ?? '/';
}

/**
 * Тело пуша: только тип события, без деталей.
 *
 * `body` берётся из label — он и так обобщённый («Новые оценки», «Новое
 * письмо»). Поля details здесь нет намеренно: payload проходит через
 * push-сервис браузера и показывается на заблокированном экране.
 */
export function buildPushPayload(event: Pick<NotificationEvent, 'kind' | 'label'>): string {
  return JSON.stringify({
    title: 'Mood',
    body: event.label,
    kind: event.kind,
    url: pushUrlFor(event.kind),
  });
}

/** Push-сервис окончательно забыл подписку: хранить её дальше бессмысленно. */
export function isDeadSubscription(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Отправляет событие на все устройства пользователя.
 *
 * Возвращает true, если хотя бы одно устройство приняло пуш. Мёртвые подписки
 * удаляются, живые получают отметку lastUsedAt. Ошибки отдельных устройств не
 * прерывают отправку на остальные.
 */
export async function sendPushToUser(
  user: StoredUser,
  event: NotificationEvent,
): Promise<boolean> {
  if (!configureWebPush()) return false;

  const subscriptions = user.pushSubscriptions ?? [];
  if (subscriptions.length === 0) return false;

  const payload = buildPushPayload(event);
  const results = await Promise.allSettled(
    subscriptions.map((subscription) =>
      webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        { TTL: PUSH_TTL_SECONDS, urgency: 'normal' },
      ),
    ),
  );

  const dead: string[] = [];
  const alive: string[] = [];

  results.forEach((result, index) => {
    const subscription = subscriptions[index];
    if (!subscription) return;

    if (result.status === 'fulfilled') {
      alive.push(subscription.endpoint);
      return;
    }

    const statusCode = (result.reason as { statusCode?: number } | undefined)?.statusCode;
    if (isDeadSubscription(statusCode)) {
      dead.push(subscription.endpoint);
      return;
    }

    // Endpoint в журнал не пишем: это адрес устройства, а не имя ошибки.
    console.error(
      `[Push] Ошибка отправки (${user.userId}):`,
      statusCode ?? errorMessage(result.reason),
    );
  });

  if (dead.length > 0 || alive.length > 0) {
    updateSubscriptions(user.userId, (current) => {
      const deadSet = new Set(dead);
      const aliveSet = new Set(alive);
      const now = new Date().toISOString();

      return current
        .filter((subscription) => !deadSet.has(subscription.endpoint))
        .map((subscription) =>
          aliveSet.has(subscription.endpoint)
            ? { ...subscription, lastUsedAt: now }
            : subscription,
        );
    });
  }

  return alive.length > 0;
}

/**
 * Меняет список подписок по свежей записи из хранилища.
 *
 * Перечитываем пользователя, а не патчим объект, пришедший в начале круга:
 * пока шла отправка, он мог добавить устройство или выйти из аккаунта.
 */
function updateSubscriptions(
  userId: string,
  update: (current: PushSubscriptionRecord[]) => PushSubscriptionRecord[],
): void {
  const fresh = userStore.getByUserId(userId);
  if (!fresh) return;

  userStore.patchByUserId(userId, {
    pushSubscriptions: update(fresh.pushSubscriptions ?? []),
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
