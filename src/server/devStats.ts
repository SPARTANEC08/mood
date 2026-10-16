/**
 * Сбор и агрегация статистики (страница /dev/ и ежедневный отчёт).
 *
 * Принцип — минимум нагрузки на слабый ВПС:
 *  - на каждый запрос только инкременты в памяти (числа), без I/O;
 *  - на диск пишется РОВНО один раз в сутки: `data/stats_daily.json` (через
 *    JsonDocument — атомарно, 0600) в 00:00 МСК и при смене дня;
 *  - история — плоский JSON «день → агрегаты», старые дни чистятся (90);
 *  - тяжёлые вещи (скан файлов, размер data/) — с кэшем на 60 с, не на запрос;
 *  - p50/p95 — из кольцевого буфера на 1000 значений, пересчёт раз в минуту.
 *
 * Модуль самостоятельный и не меняет существующую логику: использует публичные
 * API хранилищ и время `toMoscow`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isBarsAuthorized, userStore, type StoredUser } from '../storage/userStore.ts';
import { homeworkStore } from '../storage/homeworkStore.ts';
import { importantStore } from '../storage/importantStore.ts';
import { snapshotStore } from '../storage/snapshotStore.ts';
import { JsonDocument } from '../utils/jsonStore.ts';
import { toMoscow } from '../utils/time.ts';

/** Сколько дней истории хранить. */
const KEEP_DAYS = 90;

/** Окна «активен сейчас», в минутах. */
export const ACTIVE_WINDOWS_MIN = [1, 15, 60] as const;

/** Размеры окон для периодов. */
const PERIOD_DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;
export type Period = keyof typeof PERIOD_DAYS;

/** Порядок категорий фиксирован, чтобы разбивка не «прыгала». */
export const CATEGORY_ORDER = [
  'schedule',
  'homework',
  'bars',
  'mail',
  'important',
  'files',
  'bootstrap',
  'notifications',
  'auth',
  'other',
] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const LATENCY_BUFFER = 1000;
const FILE_SCAN_TTL_MS = 60_000;

// ── Текущий день (память) ────────────────────────────────────────────────────

interface MemUser {
  count: number;
  first: number;
  last: number;
}

let memDay = '';
let memRequests = 0;
let memLogins = 0;
let mem4xx = 0;
let mem5xx = 0;
let memBarsExpired = 0;
let memNotifications = 0;
const memUsers = new Map<string, MemUser>();
const memCategories: Record<string, number> = {};
const memHours = new Array(24).fill(0);
const memBarsErrors: Record<string, number> = {};

/** Последняя активность по userId — из памяти (живёт с рестарта). */
const lastSeen = new Map<string, number>();

// ── Кольцевой буфер времени ответа ───────────────────────────────────────────

const latencyRing = new Array<number>(LATENCY_BUFFER).fill(0);
let latencyIdx = 0;
let latencyCount = 0;
let latencyP50 = 0;
let latencyP95 = 0;

function pushLatency(ms: number): void {
  latencyRing[latencyIdx] = ms;
  latencyIdx = (latencyIdx + 1) % LATENCY_BUFFER;
  if (latencyCount < LATENCY_BUFFER) latencyCount += 1;
}

function recomputeLatency(): void {
  if (latencyCount === 0) {
    latencyP50 = 0;
    latencyP95 = 0;
    return;
  }
  const values = latencyRing.slice(0, latencyCount).sort((a, b) => a - b);
  latencyP50 = values[Math.floor(values.length * 0.5)] ?? 0;
  latencyP95 = values[Math.floor(values.length * 0.95)] ?? 0;
}

const latencyTimer = setInterval(recomputeLatency, 60_000);
latencyTimer.unref?.();

/** Ошибки 5xx за последний час — кольцо по минутам, без I/O. */
const err5xxMinuteValue = new Array(60).fill(0);
const err5xxMinuteKey = new Array(60).fill(-1);

