/**
 * Гостевой режим: расписание без входа в БАРС.
 *
 * Гость — это отдельная запись users с `isGuest: true`, группой и именем.
 * Пароля, barsAuth и Telegram у неё нет, поэтому все личные разделы для неё
 * закрыты обычными guard'ами. Серверный токен нужен не для «личного кабинета»,
 * а чтобы статистика видела заходы, платформу и активность, а расписание
 * кэшировалось под стабильным userId.
 *
 * Создание гостя подчиняется тому же рубильнику регистрации, что и обычные
 * аккаунты: если новые аккаунты закрыты, гостевой вход тоже закрыт.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { registrationStore } from '../../../db/storage/registrationStore.ts';
import { userStore, type StoredUser } from '../../../db/storage/userStore.ts';
import { searchGroupOnMpei } from '../../parser/mpeiApi.ts';
import type { MpeiSearchResult } from '../../parser/types.ts';
import { detectPlatform } from '../../utils/platform.ts';
import { AuthError, requireUser } from '../middleware/auth.ts';
import { buildProfile, clientKey } from './auth/helpers.ts';
import { issueToken } from './auth/tokens.ts';

/** Лимиты простые, но достаточные, чтобы не плодить гостей скриптом. */
const GUEST_SESSION_LIMIT = 10;
const GUEST_SESSION_WINDOW_MS = 60 * 60 * 1000;
const GROUP_SEARCH_LIMIT = 30;
const GROUP_SEARCH_WINDOW_MS = 60 * 1000;

const buckets = new Map<string, number[]>();

/** true — запрос разрешён; попутно запоминает его время. */
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);

  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }

  recent.push(now);
  buckets.set(key, recent);

  // Страховка от роста Map: при большом числе IP старые ключи не нужны.
  if (buckets.size > 5000) {
    for (const [bucketKey, values] of buckets) {
      if (values.every((at) => now - at >= windowMs)) buckets.delete(bucketKey);
    }
  }

  return true;
}

function readDisplayName(body: unknown): string {
  const raw = body && typeof body === 'object' ? (body as { displayName?: unknown }).displayName : '';
  const name = typeof raw === 'string' ? raw.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : '';

  if (name.length === 0 || name.length > 40) {
    throw new AuthError(
      'Введите имя или псевдоним: от 1 до 40 символов.',
      400,
      'bad_request',
    );
  }

  // Имя хранится как обычный текст и никогда не интерпретируется как HTML/JS.
  return name;
}

interface GuestGroupInput {
  groupId: number;
  groupName: string;
  faculty?: string;
}

function readGroup(body: unknown): GuestGroupInput {
  const value = (body ?? {}) as {
    groupId?: unknown;
    groupName?: unknown;
    faculty?: unknown;
  };

  const groupId = typeof value.groupId === 'number' ? value.groupId : Number.NaN;
  const groupName =
    typeof value.groupName === 'string'
      ? value.groupName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
  const faculty =
    typeof value.faculty === 'string'
      ? value.faculty.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
      : undefined;

  if (!Number.isInteger(groupId) || groupId <= 0 || groupName.length === 0 || groupName.length > 120) {
    throw new AuthError('Выберите группу из списка.', 400, 'bad_request');
  }

  return { groupId, groupName, faculty: faculty || undefined };
}

function readOptionalGroup(body: unknown): GuestGroupInput | null {
  const value = (body ?? {}) as { groupId?: unknown; groupName?: unknown; faculty?: unknown };
  if (value.groupId === undefined && value.groupName === undefined) return null;
  return readGroup(body);
}

function isGuestUser(user: StoredUser): boolean {
  return user.isGuest === true;
}

function groupResult(item: MpeiSearchResult): { id: number; label: string; description: string } {
  return { id: item.id, label: item.label, description: item.description };
}

