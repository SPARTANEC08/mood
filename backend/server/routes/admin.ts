/**
 * Админка PWA: единый набор маршрутов под /api/admin.
 *
 * Доступ проверяется `requireAdmin` (env-логины БАРС и
 * назначенные из PWA). Обычный пользователь получает 403 и не видит ни
 * одного маршрута.
 *
 * Долгие операции (рассылка, принудительный прогон) отвечают jobId, прогресс
 * клиент опрашивает отдельным запросом.
 */

import path from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { adminAuditStore } from '../../../db/storage/adminAuditStore.ts';
import { announcementStore } from '../../../db/storage/announcementStore.ts';
import { pwaAdminsStore } from '../../../db/storage/pwaAdminsStore.ts';
import { registrationStore } from '../../../db/storage/registrationStore.ts';
import { isBarsAuthorized, userStore, type StoredUser } from '../../../db/storage/userStore.ts';
import { deleteAccount } from '../../services/account/deleteAccount.ts';
import {
  availableDates,
  dailyStatsFromResponse,
  monthDates,
  mskDate,
  readDailyStats,
  shiftDate,
  summarize,
  type DailyStats,
} from '../../services/admin/statsHistory.ts';
import { startBroadcast } from '../../services/admin/broadcast.ts';
import {
  bumpJob,
  createJob,
  finishJob,
  getJob,
  runningJob,
} from '../../services/admin/jobs.ts';
import { activityByUser, getStats } from '../devStats.ts';
import { runMaintenance } from '../../services/maintenance/run.ts';
import { getDiskUsage } from '../../services/maintenance/cleanup.ts';
import {
  notifierRuntimeStatus,
  runCycleForced,
} from '../../services/notifications/notifier/run.ts';
import { forgetBarsClient, forgetBarsSessionValid } from '../../services/bars/barsServiceFactory.ts';
import { forgetOwaClient } from '../../services/mail/owaClientRegistry.ts';
import { clearMailStatus } from '../../services/mail/mailStatusCache.ts';
import { adminName, envBarsLoginHashes, isEnvBarsAdmin, isPwaAdmin, requireAdmin } from '../../utils/adminAuth.ts';
import { AuthError } from '../middleware/auth.ts';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  return text((body as { text?: unknown }).text);
}