function bump5xx(ts: number): void {
  const minute = Math.floor(ts / 60_000);
  const slot = minute % 60;
  if (err5xxMinuteKey[slot] !== minute) {
    err5xxMinuteKey[slot] = minute;
    err5xxMinuteValue[slot] = 0;
  }
  err5xxMinuteValue[slot] += 1;
}

function errors5xxLastHour(): number {
  const nowMinute = Math.floor(Date.now() / 60_000);
  let sum = 0;
  for (let i = 0; i < 60; i += 1) {
    if (err5xxMinuteKey[i] >= 0 && nowMinute - err5xxMinuteKey[i] < 60) sum += err5xxMinuteValue[i];
  }
  return sum;
}

// ── История (stats_daily.json) ───────────────────────────────────────────────

interface DailyRecord {
  users: number;
  requests: number;
  logins: number;
  newUsers: number;
  dau: number;
  activeUsers: { id: string; count: number; first: number; last: number }[];
  hours: number[];
  categories: Record<string, number>;
  status4xx: number;
  status5xx: number;
  barsErrors: Record<string, number>;
  barsExpired: number;
  notifications: number;
  /** Контент на конец дня. */
  homework: number;
  important: number;
  files: number;
  filesBytes: number;
  capturedAt: string;
}

const history = new JsonDocument<{ days: Record<string, DailyRecord> }>('stats_daily.json');

function readHistory(): Record<string, DailyRecord> {
  const doc = history.read() as { days?: Record<string, DailyRecord> };
  if (!doc || typeof doc !== 'object') return {};
  if (!doc.days || typeof doc.days !== 'object') doc.days = {};
  return doc.days;
}

function saveHistory(days: Record<string, DailyRecord>): void {
  history.stage({ days });
  history.save();
}

function pruneHistory(days: Record<string, DailyRecord>): void {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[key];
}

// ── Время ────────────────────────────────────────────────────────────────────

let cachedStamp = { day: '', hour: 0, at: 0 };
function moscowStamp(ts: number): { day: string; hour: number } {
  if (cachedStamp.day && ts - cachedStamp.at < 30_000) return cachedStamp;
  const m = toMoscow(new Date(ts));
  cachedStamp = { day: m.rawDate, hour: Number(m.time.slice(0, 2)), at: ts };
  return cachedStamp;
}

function lastDayKeys(count: number): string[] {
  const keys: string[] = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i -= 1) keys.push(toMoscow(new Date(now - i * 86_400_000)).rawDate);
  return keys;
}

/** Ключи `count` дней, заканчивая днём `day` включительно. */
function dayKeysEndingAt(day: string, count: number): string[] {
  const parts = day.split('.').map(Number);
  const base = parts.length === 3 ? Date.UTC(parts[0], parts[1] - 1, parts[2], 12) : Date.now();
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) keys.push(toMoscow(new Date(base - i * 86_400_000)).rawDate);
  return keys;
}

export function previousMoscowDayKey(now: number = Date.now()): string {
  return toMoscow(new Date(now - 86_400_000)).rawDate;
}

// ── Сброс дня в историю ──────────────────────────────────────────────────────

/** Фиксирует текущий день в stats_daily.json и очищает память. */
export function flushDay(): void {
  if (!memDay) return;
  const days = readHistory();

  const content = contentTotals();
  days[memDay] = {
    users: userStore.all().length,
    requests: memRequests,
    logins: memLogins,
    newUsers: 0,
    dau: memUsers.size,
    activeUsers: [...memUsers.entries()].map(([id, e]) => ({ id, count: e.count, first: e.first, last: e.last })),
    hours: [...memHours],
    categories: { ...memCategories },
    status4xx: mem4xx,
    status5xx: mem5xx,
    barsErrors: { ...memBarsErrors },
    barsExpired: memBarsExpired,
    notifications: memNotifications,
    homework: content.homework,
    important: content.important,
    files: content.files,
    filesBytes: content.filesBytes,
    capturedAt: new Date().toISOString(),
  };

  pruneHistory(days);
  saveHistory(days);
  resetMemory();
}

