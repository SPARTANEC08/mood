/**
 * История статистики для встроенной админки.
 *
 * Живые цифры за сутки даёт `getStats()` из devStats. Для прошлых дней источник
 * — дневные срезы в `db/data/reports/`:
 *   - новые: `stats-YYYY.MM.DD.json` (пишем при ночном отчёте);
 *   - старые: `stats-YYYY.MM.DD.html` — разбираем один раз через cheerio.
 *
 * Разбор HTML — best-effort: формат наш, но если день не разобрался, лучше
 * показать «нет данных», чем уронить всю страницу статистики.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as cheerio from 'cheerio';

import type { StatsResponse } from '../../server/devStats.ts';

const REPORTS_DIR = path.resolve(process.cwd(), 'db', 'data', 'reports');

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyStats {
  /** YYYY-MM-DD по Москве. */
  date: string;
  requests: number;
  visits: number;
  maxOnline: number;
  newBarsSessions: number;
  currentBars: number;
  currentOnline: number;
  homework: { created: number; deleted: number; total: number };
  important: { created: number; deleted: number; total: number };
  platforms: { ios: number; android: number; web: number; unknown: number };
  files: { totalFiles: number; totalBytes: number };
  sessionsCount: number;
  /** Почасовые значения, если они были в срезе. */
  hours: Array<{ label: string; value: number }> | null;
  source: 'json' | 'html';
}

export interface StatsPeriodSummary {
  days: DailyStats[];
  totals: {
    requests: number;
    visits: number;
    maxOnline: number;
    newBarsSessions: number;
    homeworkCreated: number;
    homeworkDeleted: number;
    importantCreated: number;
    importantDeleted: number;
  };
  /** Последний известный срез: «сейчас» и накопительные величины. */
  latest: DailyStats | null;
}

/** Кэш разобранных файлов: повторный заход на экран не читает диск заново. */
const cache = new Map<string, { mtimeMs: number; data: DailyStats }>();

/** MSK-дата из миллисекунд → YYYY-MM-DD. */
export function mskDate(ms: number = Date.now()): string {
  const msk = new Date(ms + MSK_OFFSET_MS);
  const year = msk.getUTCFullYear();
  const month = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const day = String(msk.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const base = Date.UTC(year, month - 1, day) + days * DAY_MS;
  const shifted = new Date(base);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Все дни месяца, начиная с первого и заканчивая сегодняшним (или концом месяца). */
export function monthDates(date: string): string[] {
  const [year, month] = date.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = mskDate();
  const out: string[] = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const current = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (current > today) break;
    out.push(current);
  }

  return out;
}

function jsonPath(date: string): string {
  return path.join(REPORTS_DIR, `stats-${date.replace(/-/g, '.')}.json`);
}

function htmlPath(date: string): string {
  return path.join(REPORTS_DIR, `stats-${date.replace(/-/g, '.')}.html`);
}

/** Сохраняет срез дня. Вызывается из ночного отчёта. */
export function saveDailyStats(stats: StatsResponse, date: string = mskDate(stats.windowEnd)): void {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true, mode: 0o700 });
    const data = dailyStatsFromResponse(stats, date);
    fs.writeFileSync(jsonPath(date), JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    cache.delete(date);
  } catch {
    // История — не критичный путь: отчёт уже ушёл, файл можно потерять.
  }
}

export function dailyStatsFromResponse(stats: StatsResponse, date: string): DailyStats {
  const w = stats.window;

  return {
    date,
    requests: w.requests,
    visits: w.visits,
    maxOnline: w.maxOnline,
    newBarsSessions: w.newBarsSessions,
    currentBars: stats.current.barsSessions,
    currentOnline: stats.current.online,
    homework: { ...w.homework },
    important: { ...w.important },
    platforms: { ...stats.platforms },
    files: { totalFiles: stats.files.totalFiles, totalBytes: stats.files.totalBytes },
    sessionsCount: stats.sessions.length,
    hours: stats.requestsByHour.map((item) => ({ label: item.label, value: item.value })),
    source: 'json',
  };
}

/** Дневной срез: сначала JSON, затем HTML (старые отчёты). */
export function readDailyStats(date: string): DailyStats | null {
  const file = fs.existsSync(jsonPath(date)) ? jsonPath(date) : htmlPath(date);

  try {
    const stat = fs.statSync(file);
    const cached = cache.get(date);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

    const raw = fs.readFileSync(file, 'utf-8');
    const data = file.endsWith('.json') ? parseJson(raw, date) : parseHtml(raw, date);
    if (!data) return null;

    cache.set(date, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

function parseJson(raw: string, date: string): DailyStats | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DailyStats>;
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      date,
      requests: number(parsed.requests),
      visits: number(parsed.visits),
      maxOnline: number(parsed.maxOnline),
      newBarsSessions: number(parsed.newBarsSessions),
      currentBars: number(parsed.currentBars),
      currentOnline: number(parsed.currentOnline),
      homework: {
        created: number(parsed.homework?.created),
        deleted: number(parsed.homework?.deleted),
        total: number(parsed.homework?.total),
      },
      important: {
        created: number(parsed.important?.created),
        deleted: number(parsed.important?.deleted),
        total: number(parsed.important?.total),
      },
      platforms: {
        ios: number(parsed.platforms?.ios),
        android: number(parsed.platforms?.android),
        web: number(parsed.platforms?.web),
        unknown: number(parsed.platforms?.unknown),
      },
      files: {
        totalFiles: number(parsed.files?.totalFiles),
        totalBytes: number(parsed.files?.totalBytes),
      },
      sessionsCount: number(parsed.sessionsCount),
      hours: Array.isArray(parsed.hours)
        ? parsed.hours.map((item) => ({ label: String(item.label ?? ''), value: number(item.value) }))
        : null,
      source: 'json',
    };
  } catch {
    return null;
  }
}