function readUrl(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = text((body as { url?: unknown }).url);
  if (!value) return undefined;
  // В push уходит только http(s); иначе кнопка была бы бесполезной.
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * «Последний вход» — только реальная активность.
 *
 * `updatedAt` и `lastUsedAt` токена трогает фоновый нотификатор и плановые
 * опросы, поэтому они показывали «только что» у людей, которые приложение не
 * открывали. `barsAuthedAt` — честный вход в БАРС, его оставляем запасным.
 */
function lastSeenAt(user: StoredUser, activity: Map<string, number>): number {
  const live = activity.get(user.userId) ?? 0;
  const login = user.barsAuthedAt ? Date.parse(user.barsAuthedAt) : Number.NaN;
  return Math.max(live, Number.isFinite(login) ? login : 0);
}

function userSummary(user: StoredUser, activity: Map<string, number>) {
  return {
    id: user.userId,
    name: adminName(user),
    group: user.groupName ?? user.studentProfile?.groupName ?? '',
    platform: user.platform ?? 'unknown',
    lastSeenAt: lastSeenAt(user, activity),
    bars: isBarsAuthorized(user) ? ('active' as const) : ('none' as const),
    push: user.pushSubscriptions?.length ?? 0,
    isGuest: user.isGuest === true,
    isAdmin: isPwaAdmin(user),
    createdAt: user.createdAt,
  };
}

function findUser(request: FastifyRequest): StoredUser {
  const { id } = request.params as { id?: string };
  const user = id ? userStore.getByUserId(id) : undefined;
  if (!user) {
    throw new AuthError('Пользователь не найден.', 404, 'not_found');
  }
  return user;
}

function audit(
  admin: StoredUser,
  action: string,
  target?: string,
  details?: string,
): void {
  adminAuditStore.record({
    adminUserId: admin.userId,
    adminName: adminName(admin),
    action,
    target,
    details,
  });
}

export function registerAdminRoutes(app: FastifyInstance): void {
  /* ── статистика ─────────────────────────────────────────────────────────── */

  app.get('/api/admin/stats', async (request, reply) => {
    requireAdmin(request);

    const query = request.query as { period?: string; date?: string };
    const period = query.period ?? 'today';
    const today = mskDate();
    const available = availableDates();

    let dates: string[] = [];
    let live = null as ReturnType<typeof getStats> | null;

    if (period === 'today') {
      live = getStats();
      dates = [today];
    } else if (period === 'yesterday') {
      dates = [shiftDate(today, -1)];
    } else if (period === 'week') {
      dates = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
    } else if (period === 'month') {
      dates = monthDates(today);
    } else if (period === 'date') {
      const date = text(query.date);
      if (!DATE_RE.test(date) || date > today || date.slice(0, 7) !== today.slice(0, 7)) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'Дата должна быть в пределах текущего месяца.',
        });
      }
      dates = [date];
    } else {
      return reply.code(400).send({ error: 'bad_request', message: 'Неизвестный период.' });
    }

    const days: DailyStats[] = [];
    for (const date of dates) {
      if (live && date === today) {
        days.push(dailyStatsFromResponse(live, today));
        continue;
      }
      const day = readDailyStats(date);
      if (day) days.push(day);
    }

    const summary = summarize(days);

    return reply.send({
      period,
      from: dates[0] ?? today,
      to: dates[dates.length - 1] ?? today,
      live,
      days: summary.days,
      totals: summary.totals,
      latest: summary.latest,
      availableDates: available,
    });
  });

  /* ── пользователи ───────────────────────────────────────────────────────── */

  app.get('/api/admin/users', async (request, reply) => {
    requireAdmin(request);

    const query = request.query as { query?: string; limit?: string };
    const search = text(query.query).toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));

    const activity = activityByUser();
    const users = userStore
      .all()
      .map((user) => userSummary(user, activity))
      .filter((user) => {
        if (!search) return true;
        return (
          user.name.toLowerCase().includes(search) ||
          user.group.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);

    return reply.send({ users, total: users.length });
  });

  app.get('/api/admin/users/:id', async (request, reply) => {
    requireAdmin(request);
    const user = findUser(request);

    return reply.send({
      ...userSummary(user, activityByUser()),
      faculty: user.faculty ?? '',
      recordBookNumber: user.studentProfile?.recordBookNumber ?? '',
      barsAuthedAt: user.barsAuthedAt ?? null,
      pwaTokens: user.pwaTokens?.length ?? 0,
      pushEnabled: user.pushEnabled !== false,
      sessionValid: isBarsAuthorized(user),
    });
  });

  app.post('/api/admin/users/:id/reset-sessions', async (request, reply) => {
    const admin = requireAdmin(request);
    const user = findUser(request);

    userStore.clearAuth(user.userId);
    // «Сброс сессий» обязан выкинуть и PWA-устройства: иначе украденный токен
    // продолжал бы работать все 90 дней.
    userStore.revokeAllTokens(user.userId);
    forgetBarsClient(user.userId);
    forgetBarsSessionValid(user.userId);
    forgetOwaClient(user.userId);
    clearMailStatus(user.userId);

    audit(admin, 'user_reset_sessions', user.userId, adminName(user));
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:id/delete', async (request, reply) => {
    const admin = requireAdmin(request);
    const user = findUser(request);
    const confirmation = text((request.body as { confirmation?: unknown } | null)?.confirmation);

    if (confirmation !== 'УДАЛИТЬ') {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Для удаления введите слово УДАЛИТЬ.',
      });
    }

    if (user.userId === admin.userId) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Нельзя удалить собственный аккаунт из админки.',
      });
    }

    const name = adminName(user);
    audit(admin, 'user_delete', user.userId, name);
    await deleteAccount(user);

    return reply.send({ ok: true });
  });

  /* ── рассылка ───────────────────────────────────────────────────────────── */

  app.post('/api/admin/broadcast', async (request, reply) => {
    const admin = requireAdmin(request);
    const body = request.body as { text?: unknown; url?: unknown; userId?: unknown } | null;
    const message = readText(body);

    if (!message) {
      return reply.code(400).send({ error: 'bad_request', message: 'Текст рассылки пуст.' });
    }
    if (message.length > 4000) {
      return reply.code(400).send({ error: 'bad_request', message: 'Текст длиннее 4000 символов.' });
    }

    const targetUserId = text(body?.userId) || undefined;
    if (targetUserId) {
      const target = userStore.getByUserId(targetUserId);
      if (!target) {
        return reply.code(404).send({ error: 'not_found', message: 'Получатель не найден.' });
      }
      if (target.isGuest === true) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'Гость не получает уведомления — выберите обычного пользователя.',
        });
      }
    }

    const job = startBroadcast({
      text: message,
      url: readUrl(body),
      targetUserId,
      admin,
    });

    if (!job) {
      const running = runningJob('broadcast');
      return reply.code(409).send({
        error: 'job_running',
        message: 'Рассылка уже идёт.',
        jobId: running?.id ?? null,
      });
    }

    return reply.send({ jobId: job.id, total: job.total });
  });

  /* ── фоновые задачи ─────────────────────────────────────────────────────── */

  app.get('/api/admin/jobs/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'Задача не найдена.' });
    return reply.send(job);
  });

  app.post('/api/admin/notifier/run', async (request, reply) => {
    const admin = requireAdmin(request);

    const running = runningJob('notifier');
    if (running) return reply.send({ jobId: running.id, total: running.total, running: true });

    const total = userStore.all().filter(isBarsAuthorized).length;
    const job = createJob('notifier', total);

    void (async () => {
      try {
        const result = await runCycleForced((processed, all) => {
          bumpJob(job.id, { done: processed, message: `${processed} из ${all}` });
        });

        if (!result) {
          finishJob(job.id, 'Прогон уже выполняется.');
          return;
        }

        bumpJob(job.id, {
          done: result.processed,
          progress: { notified: result.notified, errors: result.errors },
          message: `проверено ${result.processed}, уведомлений ${result.notified}, ошибок ${result.errors}`,
        });
        finishJob(job.id);
        audit(admin, 'notifier_run', 'все', `проверено ${result.processed}, ошибок ${result.errors}`);
      } catch (err: unknown) {
        finishJob(job.id, err instanceof Error ? err.message : String(err));
      }
    })();

    return reply.send({ jobId: job.id, total });
  });

  /* ── объявления ─────────────────────────────────────────────────────────── */

  app.get('/api/admin/announcements', async (request, reply) => {
    requireAdmin(request);
    return reply.send({ items: announcementStore.listAll() });
  });

  app.post('/api/admin/announcements', async (request, reply) => {
    const admin = requireAdmin(request);
    const body = request.body as { text?: unknown; userId?: unknown } | null;
    const message = readText(body);

    if (!message) {
      return reply.code(400).send({ error: 'bad_request', message: 'Текст пуст.' });
    }

    const targetUserId = text(body?.userId) || undefined;
    if (targetUserId) {
      const target = userStore.getByUserId(targetUserId);
      if (!target) {
        return reply.code(404).send({ error: 'not_found', message: 'Получатель не найден.' });
      }
      if (target.isGuest === true) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'Гостю нельзя адресовать объявление.',
        });
      }
    }

    const item = announcementStore.create(message, admin.userId, targetUserId);
    audit(admin, 'announcement_create', targetUserId ?? 'все', message.slice(0, 80));
    return reply.send({ item });
  });

  app.delete('/api/admin/announcements/:id', async (request, reply) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const removed = announcementStore.remove(id);

    if (!removed) return reply.code(404).send({ error: 'not_found', message: 'Объявление не найдено.' });

    audit(admin, 'announcement_delete', id);
    return reply.send({ ok: true });
  });

  /* ── диагностика ────────────────────────────────────────────────────────── */

  app.get('/api/admin/diagnostics', async (request, reply) => {
    requireAdmin(request);

    const users = userStore.all();
    const disk = await getDiskUsage(DATA_DIR);
    const memory = process.memoryUsage();

    return reply.send({
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
      disk,
      users: {
        total: users.length,
        guests: users.filter((user) => user.isGuest === true).length,
        barsAuthorized: users.filter(isBarsAuthorized).length,
        withPush: users.filter((user) => (user.pushSubscriptions?.length ?? 0) > 0).length,
      },
      pushDevices: users.reduce((sum, user) => sum + (user.pushSubscriptions?.length ?? 0), 0),
      notifier: notifierRuntimeStatus(),
      registrationOpen: registrationStore.isOpen(),
      jobs: {
        broadcast: runningJob('broadcast')?.id ?? null,
        notifier: runningJob('notifier')?.id ?? null,
      },
      audit: adminAuditStore.list(10),
    });
  });

  app.post('/api/admin/maintenance', async (request, reply) => {
    const admin = requireAdmin(request);
    const result = await runMaintenance();

    audit(
      admin,
      'maintenance',
      'диск',
      `previews ${result.previews}, orphans ${result.orphans}, tmp ${result.tmp}, reports ${result.reports}`,
    );
    return reply.send({ result });
  });

  /* ── регистрация ────────────────────────────────────────────────────────── */

  app.get('/api/admin/registration', async (request, reply) => {
    requireAdmin(request);
    return reply.send({ open: registrationStore.isOpen() });
  });

  app.post('/api/admin/registration', async (request, reply) => {
    const admin = requireAdmin(request);
    const body = request.body as { open?: unknown } | null;

    if (typeof body?.open !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'Передайте { open: boolean }.' });
    }

    registrationStore.setOpen(body.open);
    audit(admin, 'registration_toggle', 'все', body.open ? 'открыта' : 'закрыта');
    return reply.send({ open: registrationStore.isOpen() });
  });

  /* ── администраторы ─────────────────────────────────────────────────────── */

  app.get('/api/admin/admins', async (request, reply) => {
    requireAdmin(request);

    const assigned = pwaAdminsStore.list().map((record) => {
      const user = userStore.getByUserId(record.userId);
      return {
        userId: record.userId,
        name: user ? adminName(user) : 'Удалённый пользователь',
        group: user?.groupName ?? user?.studentProfile?.groupName ?? '',
        addedAt: record.addedAt,
      };
    });

    // Открытые логины env-админов наружу не отдаём: их хэширование иначе
    // теряло бы смысл. Только количество.
    return reply.send({
      env: {
        barsHashes: envBarsLoginHashes().length,
      },
      assigned,
    });
  });

  app.post('/api/admin/admins', async (request, reply) => {
    const admin = requireAdmin(request);
    const userId = text((request.body as { userId?: unknown } | null)?.userId);
    const user = userId ? userStore.getByUserId(userId) : undefined;

    if (!user) return reply.code(404).send({ error: 'not_found', message: 'Пользователь не найден.' });
    if (user.isGuest === true) {
      return reply.code(400).send({ error: 'bad_request', message: 'Гость не может быть админом.' });
    }
    if (isPwaAdmin(user)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Этот пользователь уже админ.',
      });
    }

    pwaAdminsStore.add(user.userId, admin.userId);
    audit(admin, 'admin_add', user.userId, adminName(user));
    return reply.send({ ok: true });
  });

  app.delete('/api/admin/admins/:userId', async (request, reply) => {
    const admin = requireAdmin(request);
    const { userId } = request.params as { userId: string };
    const user = userStore.getByUserId(userId);

    if (!user) return reply.code(404).send({ error: 'not_found', message: 'Пользователь не найден.' });
    if (isEnvBarsAdmin(user)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Env-админа снять нельзя: измените ADMIN_BARS_LOGINS.',
      });
    }

    const removed = pwaAdminsStore.remove(userId);
    if (!removed) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Этот пользователь не назначен из PWA.',
      });
    }

    audit(admin, 'admin_remove', userId, adminName(user));
    return reply.send({ ok: true });
  });

  /* ── аудит ──────────────────────────────────────────────────────────────── */

  app.get('/api/admin/audit', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    return reply.send({ items: adminAuditStore.list(limit) });
  });
}