function resetMemory(): void {
  memDay = '';
  memRequests = 0;
  memLogins = 0;
  mem4xx = 0;
  mem5xx = 0;
  memBarsExpired = 0;
  memNotifications = 0;
  memUsers.clear();
  for (const k of Object.keys(memCategories)) delete memCategories[k];
  for (const k of Object.keys(memBarsErrors)) delete memBarsErrors[k];
  memHours.fill(0);
}

/** Проверяет смену московского дня и при необходимости пишет снапшот. */
function ensureDay(ts: number): string {
  const day = moscowStamp(ts).day;
  if (memDay && memDay !== day) flushDay();
  if (!memDay) memDay = day;
  return day;
}

// Плановый снапшот в 00:00 МСК (на случай, если ночью не было трафика).
const dayRollTimer = setInterval(() => {
  const day = moscowStamp(Date.now()).day;
  if (memDay && memDay !== day) flushDay();
}, 60_000);
dayRollTimer.unref?.();

let exitHookInstalled = false;

// ── Запись метрик ────────────────────────────────────────────────────────────

function categoryFor(url: string): Category {
  const p = url.split('?')[0];
  if (p === '/api/bootstrap') return 'bootstrap';
  if (p.startsWith('/api/schedule') || p.startsWith('/api/subjects')) return 'schedule';
  if (p.startsWith('/api/bars/')) return 'bars';
  if (p.startsWith('/api/mail')) return 'mail';
  if (p.startsWith('/api/homework')) return 'homework';
  if (p.startsWith('/api/important')) return 'important';
  if (p.startsWith('/api/files')) return 'files';
  if (p.startsWith('/api/notifications')) return 'notifications';
  if (p.startsWith('/api/auth')) return 'auth';
  return 'other';
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function recordActivity(userId: string | undefined, url = '', ts: number = Date.now()): void {
  if (!userId) return;
  ensureDay(ts);
  lastSeen.set(userId, ts);

  memRequests += 1;
  const stamp = moscowStamp(ts);
  if (stamp.hour >= 0 && stamp.hour < 24) memHours[stamp.hour] += 1;
  inc(memCategories, categoryFor(url));

  const entry = memUsers.get(userId) ?? { count: 0, first: ts, last: ts };
  entry.count += 1;
  entry.last = ts;
  memUsers.set(userId, entry);
}

export function recordLogin(userId: string | undefined, ts: number = Date.now()): void {
  if (!userId) return;
  ensureDay(ts);
  memLogins += 1;
}

export function recordNotification(ts: number = Date.now()): void {
  ensureDay(ts);
  memNotifications += 1;
}

/**
 * Подключает сбор: активность (onRequest) и метрики ответов (onSend).
 *
 * Вызывать после `authHook` (там уже стоит `request.userId`) и до маршрутов.
 */
export function setupActivityTracking(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (request.userId) recordActivity(request.userId, request.url);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const ts = Date.now();
    ensureDay(ts);

    const startedAt = (request as FastifyRequest & { hubStartedAt?: number }).hubStartedAt;
    if (typeof startedAt === 'number') pushLatency(Math.max(0, ts - startedAt));

    const status = reply.statusCode;
    if (status >= 500) {
      mem5xx += 1;
      bump5xx(ts);
    } else if (status >= 400) {
      mem4xx += 1;
    }

    const route = request.url.split('?')[0];

    // Успешный вход (в т.ч. продолжение 2FA) — из тела тянем userId.
    if (status === 200 && (route === '/api/auth/login' || route === '/api/auth/register' || route === '/api/auth/2fa')) {
      const text = typeof payload === 'string' ? payload : '';
      const match = text.match(/"userId"\s*:\s*"([^"]+)"/);
      if (match) recordLogin(match[1], ts);
    }

    // Ошибки БАРС по разделам и истёкшие сессии.
    if (route.startsWith('/api/bars/')) {
      const section = route.slice('/api/bars/'.length).split('/')[0] || 'other';
      if (status >= 400) inc(memBarsErrors, section);
    }
    if (typeof payload === 'string' && payload.includes('"error":"session_expired"')) {
      memBarsExpired += 1;
    }

    return payload;
  });

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', flushDay);
  }
}

