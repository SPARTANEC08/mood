/**
 * Темы оформления сообщества.
 *
 * Официальные темы в API не участвуют: они лежат в коде PWA. Здесь только
 * пользовательские публикации — список, создание и удаление своей темы.
 *
 * Приватность: автор хранится в базе для лимитов и удаления, но в ответе его
 * нет. Публичное поле `mine` вычисляется на сервере и не раскрывает, кто ещё
 * создавал темы.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { themeStore, type StoredTheme, type ThemeVariant, type ThemeVariants } from '../../../db/storage/themeStore.ts';
import { AuthError, requireUser } from '../middleware/auth.ts';
import type { ApiTheme, ThemesResponse } from '../types.ts';

/** Сколько тем сообщества отдаём в одном списке. */
const PUBLIC_LIMIT = 100;

/** Лимит публикаций: 3 темы за скользящие 24 часа. */
const PUBLISH_LIMIT = 3;
const PUBLISH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Потолок тем на пользователя — чтобы список не превращался в свалку. */
const MAX_THEMES_PER_USER = 20;

const NAME_MAX = 24;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Гость темы не получает: это часть оформления авторизованного приложения. */
function requireThemeUser(request: FastifyRequest) {
  const user = requireUser(request);
  if (user.isGuest) {
    throw new AuthError('Темы недоступны в гостевом режиме.', 403, 'themes_unavailable');
  }
  return user;
}

function readHue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > 359) return null;
  return value;
}

function readVariant(value: unknown): ThemeVariant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const backgroundHue = readHue(source.backgroundHue);
  const surfaceHue = readHue(source.surfaceHue);
  const accentHue = readHue(source.accentHue);

  if (backgroundHue === null || surfaceHue === null || accentHue === null) return null;
  return { backgroundHue, surfaceHue, accentHue };
}

function readVariants(value: unknown): { ok: true; variants: ThemeVariants } | { ok: false; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'Не передан ни один вариант темы.' };
  }

  const source = value as Record<string, unknown>;
  const variants: ThemeVariants = {};

  for (const key of ['light', 'dark'] as const) {
    if (!(key in source) || source[key] === undefined) continue;

    const variant = readVariant(source[key]);
    if (!variant) {
      return {
        ok: false,
        message:
          key === 'light'
            ? 'Некорректные оттенки светлой версии.'
            : 'Некорректные оттенки тёмной версии.',
      };
    }

    variants[key] = variant;
  }

  if (!variants.light && !variants.dark) {
    return { ok: false, message: 'Нужен хотя бы один вариант: светлый или тёмный.' };
  }

  return { ok: true, variants };
}

/** Имя без управляющих символов, лишних пробелов и переводов строк. */
function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const name = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.length === 0 || name.length > NAME_MAX) return null;
  return name;
}

function mapPublic(theme: StoredTheme, viewerUserId: string): ApiTheme {
  return {
    id: theme.id,
    name: theme.name,
    variants: theme.variants,
    createdAt: theme.createdAt,
    mine: theme.authorUserId === viewerUserId,
  };
}

export function registerThemeRoutes(app: FastifyInstance): void {
  /** Список опубликованных тем сообщества, новые сверху. */
  app.get('/api/themes', async (request, reply) => {
    const user = requireThemeUser(request);
    const items = themeStore.listPublished(user.userId, PUBLIC_LIMIT).map((theme) => ({
      ...theme,
      mine: theme.mine,
    }));

    const response: ThemesResponse = { items };
    return reply.send(response);
  });

  /** Публикация темы. Автор — только текущий пользователь из токена. */
  app.post('/api/themes', async (request, reply) => {
    const user = requireThemeUser(request);
    const body = request.body as { name?: unknown; variants?: unknown } | null;

    const name = readName(body?.name);
    if (!name) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Название темы — от 1 до ${NAME_MAX} символов без переводов строк.`,
      });
    }

    const parsed = readVariants(body?.variants);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.message });
    }

    const since = new Date(Date.now() - PUBLISH_WINDOW_MS).toISOString();
    const recent = themeStore.createdSince(user.userId, since);

    if (recent.length >= PUBLISH_LIMIT) {
      const oldest = recent[0]?.createdAt ? Date.parse(recent[0].createdAt) : Date.now();
      const retryAfterMs = Math.max(60_000, oldest + PUBLISH_WINDOW_MS - Date.now());
      return reply.code(429).send({
        error: 'theme_limit',
        message: `Можно опубликовать не больше ${PUBLISH_LIMIT} тем в сутки. Попробуйте позже.`,
        retryAfterMs,
      });
    }

    if (themeStore.countByAuthor(user.userId) >= MAX_THEMES_PER_USER) {
      return reply.code(429).send({
        error: 'theme_limit',
        message: `У вас уже ${MAX_THEMES_PER_USER} тем. Удалите одну из своих тем, чтобы опубликовать новую.`,
      });
    }

    const theme = themeStore.create({
      authorUserId: user.userId,
      name,
      variants: parsed.variants,
    });

    return reply.send({ theme: mapPublic(theme, user.userId) });
  });

  /** Удаление своей темы. Чужую удалить нельзя даже зная id. */
  app.delete('/api/themes/:id', async (request, reply) => {
    const user = requireThemeUser(request);
    const { id } = request.params as { id: string };

    const theme = themeStore.getById(id);
    if (!theme || theme.status === 'deleted') {
      return reply.code(404).send({ error: 'not_found', message: 'Тема не найдена.' });
    }

    if (theme.authorUserId !== user.userId) {
      return reply.code(403).send({ error: 'forbidden', message: 'Это не ваша тема.' });
    }

    themeStore.setStatus(id, 'deleted');
    return reply.send({ ok: true });
  });
}
