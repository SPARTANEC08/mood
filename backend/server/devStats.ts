/**
 * Статистика приложения: ровно то, что нужно владельцу, и ничего лишнего.
 *
 * ── Окно ────────────────────────────────────────────────────────────────────
 *
 * Метрики считаются по СКОЛЬЗЯЩИМ 24 часам от момента запроса: автоотчёт в 00:00
 * описывает прошедшие сутки, ручной («Отчёт сейчас») — последние 24 часа.
 * Внутри — минутные корзины: запросы, заходы, кто был активен, у кого появилась
 * сессия БАРС, создано/удалено ДЗ и «Важного». Корзины старше окна выбрасываются,
 * поэтому память и файл не растут.
 *
 * ── Что считается ───────────────────────────────────────────────────────────
 *
 *  1. активные сессии БАРС сейчас;
 *  2. новые сессии БАРС за окно (уникальные люди);
 *  3. максимальный онлайн за окно (по 5-минутному окну);
 *  4. онлайн сейчас (активность за последние 5 минут);
 *  5. заходы в приложение (загрузка приложения — запрос /api/bootstrap);
 *  6. список всех сессий БАРС (ФИО, группа, последний заход, БАРС/ТГ/уведы);
 *  7. диаграмма запросов по часам;
 *  8. ДЗ и «Важное»: создано/удалено за окно, всего сейчас;
 *  9. файлы: по пользователям (сколько и сколько весят) + итог.
 *
 * Всё остальное (латентность, коды ответов, категории запросов, память и диск,
 * контент по группам, ошибки БАРС, периоды 7д/30д) удалено намеренно: серверу
 * это не нужно, а отчёт от этого только тяжелее.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { isBarsAuthorized, userStore, type StoredUser } from '../../db/storage/userStore.ts';
import { homeworkStore } from '../../db/storage/homeworkStore.ts';
import { importantStore } from '../../db/storage/importantStore.ts';
import { JsonDocument } from '../../db/jsonStore.ts';
import { toMoscow } from '../utils/time.ts';
import { USER_PLATFORMS, type UserPlatform } from '../utils/platform.ts';

/** Размер окна и окна «онлайн». */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const MINUTE_MS = 60_000;

/** Запись в файл окна — не чаще раза в 5 минут: сервер слабый, I/O бережём. */
const SAVE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Окно, в течение которого повторный bootstrap не считается новым заходом.
 * Приложение может перезапросить bootstrap (перелогин, возврат вкладки), и без
 * этого «Заходов» становилось бы больше, чем реальных открытий.
 */
const VISIT_DEBOUNCE_MS = 30 * 60 * 1000;

/**
 * Служебные запросы: опросы уведомлений, обновление токена и превью файлов —
 * это не действия человека. Раньше они попадали в «запросы» и обновляли
 * «последнюю активность», из-за чего фоновые процессы выглядели как заходы.
 */
function isBackgroundRequest(path: string): boolean {
  return (
    path === '/api/announcements/next' ||
    path === '/api/notifications/state' ||
    path === '/api/auth/refresh' ||
    path === '/api/auth/config' ||
    path.endsWith('/preview')
  );
}

interface MinuteBucket {
  /** Начало минуты, ms. */
  at: number;
  requests: number;
  visits: number;
  /** Кто был активен в эту минуту (уникальные id). */
  users: string[];
  /** У кого в эту минуту появилась сессия БАРС. */
  barsNew: string[];
  homeworkCreated: number;
  homeworkDeleted: number;
  importantCreated: number;
  importantDeleted: number;
  /** Сэмпл: сколько сессий БАРС было живо в конце этой минуты. */
  barsActive?: number;
}

/** Корзины по началу минуты. */
const buckets = new Map<number, MinuteBucket>();
/** Последняя активность пользователя — для «онлайн сейчас». */
const lastSeen = new Map<string, number>();
/** Когда пользователю последний раз засчитывали заход (антидубль bootstrap). */
const lastVisit = new Map<string, number>();

let savedAt = 0;

const store = new JsonDocument<{ minutes: MinuteBucket[] }>('stats_window.json');