// ── Контент (ДЗ, «Важное», файлы) с кэшем ────────────────────────────────────

interface FileScan {
  at: number;
  files: number;
  bytes: number;
  byKind: Record<string, number>;
  top: { name: string; bytes: number }[];
  dataBytes: number;
}

let fileScanCache: FileScan = { at: 0, files: 0, bytes: 0, byKind: {}, top: [], dataBytes: 0 };

function scanFiles(): FileScan {
  const now = Date.now();
  if (now - fileScanCache.at < FILE_SCAN_TTL_MS) return fileScanCache;

  const filesRoot = path.resolve(process.cwd(), 'data', 'files');
  const byKind: Record<string, number> = { photo: 0, pdf: 0, other: 0 };
  const all: { name: string; bytes: number }[] = [];
  let bytes = 0;

  try {
    if (fs.existsSync(filesRoot)) {
      for (const userDir of fs.readdirSync(filesRoot, { withFileTypes: true })) {
        if (!userDir.isDirectory()) continue;
        const dir = path.join(filesRoot, userDir.name);
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.meta.json')) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as {
              size?: number;
              mimeType?: string;
              originalName?: string;
            };
            const size = Number(meta.size) || 0;
            bytes += size;
            all.push({ name: meta.originalName || file.replace('.meta.json', ''), bytes: size });
            const mime = meta.mimeType || '';
            if (mime.startsWith('image/')) byKind.photo += 1;
            else if (mime === 'application/pdf') byKind.pdf += 1;
            else byKind.other += 1;
          } catch {
            // битый meta — пропускаем
          }
        }
      }
    }
  } catch {
    // каталога нет — нули
  }

  // Размер всего data/ — обходом (кэш на минуту, не на запрос).
  let dataBytes = 0;
  const dataRoot = path.resolve(process.cwd(), 'data');
  try {
    const stack = [dataRoot];
    while (stack.length) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else {
          try {
            dataBytes += fs.statSync(full).size;
          } catch {
            /* пропускаем */
          }
        }
      }
    }
  } catch {
    /* нет каталога */
  }

  fileScanCache = {
    at: now,
    files: all.length,
    bytes,
    byKind,
    top: all.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    dataBytes,
  };
  return fileScanCache;
}

function contentTotals(): {
  homework: number;
  important: number;
  files: number;
  filesBytes: number;
  byKind: Record<string, number>;
  top: { name: string; bytes: number }[];
} {
  const files = scanFiles();
  return {
    homework: homeworkStore.all().length,
    important: importantStore.all().length,
    files: files.files,
    filesBytes: files.bytes,
    byKind: files.byKind,
    top: files.top,
  };
}

// ── Агрегация ────────────────────────────────────────────────────────────────

export interface WindowTotals {
  newUsers: number;
  activeUsers: number;
  requests: number;
  logins: number;
}

export interface SeriesPoint {
  label: string;
  value: number;
  requests: number;
}

export interface StatsUserRow {
  name: string;
  group: string | null;
  registeredAt: string | null;
  lastSeenAt: number | null;
  barsAuthorized: boolean;
  telegram: boolean;
  notifications: boolean;
}