/** Разбор старого HTML-отчёта. */
export function parseHtml(html: string, date: string): DailyStats | null {
  try {
    const $ = cheerio.load(html);
    if ($('.card').length === 0) return null;

    const cards = new Map<string, { value: string; hint: string }>();
    $('.card').each((_, element) => {
      const card = $(element);
      const key = card.find('.k').first().text().trim();
      if (!key) return;
      cards.set(key, {
        value: card.find('.v').first().text().trim(),
        hint: card.find('.hint').first().text().trim(),
      });
    });

    const valueOf = (label: string): number => number(cards.get(label)?.value);
    const pair = (label: string): { created: number; deleted: number } => {
      const raw = cards.get(label)?.value ?? '';
      const [created, deleted] = raw.split('/').map((part) => number(part));
      return { created, deleted };
    };
    const totalOf = (label: string): number => {
      const hint = cards.get(label)?.hint ?? '';
      const match = /всего сейчас:\s*(\d+)/.exec(hint);
      return match ? Number(match[1]) : 0;
    };

    const homework = pair('ДЗ создано / удалено');
    const important = pair('Важное создано / удалено');

    const hours: Array<{ label: string; value: number }> = [];
    $('.chart i').each((_, element) => {
      const title = $(element).attr('title') ?? '';
      const match = /^(.*?)\s*—\s*(\d+)\s*$/.exec(title);
      if (match) hours.push({ label: match[1].trim(), value: Number(match[2]) });
    });

    const filesHeading = $('h2')
      .filter((_, element) => $(element).text().trim().startsWith('Файлы'))
      .first()
      .text();
    const filesMatch = /Файлы\s*·\s*(\d+)\s*шт,\s*(.+)$/.exec(filesHeading.trim());

    const sessionsHeading = $('h2')
      .filter((_, element) => $(element).text().trim().startsWith('Сессии БАРС'))
      .first()
      .text();
    const sessionsMatch = /(\d+)\s*$/.exec(sessionsHeading.trim());

    return {
      date,
      requests: valueOf('Запросов'),
      visits: valueOf('Заходов в приложение'),
      maxOnline: valueOf('Максимум онлайна'),
      newBarsSessions: valueOf('Новых сессий БАРС'),
      currentBars: valueOf('Активных сессий БАРС'),
      currentOnline: valueOf('Онлайн (±5 мин)'),
      homework: { ...homework, total: totalOf('ДЗ создано / удалено') },
      important: { ...important, total: totalOf('Важное создано / удалено') },
      platforms: {
        ios: valueOf('🍏 iOS'),
        android: valueOf('🤖 Android'),
        web: valueOf('🌐 Web'),
        unknown: valueOf('❓ Неизвестно'),
      },
      files: {
        totalFiles: filesMatch ? number(filesMatch[1]) : 0,
        totalBytes: filesMatch ? parseSize(filesMatch[2]) : 0,
      },
      sessionsCount: sessionsMatch ? number(sessionsMatch[1]) : 0,
      hours: hours.length > 0 ? hours : null,
      source: 'html',
    };
  } catch {
    return null;
  }
}

/** «1,2 МБ» / «340 КБ» → байты (приблизительно, для старых отчётов). */
function parseSize(raw: string): number {
  const match = /([\d.,]+)\s*(КБ|МБ|ГБ)/i.exec(raw.trim());
  if (!match) return 0;

  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return 0;

  const unit = match[2].toUpperCase();
  if (unit === 'ГБ') return Math.round(value * 1024 * 1024 * 1024);
  if (unit === 'МБ') return Math.round(value * 1024 * 1024);
  return Math.round(value * 1024);
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Дни, за которые есть срезы (JSON или HTML), новые сверху. */
export function availableDates(): string[] {
  try {
    const dates = new Set<string>();

    for (const name of fs.readdirSync(REPORTS_DIR)) {
      const match = /^stats-(\d{4})[.-](\d{2})[.-](\d{2})\.(json|html)$/.exec(name);
      if (match) dates.add(`${match[1]}-${match[2]}-${match[3]}`);
    }

    return [...dates].sort().reverse();
  } catch {
    return [];
  }
}

export function summarize(days: DailyStats[]): StatsPeriodSummary {
  const totals = {
    requests: 0,
    visits: 0,
    maxOnline: 0,
    newBarsSessions: 0,
    homeworkCreated: 0,
    homeworkDeleted: 0,
    importantCreated: 0,
    importantDeleted: 0,
  };

  for (const day of days) {
    totals.requests += day.requests;
    totals.visits += day.visits;
    totals.maxOnline = Math.max(totals.maxOnline, day.maxOnline);
    totals.newBarsSessions += day.newBarsSessions;
    totals.homeworkCreated += day.homework.created;
    totals.homeworkDeleted += day.homework.deleted;
    totals.importantCreated += day.important.created;
    totals.importantDeleted += day.important.deleted;
  }

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));

  return {
    days: sorted,
    totals,
    latest: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
  };
}
