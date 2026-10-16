/**
 * Ежедневный отчёт владельцу: в конце дня (00:00 МСК) формируется автономный
 * HTML-файл (срез страницы /dev/ — тот же дизайн и метрики, без JS) и отдельный
 * JSON с данными; оба уходят в Telegram, плюс краткая таблица сообщением.
 *
 * Получатель ровно один — `DAILY_REPORT_TELEGRAM_ID`. Без переменной молчим.
 *
 * Бот передаётся аргументом (`startDailyReport(bot)`), поэтому циклического
 * импорта с telegramService нет.
 */

import fs from 'node:fs';
import path from 'node:path';

import { InputFile, type Bot } from 'grammy';

import {
  buildDailyReport,
  flushDay,
  getStats,
  previousMoscowDayKey,
  type DailyReport,
  type StatsResponse,
} from '../../server/devStats.ts';
import { renderReportHtml } from './reportHtml.ts';

/** Каталог файлов отчётов. */
const REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');

/** Сколько дней отчётов хранить (по паре файлов на день). */
const KEEP_REPORTS = 400;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function recipientId(): number | null {
  const raw = process.env.DAILY_REPORT_TELEGRAM_ID?.trim();
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/** Сколько миллисекунд до следующих 00:00 по Москве. */
export function msUntilNextMoscowMidnight(now: number = Date.now()): number {
  const nowMsk = now + MSK_OFFSET_MS;
  const nextMsk = Math.floor(nowMsk / DAY_MS) * DAY_MS + DAY_MS;
  return nextMsk - nowMsk + 500;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(day: string): string {
  const parts = day.split('.');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : day;
}

function padRight(value: string, width: number): string {
  const v = String(value);
  return v.length >= width ? v : v + ' '.repeat(width - v.length);
}

function padLeft(value: string, width: number): string {
  const v = String(value);
  return v.length >= width ? v : ' '.repeat(width - v.length) + v;
}

/** Компактная таблица-сообщение за прошедший день. */
export function formatReportTable(report: DailyReport, note?: string): string {
  const t = report.totals;
  const d = report.day;
  const peakHour = d.hours.indexOf(Math.max(0, ...d.hours));

  const head = [`📊 <b>Hub — отчёт за ${esc(fmtDate(report.date))}</b>`, note ? `<i>${esc(note)}</i>` : '']
    .filter(Boolean)
    .join('\n');

  const summary = [
    ['Пользователей', t.users],
    ['в БАРС / с TG', `${t.barsAuthorized} / ${t.withTelegram}`],
    ['Активных (DAU)', d.dau],
    ['Запросов', d.requests],
    ['Входов', d.logins],
    ['Новых', d.newUsers],
    ['Пик активности', d.requests > 0 ? `${peakHour}:00 (${d.hours[peakHour]})` : '—'],
  ] as const;

  const summaryRows = summary.map(([label, value]) => `${padRight(label, 18)}${padLeft(String(value), 12)}`).join('\n');

  const tail = report.series30.slice(-7);
  const dayHeader = `${padRight('Дата', 12)}${padLeft('DAU', 5)}${padLeft('Запр', 7)}${padLeft('Вход', 6)}`;
  const dayRows = tail
    .map((s) => `${padRight(fmtDate(s.date), 12)}${padLeft(String(s.dau), 5)}${padLeft(String(s.requests), 7)}${padLeft(String(s.logins), 6)}`)
    .join('\n');
  const weekRow = `${padRight('7 дней', 12)}${padLeft('', 5)}${padLeft(String(report.week.requests), 7)}${padLeft(String(report.week.logins), 6)}`;

  const top = d.users.slice(0, 10);
  const userRows = top.length ? top.map((u) => `${padRight(u.name.slice(0, 22), 24)}${padLeft(String(u.requests), 6)}`).join('\n') : 'нет активности';

  return [
    head,
    `<pre>${esc(summaryRows)}</pre>`,
    `<b>Последние 7 дней</b>\n<pre>${esc(dayHeader)}\n${esc(dayRows)}\n${esc(weekRow)}</pre>`,
    `<b>Кто активнее (запросов за день)</b>\n<pre>${esc(userRows)}</pre>`,
  ].join('\n\n');
}

/** Пишет HTML (срез страницы) и JSON (данные). Возвращает имена файлов. */
export function writeReportFiles(day: string, stats: StatsResponse, note?: string): { html: string; json: string } {
  fs.mkdirSync(REPORTS_DIR, { recursive: true, mode: 0o700 });

  const jsonName = `stats-${day}.json`;
  const htmlName = `stats-${day}.html`;

  fs.writeFileSync(path.join(REPORTS_DIR, jsonName), JSON.stringify(stats, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.writeFileSync(path.join(REPORTS_DIR, htmlName), renderReportHtml(stats, note), { encoding: 'utf-8', mode: 0o600 });

  try {
    const days = Array.from(
      new Set(
        fs
          .readdirSync(REPORTS_DIR)
          .map((name) => name.match(/^stats-(.+)\.(json|html)$/)?.[1])
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();
    for (const old of days.slice(0, Math.max(0, days.length - KEEP_REPORTS))) {
      fs.rmSync(path.join(REPORTS_DIR, `stats-${old}.json`), { force: true });
      fs.rmSync(path.join(REPORTS_DIR, `stats-${old}.html`), { force: true });
    }
  } catch {
    // уборка не критична
  }

  return { html: htmlName, json: jsonName };
}

/** Формирует файлы и отправляет отчёт получателю. */
export async function sendDailyReport(bot: Bot, options: { day?: string; note?: string } = {}): Promise<boolean> {
  const chatId = recipientId();
  if (!chatId) {
    console.warn('[DailyReport] DAILY_REPORT_TELEGRAM_ID не задан — отчёт не отправлен.');
    return false;
  }

  const day = options.day ?? previousMoscowDayKey();
  // Фиксируем завершившийся день в stats_daily.json до сборки среза.
  flushDay();

  // HTML/JSON — снимок страницы статистики за прошедшие сутки (период 24ч).
  const stats = getStats('24h', { offset: 0, limit: 200 }, { day });
  const files = writeReportFiles(day, stats, options.note);

  // Сообщение — короткая сводка за прошедший день.
  const report = buildDailyReport(day);

  await bot.api.sendMessage(chatId, formatReportTable(report, options.note), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

  await bot.api.sendDocument(
    chatId,
    new InputFile(Buffer.from(renderReportHtml(stats, options.note), 'utf-8'), files.html),
    { caption: `Срез статистики за ${fmtDate(day)} — открой файл в браузере.` },
  );

  await bot.api.sendDocument(
    chatId,
    new InputFile(Buffer.from(JSON.stringify(stats, null, 2), 'utf-8'), files.json),
    { caption: `Данные за ${fmtDate(day)} (JSON).` },
  );

  console.log(`[DailyReport] отчёт за ${day} отправлен (${files.html}, ${files.json}).`);
  return true;
}

/**
 * Запускает ежедневную отправку в 00:00 МСК. Таймер пересоздаётся после каждой
 * отправки (не setInterval): расписание не «съезжает» после рестарта.
 */
export function startDailyReport(bot: Bot): void {
  if (!recipientId()) {
    console.log('[DailyReport] выключен: не задан DAILY_REPORT_TELEGRAM_ID.');
    return;
  }

  const schedule = (): void => {
    const delay = msUntilNextMoscowMidnight();
    const timer = setTimeout(() => {
      void sendDailyReport(bot)
        .catch((err: unknown) => console.error('[DailyReport] ошибка отправки:', err instanceof Error ? err.message : err))
        .finally(schedule);
    }, delay);
    timer.unref?.();

    console.log(`[DailyReport] следующий отчёт через ${Math.round(delay / 60_000)} мин (00:00 МСК).`);
  };

  schedule();
}