export interface StatsResponse {
  generatedAt: number;
  moscowNow: { date: string; time: string };
  period: Period;
  online: { windowMinutes: number; count: number }[];
  requestsPerMinute: number;
  liveBarsSessions: number;
  errorsLastHour: number;
  kpi: {
    users: number;
    barsAuthorized: number;
    withTelegram: number;
    notificationsOn: number;
    liveBars: number;
    expiredBars: number;
  };
  windows: { d1: WindowTotals; d7: WindowTotals; d30: WindowTotals };
  totalsByGroup: { group: string; users: number }[];
  series: SeriesPoint[];
  hours: number[];
  categories: { name: string; value: number }[];
  categoriesPeriod: { name: string; value: number }[];
  content: {
    homeworkTotal: number;
    homeworkPeriod: number;
    homeworkByGroup: { group: string; value: number }[];
    importantTotal: number;
    importantPeriod: number;
    filesTotal: number;
    filesBytes: number;
    filesAvgBytes: number;
    filesByKind: { name: string; value: number }[];
    filesTop: { name: string; bytes: number }[];
  };
  bars: {
    logins: number;
    expired: number;
    errorsBySection: { name: string; value: number }[];
    live: number;
    stale: number;
  };
  notifications: { sent: number };
  load: {
    uptimeSec: number;
    rssMb: number;
    heapMb: number;
    dataBytes: number;
    filesOnDisk: number;
    status4xx: number;
    status5xx: number;
    latencyP50: number;
    latencyP95: number;
    snapshots: number;
  };
  funnel: { step: string; count: number; percent: number }[];
  users: { total: number; offset: number; limit: number; rows: StatsUserRow[] };
  /** Дни, по которым истории нет (до внедрения снапшотов). */
  unavailableDays: string[];
}

function periodDays(period: Period): number {
  return PERIOD_DAYS[period] ?? 30;
}

function pickPeriod(value: unknown): Period {
  return value === '24h' || value === '7d' || value === '30d' ? value : '7d';
}

function displayName(user: StoredUser): string {
  const full = user.studentProfile?.fullName?.trim();
  if (full) return full;
  const parts = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return parts || 'Без имени';
}

function registeredDayKey(user: StoredUser): string | null {
  const at = Date.parse(user.createdAt ?? '');
  return Number.isNaN(at) ? null : toMoscow(new Date(at)).rawDate;
}