/* ─────────────────────────────── корзины ─────────────────────────────── */

function minuteOf(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

function bucketFor(ts: number): MinuteBucket {
  const key = minuteOf(ts);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      at: key,
      requests: 0,
      visits: 0,
      users: [],
      barsNew: [],
      homeworkCreated: 0,
      homeworkDeleted: 0,
      importantCreated: 0,
      importantDeleted: 0,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** Убирает корзины за пределами окна. */
function prune(now: number): void {
  const edge = now - WINDOW_MS;
  for (const key of [...buckets.keys()]) {
    if (key < edge) buckets.delete(key);
  }
  for (const [id, ts] of lastSeen) {
    if (ts < now - 60 * 60 * 1000) lastSeen.delete(id);
  }
  for (const [id, ts] of lastVisit) {
    if (ts < now - 24 * 60 * 60 * 1000) lastVisit.delete(id);
  }
}

function pushUnique(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

/** Записывает окно на диск (с троттлингом) — чтобы рестарт не терял сутки. */
function save(force = false): void {
  const now = Date.now();
  if (!force && now - savedAt < SAVE_THROTTLE_MS) return;
  savedAt = now;

  try {
    store.stage({ minutes: [...buckets.values()].sort((a, b) => a.at - b.at) });
    store.save();
  } catch {
    // Статистика — не повод ронять приложение.
  }
}

/** Восстанавливает окно после перезапуска. */
function load(): void {
  try {
    const saved = store.read();
    const now = Date.now();
    for (const bucket of saved?.minutes ?? []) {
      if (typeof bucket?.at !== 'number' || bucket.at < now - WINDOW_MS) continue;
      buckets.set(bucket.at, {
        ...bucket,
        users: bucket.users ?? [],
        barsNew: bucket.barsNew ?? [],
      });
    }
    if (buckets.size > 0) {
      console.log(`[Stats] окно восстановлено: ${buckets.size} минутных корзин`);
    }
  } catch {
    // Файла нет — обычный старт.
  }
}

/* ──────────────────────────── запись метрик ──────────────────────────── */

/** Активность: запрос пользователя. Служебные опросы сюда не входят. */
export function recordActivity(userId: string | undefined, url = '', ts: number = Date.now()): void {
  if (!userId) return;

  const path = url.split('?')[0] || '';
  if (isBackgroundRequest(path)) return;

  const bucket = bucketFor(ts);
  bucket.requests += 1;
  pushUnique(bucket.users, userId);
  lastSeen.set(userId, ts);

  // Заход в приложение: загрузка приложения всегда начинается с bootstrap.
  // Считаем его один раз в VISIT_DEBOUNCE_MS — повторные bootstrap (перелогин,
  // возврат вкладки) не должны раздувать число заходов.
  if (path === '/api/bootstrap') {
    const previous = lastVisit.get(userId) ?? 0;
    if (ts - previous >= VISIT_DEBOUNCE_MS) {
      bucket.visits += 1;
      lastVisit.set(userId, ts);
    }
  }

  save();
}

/** Успешный вход в БАРС — «новая сессия БАРС» этого человека. */
export function recordBarsLogin(userId: string, ts: number = Date.now()): void {
  pushUnique(bucketFor(ts).barsNew, userId);
  save();
}

export function recordHomework(change: 'created' | 'deleted', ts: number = Date.now()): void {
  const bucket = bucketFor(ts);
  if (change === 'created') bucket.homeworkCreated += 1;
  else bucket.homeworkDeleted += 1;
  save();
}

export function recordImportant(change: 'created' | 'deleted', ts: number = Date.now()): void {
  const bucket = bucketFor(ts);
  if (change === 'created') bucket.importantCreated += 1;
  else bucket.importantDeleted += 1;
  save();
}

/* ───────────────────────────── агрегация ───────────────────────────── */

/** Сэмпл живых сессий БАРС раз в минуту: нужен для «состояния на 23:59». */
function sampleBarsSessions(): void {
  const alive = userStore.all().filter(isBarsAuthorized).length;
  bucketFor(Date.now()).barsActive = alive;
}

/* ─────────────────────────── сбор активности ─────────────────────────── */

export function setupActivityTracking(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (request.userId) recordActivity(request.userId, request.url);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const route = request.url.split('?')[0];
    if (reply.statusCode !== 200) return payload;

    // Успешный вход (в том числе продолжение 2FA) — считаем новой сессией БАРС.
    if (route === '/api/auth/login' || route === '/api/auth/register' || route === '/api/auth/2fa') {
      const text = typeof payload === 'string' ? payload : '';
      const match = text.match(/"userId"\s*:\s*"([^"]+)"/);
      if (match) recordBarsLogin(match[1], Date.now());
    }

    return payload;
  });

  process.once('exit', () => save(true));
}

