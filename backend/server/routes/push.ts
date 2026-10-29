/**
 * Подписки браузера на Web Push.
 *
 * Подписка — это адрес push-сервиса и два публичных ключа шифрования. Приватный
 * ключ остаётся в браузере, поэтому сервер не может расшифровать чужие пуши и
 * не хранит ничего, чем можно выдать себя за устройство.
 *
 * Все маршруты требуют обычную PWA-сессию: подписка принадлежит человеку, а не
 * устройству, и привязывать её к чужой записи нельзя.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { PushSubscriptionRecord } from '../../../db/storage/userStore.ts';
import { userStore } from '../../../db/storage/userStore.ts';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  getVapidPublicKey,
} from '../../services/notifications/webPush.ts';
import { LEGAL_DOCUMENTS, isConsentCurrent } from '../../legal/registry.ts';
import { requireUser } from '../middleware/auth.ts';

/** Разумные пределы: endpoint и ключи — короткие base64url-строки. */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 200;

interface SubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Разбирает тело подписки.
 *
 * Проверяется всё, что попадёт в хранилище и потом уйдёт в web-push: схема
 * endpoint, длины строк, наличие обоих ключей. Мусор в записи пользователя
 * приводил бы к ошибкам на каждой отправке, а не к понятному 400 при подписке.
 */
export function readSubscription(body: unknown): SubscriptionInput | null {
  if (!body || typeof body !== 'object') return null;

  const raw = body as { endpoint?: unknown; keys?: unknown };
  if (typeof raw.endpoint !== 'string') return null;

  const endpoint = raw.endpoint.trim();
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return null;

  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }

  if (!raw.keys || typeof raw.keys !== 'object') return null;

  const keys = raw.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;

  const p256dh = keys.p256dh.trim();
  const auth = keys.auth.trim();
  if (!p256dh || p256dh.length > MAX_KEY_LENGTH) return null;
  if (!auth || auth.length > MAX_KEY_LENGTH) return null;

  return { endpoint, keys: { p256dh, auth } };
}

function readEndpoint(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;

  const value = (body as { endpoint?: unknown }).endpoint;
  if (typeof value !== 'string') return null;

  const endpoint = value.trim();
  return endpoint && endpoint.length <= MAX_ENDPOINT_LENGTH ? endpoint : null;
}

function userAgentOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['user-agent'];
  return typeof raw === 'string' ? raw.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

export function registerPushRoutes(app: FastifyInstance): void {
  /**
   * Публичный VAPID-ключ.
   *
   * Нужен странице перед pushManager.subscribe. Пустая строка означает, что
   * канал не настроен на сервере, — клиент в этом случае просто не предлагает
   * включить push.
   */
  app.get('/api/push/key', async (request, reply) => {
    requireUser(request);
    return reply.send({ publicKey: getVapidPublicKey() });
  });

  /**
   * Сохранение подписки.
   *
   * Идемпотентно по endpoint: повторная подписка с того же устройства
   * обновляет ключи, а не добавляет дубль. Новые устройства вытесняют самые
   * старые, чтобы брошенные подписки не копились бесконечно.
   */
  app.post('/api/push/subscribe', async (request, reply) => {
    const user = requireUser(request);

    if (!isConsentCurrent(user.consents?.push, LEGAL_DOCUMENTS.push)) {
      return reply.code(403).send({
        error: 'consent_required',
        message: 'Сначала примите согласие на push-уведомления.',
      });
    }

    const parsed = readSubscription(request.body);

    if (!parsed) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Некорректная подписка на push.',
      });
    }

    const now = new Date().toISOString();
    const current = user.pushSubscriptions ?? [];
    const existing = current.find((item) => item.endpoint === parsed.endpoint);
    const rest = current.filter((item) => item.endpoint !== parsed.endpoint);

    const record: PushSubscriptionRecord = {
      endpoint: parsed.endpoint,
      keys: parsed.keys,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: existing?.lastUsedAt,
      userAgent: userAgentOf(request) ?? existing?.userAgent,
    };

    const next = [record, ...rest].slice(0, MAX_PUSH_SUBSCRIPTIONS);
    userStore.patchByUserId(user.userId, { pushSubscriptions: next });

    return reply.send({ ok: true, devices: next.length });
  });

  /** Удаление подписки текущего устройства (выход из аккаунта, отзыв). */
  app.post('/api/push/unsubscribe', async (request, reply) => {
    const user = requireUser(request);
    const endpoint = readEndpoint(request.body);

    if (!endpoint) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Передайте { endpoint }.',
      });
    }

    const next = (user.pushSubscriptions ?? []).filter(
      (item) => item.endpoint !== endpoint,
    );
    userStore.patchByUserId(user.userId, { pushSubscriptions: next });

    return reply.send({ ok: true, devices: next.length });
  });

  /** Состояние канала: включён ли флаг и сколько устройств подписано. */
  app.get('/api/push/state', async (request, reply) => {
    const user = requireUser(request);

    return reply.send({
      pushEnabled: user.pushEnabled !== false,
      devices: (user.pushSubscriptions ?? []).length,
    });
  });
}