/** Собирает полный ответ для /dev-api/stats. */
export function getStats(
  periodRaw: unknown = '7d',
  usersQuery: { offset?: number; limit?: number } = {},
  options: { day?: string } = {},
): StatsResponse {
  const period = pickPeriod(periodRaw);
  const now = Date.now();
  ensureDay(now);

  const users = userStore.all();
  const days = readHistory();

  // Базовый день: для страницы — сегодня, для отчёта — конкретные сутки.
  const baseDay = options.day ?? memDay;

  const windowKeys: Record<string, string[]> = {
    d1: dayKeysEndingAt(baseDay, 1),
    d7: dayKeysEndingAt(baseDay, 7),
    d30: dayKeysEndingAt(baseDay, 30),
  };

  const registrations = new Map<string, number>();
  for (const u of users) {
    const day = registeredDayKey(u);
    if (day) registrations.set(day, (registrations.get(day) ?? 0) + 1);
  }

  /** Записи дня: из истории или из памяти (сегодня). */
  const dayRecord = (key: string): { dau: number; requests: number; logins: number; ids: string[] } => {
    if (key === memDay) return { dau: memUsers.size, requests: memRequests, logins: memLogins, ids: [...memUsers.keys()] };
    const rec = days[key];
    if (!rec) return { dau: 0, requests: 0, logins: 0, ids: [] };
    return { dau: rec.dau, requests: rec.requests, logins: rec.logins, ids: (rec.activeUsers ?? []).map((u) => u.id) };
  };

  const buildWindow = (keys: string[]): WindowTotals => {
    const set = new Set<string>();
    let requests = 0;
    let logins = 0;
    let newUsers = 0;
    for (const key of keys) {
      const rec = dayRecord(key);
      for (const id of rec.ids) set.add(id);
      requests += rec.requests;
      logins += rec.logins;
      newUsers += registrations.get(key) ?? 0;
    }
    return { newUsers, activeUsers: set.size, requests, logins };
  };

  const win = {
    d1: buildWindow(windowKeys.d1),
    d7: buildWindow(windowKeys.d7),
    d30: buildWindow(windowKeys.d30),
  };

  // Ряд для выбранного периода: 24ч — по часам базового дня, иначе — по дням.
  const selectedKeys = period === '24h' ? [baseDay] : dayKeysEndingAt(baseDay, periodDays(period));
  const baseHours =
    baseDay === memDay ? memHours : days[baseDay]?.hours ?? new Array(24).fill(0);
  const series: SeriesPoint[] = period === '24h'
    ? baseHours.map((v, i) => ({ label: `${i < 10 ? '0' : ''}${i}:00`, value: v, requests: v }))
    : selectedKeys.map((key) => {
        const rec = dayRecord(key);
        return { label: key, value: rec.dau, requests: rec.requests };
      });

  const unavailableDays = period === '24h' ? [] : selectedKeys.filter((k) => k !== memDay && !days[k]);

  // Активность по часам и категории — суммарно за 30 дней.
  const hours = new Array(24).fill(0);
  const categories: Record<string, number> = {};
  for (const key of windowKeys.d30) {
    if (key === memDay) {
      for (let i = 0; i < 24; i += 1) hours[i] += memHours[i];
      for (const [k, v] of Object.entries(memCategories)) categories[k] = (categories[k] ?? 0) + v;
    } else {
      const rec = days[key];
      if (!rec) continue;
      (rec.hours ?? []).forEach((v, i) => (hours[i] += v));
      for (const [k, v] of Object.entries(rec.categories ?? {})) categories[k] = (categories[k] ?? 0) + v;
    }
  }

  // Категории за выбранный период (для отчёта — за сутки).
  const categoriesPeriodMap: Record<string, number> = {};
  for (const key of selectedKeys) {
    const cats = key === memDay ? memCategories : days[key]?.categories;
    for (const [k, v] of Object.entries(cats ?? {})) categoriesPeriodMap[k] = (categoriesPeriodMap[k] ?? 0) + v;
  }

  // Контент.
  const content = contentTotals();
  const periodStart = selectedKeys[0];
  const homeworkAll = homeworkStore.all();
  const importantAll = importantStore.all();
  const byGroup = new Map<string, number>();
  for (const hw of homeworkAll) {
    const day = hw.createdAt ? toMoscow(new Date(hw.createdAt)).rawDate : '';
    if (periodStart && day && day >= periodStart) {
      byGroup.set(hw.groupName || '—', (byGroup.get(hw.groupName || '—') ?? 0) + 1);
    }
  }

  // Нагрузка и БАРС.
  const mem = process.memoryUsage();
  const snapshots = snapshotStore.checked().size;
  const barsKeys = lastDayKeys(7);
  const barsErrors: Record<string, number> = {};
  for (const key of barsKeys) {
    const rec = key === memDay ? { barsErrors: memBarsErrors } : days[key];
    for (const [k, v] of Object.entries(rec?.barsErrors ?? {})) barsErrors[k] = (barsErrors[k] ?? 0) + v;
  }

  const liveBars = users.filter((u) => Boolean(u.barsAuth) && u.authState !== 'AWAIT_LOGIN').length;
  const staleBars = users.length - liveBars;

  const errorsLastHour = errors5xxLastHour();

  // Онлайн.
  const online = ACTIVE_WINDOWS_MIN.map((windowMinutes) => {
    const threshold = now - windowMinutes * 60_000;
    let count = 0;
    for (const u of users) if ((lastSeen.get(u.userId) ?? 0) >= threshold) count += 1;
    return { windowMinutes, count };
  });

  // Запросов в минуту: среднее с начала московских суток.
  const moscow = toMoscow(new Date(now));
  const [hh, mm] = moscow.time.split(':').map(Number);
  const minutesSoFar = Math.max(1, (hh || 0) * 60 + (mm || 0));
  const requestsPerMinute = Math.round(((memRequests / minutesSoFar) + Number.EPSILON) * 100) / 100;

  // Топ групп по пользователям.
  const groupCount = new Map<string, number>();
  for (const u of users) {
    const g = u.groupName || u.studentProfile?.groupName;
    if (g) groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  }
  const totalsByGroup = [...groupCount.entries()]
    .map(([group, count]) => ({ group, users: count }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 10);

  // Воронка.
  const authorIds = new Set<string>();
  for (const hw of homeworkAll) if (hw.authorId) authorIds.add(hw.authorId);
  const registered = users.length;
  const barsEntered = users.filter((u) => Boolean(u.barsAuthedAt)).length;
  const firstHomework = users.filter((u) => authorIds.has(u.userId)).length;
  const notifOn = users.filter((u) => typeof u.telegramId === 'number' && u.notificationsEnabled !== false).length;
  const funnelBase = Math.max(1, registered);
  const funnel = [
    { step: 'Зарегистрировался', count: registered },
    { step: 'Вошёл в БАРС', count: barsEntered },
    { step: 'Создал первое ДЗ', count: firstHomework },
    { step: 'Включил уведомления', count: notifOn },
  ].map((s) => ({ ...s, percent: Math.round((s.count / funnelBase) * 100) }));

  // Пользователи (сортировка по последней активности, пагинация).
  const rowsAll: StatsUserRow[] = users
    .map((u) => ({
      name: displayName(u),
      group: u.groupName ?? u.studentProfile?.groupName ?? null,
      registeredAt: registeredDayKey(u),
      lastSeenAt: lastSeen.get(u.userId) ?? null,
      barsAuthorized: isBarsAuthorized(u),
      telegram: typeof u.telegramId === 'number',
      notifications: typeof u.telegramId === 'number' && u.notificationsEnabled !== false,
    }))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

  const offset = Math.max(0, Math.floor(usersQuery.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(usersQuery.limit ?? 50)));

  return {
    generatedAt: now,
    moscowNow: { date: moscow.rawDate, time: moscow.time },
    period,
    online,
    requestsPerMinute,
    liveBarsSessions: liveBars,
    errorsLastHour: errorsLastHour,
    kpi: {
      users: users.length,
      barsAuthorized: users.filter(isBarsAuthorized).length,
      withTelegram: users.filter((u) => typeof u.telegramId === 'number').length,
      notificationsOn: notifOn,
      liveBars,
      expiredBars: staleBars,
    },
    windows: win,
    totalsByGroup,
    series,
    hours,
    categories: CATEGORY_ORDER.map((name) => ({ name, value: categories[name] ?? 0 })).filter((c) => c.value > 0),
    categoriesPeriod: CATEGORY_ORDER.map((name) => ({ name, value: categoriesPeriodMap[name] ?? 0 })).filter((c) => c.value > 0),
    content: {
      homeworkTotal: homeworkAll.length,
      homeworkPeriod: [...byGroup.values()].reduce((a, b) => a + b, 0),
      homeworkByGroup: [...byGroup.entries()].map(([group, value]) => ({ group, value })).sort((a, b) => b.value - a.value).slice(0, 5),
      importantTotal: importantAll.length,
      importantPeriod: importantAll.filter((m) => (periodStart ? toMoscow(new Date(m.createdAt)).rawDate >= periodStart : true)).length,
      filesTotal: content.files,
      filesBytes: content.filesBytes,
      filesAvgBytes: content.files > 0 ? Math.round(content.filesBytes / content.files) : 0,
      filesByKind: Object.entries(content.byKind).map(([name, value]) => ({ name, value })),
      filesTop: content.top,
    },
    bars: {
      logins: win.d30.logins,
      expired: memBarsExpired + barsKeys.reduce((sum, k) => sum + (days[k]?.barsExpired ?? 0), 0),
      errorsBySection: Object.entries(barsErrors).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      live: liveBars,
      stale: staleBars,
    },
    notifications: { sent: memNotifications },
    load: {
      uptimeSec: Math.floor(process.uptime()),
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      dataBytes: scanFiles().dataBytes,
      filesOnDisk: content.files,
      status4xx: mem4xx,
      status5xx: mem5xx,
      latencyP50,
      latencyP95,
      snapshots,
    },
    funnel,
    users: { total: rowsAll.length, offset, limit, rows: rowsAll.slice(offset, offset + limit) },
    unavailableDays,
  };
}

// ── Ежедневный отчёт (файл) ──────────────────────────────────────────────────

export interface DailyReport {
  date: string;
  generatedAt: string;
  totals: { users: number; barsAuthorized: number; withTelegram: number; notificationsOn: number };
  day: {
    dau: number;
    requests: number;
    logins: number;
    newUsers: number;
    hours: number[];
    categories: Record<string, number>;
    users: { name: string; group: string | null; requests: number; first: number; last: number }[];
  };
  week: WindowTotals;
  month: WindowTotals;
  hours30: number[];
  categories30: Record<string, number>;
  series30: { date: string; dau: number; requests: number; logins: number; newUsers: number }[];
  content: { homework: number; important: number; files: number; filesBytes: number };
}

/** Данные отчёта за день (без графиков) — для файла и таблицы в Telegram. */
export function buildDailyReport(day: string = previousMoscowDayKey()): DailyReport {
  const users = userStore.all();
  const days = readHistory();
  const rec = days[day];
  const content = contentTotals();

  const userRows = (rec?.activeUsers ?? []).map((entry) => {
    const u = users.find((x) => x.userId === entry.id);
    return {
      name: u ? displayName(u) : 'неизвестно',
      group: u ? u.groupName ?? u.studentProfile?.groupName ?? null : null,
      requests: entry.count,
      first: entry.first,
      last: entry.last,
    };
  });

  const registrations = new Map<string, number>();
  for (const u of users) {
    const d = registeredDayKey(u);
    if (d) registrations.set(d, (registrations.get(d) ?? 0) + 1);
  }

  const monthKeys = lastDayKeys(30);
  const weekKeys = lastDayKeys(7);
  const sumRec = (keys: string[], field: 'requests' | 'logins'): number =>
    keys.reduce((sum, key) => sum + (days[key]?.[field] ?? 0), 0);

  return {
    date: day,
    generatedAt: new Date().toISOString(),
    totals: {
      users: users.length,
      barsAuthorized: users.filter(isBarsAuthorized).length,
      withTelegram: users.filter((u) => typeof u.telegramId === 'number').length,
      notificationsOn: users.filter((u) => typeof u.telegramId === 'number' && u.notificationsEnabled !== false).length,
    },
    day: {
      dau: rec?.dau ?? 0,
      requests: rec?.requests ?? 0,
      logins: rec?.logins ?? 0,
      newUsers: registrations.get(day) ?? 0,
      hours: rec?.hours ?? new Array(24).fill(0),
      categories: rec?.categories ?? {},
      users: userRows,
    },
    week: { newUsers: 0, activeUsers: 0, requests: sumRec(weekKeys, 'requests'), logins: sumRec(weekKeys, 'logins') },
    month: { newUsers: 0, activeUsers: 0, requests: sumRec(monthKeys, 'requests'), logins: sumRec(monthKeys, 'logins') },
    hours30: sumHours(days, monthKeys),
    categories30: sumCategories(days, monthKeys),
    series30: monthKeys.map((key) => ({
      date: key,
      dau: days[key]?.dau ?? 0,
      requests: days[key]?.requests ?? 0,
      logins: days[key]?.logins ?? 0,
      newUsers: registrations.get(key) ?? 0,
    })),
    content: { homework: content.homework, important: content.important, files: content.files, filesBytes: content.filesBytes },
  };
}

function sumHours(days: Record<string, DailyRecord>, keys: string[]): number[] {
  const out = new Array(24).fill(0);
  for (const key of keys) (days[key]?.hours ?? []).forEach((v, i) => (out[i] += v));
  return out;
}

function sumCategories(days: Record<string, DailyRecord>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) for (const [k, v] of Object.entries(days[key]?.categories ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

// ── Доступ ───────────────────────────────────────────────────────────────────

export function isDevTokenValid(provided: string): boolean {
  const expected = process.env.DEV_STATS_TOKEN?.trim() ?? '';
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isDevStatsEnabled(): boolean {
  return Boolean(process.env.DEV_STATS_TOKEN?.trim());
}