const minuteTimer = setInterval(() => {
  sampleBarsSessions();
  prune(Date.now());
  save();
}, MINUTE_MS);
minuteTimer.unref?.();

load();

/* ───────────────────────────── публичный ответ ───────────────────────────── */

export interface StatsSessionRow {
  id: string;
  name: string;
  group: string;
  /** Последний заход, ms (0 — не заходил). */
  lastSeenAt: number;
  bars: 'active' | 'expired' | 'none';
  telegram: boolean;
  notifications: boolean;
  /** Платформа последнего клиента (unknown — нет данных). */
  platform: UserPlatform;
  /** Гостевой профиль: только расписание, без БАРС и Telegram. */
  isGuest: boolean;
}

/** Разбивка пользователей по платформам. */
export type PlatformCounts = Record<UserPlatform, number>;

export interface StatsFilesRow {
  id: string;
  name: string;
  group: string;
  files: number;
  bytes: number;
  /** Последняя загрузка, ms (0 — файлов нет). */
  lastUploadAt: number;
}

export interface StatsResponse {
  generatedAt: number;
  /** Границы окна. Для автоотчёта конец — 23:59 описываемых суток. */
  windowStart: number;
  windowEnd: number;
  moscowNow: { date: string; time: string };
  /** Состояние на момент среза (живое или последний минутный сэмпл). */
  current: { barsSessions: number; online: number };
  window: {
    requests: number;
    visits: number;
    maxOnline: number;
    newBarsSessions: number;
    homework: { created: number; deleted: number; total: number };
    important: { created: number; deleted: number; total: number };
  };
  /** Диаграмма запросов: по часам за окно. */
  requestsByHour: { label: string; value: number }[];
  /** Разбивка всех пользователей по платформам (unknown — старые записи). */
  platforms: PlatformCounts;
  sessions: StatsSessionRow[];
  files: { totalFiles: number; totalBytes: number; byUser: StatsFilesRow[] };
}

function displayName(user: StoredUser): string {
  const full = user.studentProfile?.fullName?.trim();
  if (full) return full;
  const parts = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return parts || 'Без имени';
}

function barsState(user: StoredUser): StatsSessionRow['bars'] {
  // Поля читаем ДО type-guard: после него ветка «не авторизован» сужается до
  // never, и обратиться к barsAuth уже нельзя.
  const hasBars = Boolean(user.barsAuth);
  if (isBarsAuthorized(user)) return 'active';
  return hasBars ? 'expired' : 'none';
}

/**
 * Последняя активность человека.
 *
 * Раньше здесь брался `user.updatedAt`, но его меняет фоновый нотификатор
 * (сохранение OWA-сессии при проверке почты), и чужая фоновая работа выглядела
 * как заход. Теперь только реальные запросы: живые счётчики плюс минутные
 * корзины, восстановленные после рестарта.
 */
function lastSeenAt(user: StoredUser, fromBuckets: Map<string, number>): number {
  return Math.max(lastSeen.get(user.userId) ?? 0, fromBuckets.get(user.userId) ?? 0);
}

/** Файлы пользователей с кэшем на минуту: скан диска не должен идти на запрос. */
const FILES_TTL_MS = 60_000;
let filesCache: { at: number; rows: Map<string, { files: number; bytes: number; lastUploadAt: number }> } | null = null;