export async function registerGuestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/guest/groups?query=... — подсказки групп.
   *
   * Публичный маршрут: до создания гостя токена ещё нет. Поиск ходит в МЭИ,
   * поэтому ограничен по частоте.
   */
  app.get('/api/guest/groups', async (request, reply) => {
    if (!allow(`groups:${clientKey(request)}`, GROUP_SEARCH_LIMIT, GROUP_SEARCH_WINDOW_MS)) {
      return reply.code(429).send({
        error: 'too_many_requests',
        message: 'Слишком много запросов. Подождите минуту.',
      });
    }

    const query = (request.query ?? {}) as { query?: unknown };
    const term = typeof query.query === 'string' ? query.query.trim() : '';
    if (term.length < 2) return reply.send({ items: [] });

    try {
      const result = await searchGroupOnMpei(term);
      const found: MpeiSearchResult[] = result.success && result.group
        ? [result.group]
        : result.suggestions ?? [];
      const items = found
        .filter((item) => item.type === 'group')
        .slice(0, 10)
        .map(groupResult);

      return reply.send({ items });
    } catch (err: unknown) {
      console.error('[API guest groups] поиск группы не удался:', err instanceof Error ? err.message : err);
      return reply.code(503).send({
        error: 'group_search_unavailable',
        message: 'Не удалось найти группу. Попробуйте ещё раз.',
      });
    }
  });

  /** POST /api/guest/session — создать гостя и выдать обычный PWA-токен. */
  app.post('/api/guest/session', async (request, reply) => {
    if (!allow(`session:${clientKey(request)}`, GUEST_SESSION_LIMIT, GUEST_SESSION_WINDOW_MS)) {
      return reply.code(429).send({
        error: 'too_many_requests',
        message: 'Слишком много гостевых входов. Попробуйте позже.',
      });
    }

    if (!registrationStore.isOpen()) {
      throw new AuthError(
        'Регистрация новых аккаунтов временно закрыта. Гостевой вход тоже недоступен.',
        403,
        'registration_closed',
      );
    }

    const body = request.body;
    const displayName = readDisplayName(body);
    const group = readGroup(body);

    const created = userStore.create({
      barsLoginHash: `guest:${randomUUID()}`,
      firstName: displayName,
    });

    const user = userStore.patch(created.userId, {
      isGuest: true,
      firstName: displayName,
      groupName: group.groupName,
      groupId: group.groupId,
      faculty: group.faculty,
      studentProfile: { fullName: displayName, groupName: group.groupName },
      platform: detectPlatform(request.headers),
    });

    if (!user) {
      throw new AuthError('Не удалось создать гостевой профиль.', 500, 'guest_create_failed');
    }

    return reply.send(issueToken(user));
  });

  /** PATCH /api/guest/profile — сменить имя и/или группу. */
  app.patch('/api/guest/profile', async (request, reply) => {
    const user = requireUser(request);
    if (!isGuestUser(user)) {
      throw new AuthError('Этот маршрут доступен только гостю.', 403, 'not_guest');
    }

    const body = (request.body ?? {}) as { displayName?: unknown };
    const patch: Partial<StoredUser> = {};
    const displayName = body.displayName !== undefined ? readDisplayName(body) : undefined;
    if (displayName) patch.firstName = displayName;

    const group = readOptionalGroup(body);
    if (group) {
      patch.groupName = group.groupName;
      patch.groupId = group.groupId;
      patch.faculty = group.faculty;
    }

    if (displayName || group) {
      patch.studentProfile = {
        fullName: displayName ?? user.studentProfile?.fullName ?? user.firstName,
        ...(user.studentProfile ?? {}),
        ...(displayName ? { fullName: displayName } : {}),
        ...(group ? { groupName: group.groupName } : {}),
      };
    }

    if (Object.keys(patch).length === 0) {
      throw new AuthError('Нет данных для изменения.', 400, 'bad_request');
    }

    const updated = userStore.patch(user.userId, patch);
    if (!updated) throw new AuthError('Гость не найден.', 404, 'not_found');

    return reply.send({ profile: buildProfile(updated) });
  });
}