function scanFiles(): Map<string, { files: number; bytes: number; lastUploadAt: number }> {
  if (filesCache && Date.now() - filesCache.at < FILES_TTL_MS) return filesCache.rows;

  const rows = new Map<string, { files: number; bytes: number; lastUploadAt: number }>();
  const root = path.resolve(process.cwd(), 'db', 'data', 'files');

  try {
    for (const userDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!userDir.isDirectory()) continue;

      const dir = path.join(root, userDir.name);
      let files = 0;
      let bytes = 0;
      let lastUploadAt = 0;

      for (const entry of fs.readdirSync(dir)) {
        // Считаем только сами файлы: .meta.json и превью — служебные.
        if (entry.endsWith('.meta.json') || entry.includes('.preview-') || entry.endsWith('.tmp')) continue;
        try {
          const stat = fs.statSync(path.join(dir, entry));
          files += 1;
          bytes += stat.size;
          if (stat.mtimeMs > lastUploadAt) lastUploadAt = stat.mtimeMs;
        } catch {
          // файл могли удалить между readdir и stat
        }
      }

      rows.set(userDir.name, { files, bytes, lastUploadAt });
    }
  } catch {
    // Каталога нет — файлов нет.
  }

  filesCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Убирает пользователя из статистики.
 *
 * Удаляется не только строка в users: идентификатор лежит в минутных корзинах
 * (`users`, `barsNew`), в «последней активности» и в кэше файлов. Без этого
 * после удаления аккаунта человек ещё сутки появлялся бы в /dev и отчётах.
 *
 * Агрегатные счётчики (число запросов, заходов) не пересчитываются: это
 * обезличенные суммы за минуту, восстановить из них личность нельзя.
 */
export function forgetUser(userId: string): void {
  lastSeen.delete(userId);
  lastVisit.delete(userId);

  for (const bucket of buckets.values()) {
    bucket.users = bucket.users.filter((id) => id !== userId);
    bucket.barsNew = bucket.barsNew.filter((id) => id !== userId);
  }

  filesCache?.rows.delete(userId);
  save(true);
}

/**
 * Полный ответ для страницы /dev/ и для отчёта.
 *
 * `windowEnd` позволяет собрать исторический срез (автоотчёт в 00:00 описывает
 * сутки, закончившиеся минутой раньше): корзины вне окна не учитываются, а
 * «состояние сейчас» берётся из последнего минутного сэмпла, а не из живого
 * стора — иначе в ночном отчёте всегда было бы «онлайн 0».
 */
export function getStats(options: { windowEnd?: number } = {}): StatsResponse {
  const windowEnd = options.windowEnd ?? Date.now();
  const windowStart = windowEnd - WINDOW_MS;
  const live = Math.abs(windowEnd - Date.now()) < MINUTE_MS;

  // ── агрегаты окна ──────────────────────────────────────────────────────
  const inWindow = [...buckets.values()]
    .filter((bucket) => bucket.at + MINUTE_MS > windowStart && bucket.at <= windowEnd)
    .sort((a, b) => a.at - b.at);

  // Последняя активность по корзинам: после рестарта живой map пуст, но окно
  // восстанавливается из stats_window.json, и человек не «пропадает» из среза.
  const lastFromBuckets = new Map<string, number>();
  for (const bucket of inWindow) {
    for (const id of bucket.users) lastFromBuckets.set(id, bucket.at);
  }

  let requests = 0;
  let visits = 0;
  let homeworkCreated = 0;
  let homeworkDeleted = 0;
  let importantCreated = 0;
  let importantDeleted = 0;

  const barsNew = new Set<string>();
  const byHour = new Map<string, number>();

  for (const bucket of inWindow) {
    requests += bucket.requests;
    visits += bucket.visits;
    homeworkCreated += bucket.homeworkCreated;
    homeworkDeleted += bucket.homeworkDeleted;
    importantCreated += bucket.importantCreated;
    importantDeleted += bucket.importantDeleted;
    for (const id of bucket.barsNew) barsNew.add(id);

    const stamp = toMoscow(new Date(bucket.at));
    const hour = stamp.time.slice(0, 2);
    byHour.set(hour, (byHour.get(hour) ?? 0) + bucket.requests);
  }

  // Часовые столбцы окна: 24 последних часа, включая текущий.
  const requestsByHour: { label: string; value: number }[] = [];
  for (let i = 23; i >= 0; i -= 1) {
    const stamp = toMoscow(new Date(windowEnd - i * 60 * 60 * 1000));
    const hour = stamp.time.slice(0, 2);
    requestsByHour.push({ label: `${hour}:00`, value: byHour.get(hour) ?? 0 });
  }

  // Максимум онлайна: для каждой минуты — сколько разных людей были активны в
  // следующие 5 минут. Считаем скользящим окном по корзинам.
  let maxOnline = 0;
  for (let i = 0; i < inWindow.length; i += 1) {
    const from = inWindow[i].at;
    const people = new Set<string>();
    for (let j = i; j < inWindow.length && inWindow[j].at < from + ONLINE_WINDOW_MS; j += 1) {
      for (const id of inWindow[j].users) people.add(id);
    }
    if (people.size > maxOnline) maxOnline = people.size;
  }

  // ── состояние «сейчас» ─────────────────────────────────────────────────
  const now = windowEnd;
  const users = userStore.all();

  let barsSessions: number;
  let online: number;

  if (live) {
    barsSessions = users.filter(isBarsAuthorized).length;
    online = 0;
    for (const ts of lastSeen.values()) {
      if (ts >= now - ONLINE_WINDOW_MS) online += 1;
    }
  } else {
    // Исторический срез: последний минутный сэмпл в окне + активность за 5 минут
    // до его конца.
    const sample = [...inWindow].reverse().find((bucket) => typeof bucket.barsActive === 'number');
    barsSessions = sample?.barsActive ?? 0;

    const edge = (sample?.at ?? windowEnd) + MINUTE_MS;
    const people = new Set<string>();
    for (const bucket of inWindow) {
      if (bucket.at <= edge && bucket.at + MINUTE_MS > edge - ONLINE_WINDOW_MS) {
        for (const id of bucket.users) people.add(id);
      }
    }
    online = people.size;
  }

  // ── сессии и файлы ─────────────────────────────────────────────────────
  const platforms: PlatformCounts = { ios: 0, android: 0, web: 0, unknown: 0 };
  const sessions: StatsSessionRow[] = users
    .map((user) => {
      const platform = user.platform ?? 'unknown';
      if ((USER_PLATFORMS as readonly string[]).includes(platform)) platforms[platform] += 1;

      return {
        id: user.userId,
        name: displayName(user),
        group: user.groupName ?? user.studentProfile?.groupName ?? '',
        lastSeenAt: lastSeenAt(user, lastFromBuckets),
        bars: barsState(user),
        telegram: typeof user.telegramId === 'number',
        notifications: typeof user.telegramId === 'number' && user.notificationsEnabled !== false,
        platform,
        isGuest: user.isGuest === true,
      };
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  const scanned = scanFiles();
  const filesByUser: StatsFilesRow[] = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const user of users) {
    const stats = scanned.get(user.userId);
    if (!stats) continue;
    totalFiles += stats.files;
    totalBytes += stats.bytes;
    filesByUser.push({
      id: user.userId,
      name: displayName(user),
      group: user.groupName ?? user.studentProfile?.groupName ?? '',
      files: stats.files,
      bytes: stats.bytes,
      lastUploadAt: stats.lastUploadAt,
    });
  }
  filesByUser.sort((a, b) => b.bytes - a.bytes);

  const moscow = toMoscow(new Date(now));

  return {
    generatedAt: Date.now(),
    windowStart,
    windowEnd,
    moscowNow: { date: moscow.rawDate, time: moscow.time },
    current: { barsSessions, online },
    window: {
      requests,
      visits,
      maxOnline,
      newBarsSessions: barsNew.size,
      homework: { created: homeworkCreated, deleted: homeworkDeleted, total: homeworkStore.all().length },
      important: { created: importantCreated, deleted: importantDeleted, total: importantStore.all().length },
    },
    requestsByHour,
    platforms,
    sessions,
    files: { totalFiles, totalBytes, byUser: filesByUser },
  };
}
