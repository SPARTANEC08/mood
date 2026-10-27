/**
 * Ежедневный отчёт владельцу — в 00:00 МСК, файлом в Telegram.
 *
 * ── Что описывает отчёт ─────────────────────────────────────────────────────
 *
 * Скользящее окно 24 часа, заканчивающееся в 00:00 МСК: то есть ровно
 * закончившиеся сутки. «Состояние сейчас» в таком отчёте берётся из последнего
 * минутного сэмпла (23:59), иначе в ночном отчёте всегда стояли бы нули.
 *
 * ── Что сохраняется ─────────────────────────────────────────────────────────
 *
 * Автоматический отчёт сохраняется файлом в `db/data/reports/` — из него
 * собирается история в админ-меню бота. Отчёт, отправленный кнопкой «Отчёт
 * сейчас», НЕ сохраняется: он нужен здесь и сейчас, а не в архиве.
 *
 * Получатель ровно один — `DAILY_REPORT_TELEGRAM_ID`. Без переменной молчим.
 */

import fs from 'node:fs';
import path from 'node:path';

import { InputFile, type Bot } from 'grammy';

import { getStats, type StatsResponse } from '../../server/devStats.ts';
import { saveDailyStats } from '../admin/statsHistory.ts';
import { renderReportHtml } from './reportHtml.ts';

/** Каталог файлов отчётов. */
const REPORTS_DIR = path.resolve(process.cwd(), 'db', 'data', 'reports');

/** Сколько дней отчётов хранить. */
const KEEP_REPORTS = 30;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

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

/** Конец окна автоотчёта: ближайшая прошедшая полночь по Москве. */
function windowEndForDailyReport(now: number = Date.now()): number {
  const nowMsk = now + MSK_OFFSET_MS;
  const midnightMsk = Math.floor(nowMsk / DAY_MS) * DAY_MS;
  // Если ровно полночь — берём её же, иначе предыдущую.
  return (nowMsk === midnightMsk ? midnightMsk : midnightMsk) - MSK_OFFSET_MS;
}

/** День, который описывает окно (по его последней минуте). */
function dayLabel(windowEnd: number): string {
  const last = new Date(windowEnd - MINUTE_MS);
  const msk = new Date(last.getTime() + MSK_OFFSET_MS);
  const dd = String(msk.getUTCDate()).padStart(2, '0');
  const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${msk.getUTCFullYear()}.${mm}.${dd}`;
}

/** Сохраняет HTML-отчёт в каталог и подчищает старые. */
export function writeReportFile(fileName: string, html: string): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(REPORTS_DIR, fileName), html, { encoding: 'utf-8', mode: 0o600 });

  try {
    const days = fs
      .readdirSync(REPORTS_DIR)
      .map((name) => name.match(/^stats-(.+)\.html$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .sort();

    for (const old of days.slice(0, Math.max(0, days.length - KEEP_REPORTS))) {
      fs.rmSync(path.join(REPORTS_DIR, `stats-${old}.html`), { force: true });
    }
    // Старые JSON-хвосты прошлых версий.
    for (const name of fs.readdirSync(REPORTS_DIR)) {
      if (name.endsWith('.json')) fs.rmSync(path.join(REPORTS_DIR, name), { force: true });
    }
  } catch {
    // Уборка не критична.
  }
}

export interface SendReportOptions {
  /**
   * Сохранять ли отчёт в БД. Автоотчёт — да (это история), отчёт по кнопке — нет.
   */
  keep?: boolean;
  /** Подпись под шапкой. */
  note?: string;
  /** Конец окна: для автоотчёта — полночь МСК, для кнопки — сейчас. */
  windowEnd?: number;
}

/** Формирует отчёт, при необходимости сохраняет и отправляет файлом. */
export async function sendDailyReport(bot: Bot, options: SendReportOptions = {}): Promise<boolean> {
  const windowEnd = options.windowEnd ?? windowEndForDailyReport();
  const stats: StatsResponse = getStats({ windowEnd });
  const fileName = `stats-${dayLabel(windowEnd)}.html`;
  const html = renderReportHtml(stats, options.note);

  /*
   * Срез дня сохраняется независимо от Telegram.
   *
   * История статистики в PWA не должна зависеть от мессенджера: отказ от
   * Telegram — вопрос времени, а данные за прошлые дни нужны уже сейчас.
   * Отчёт по кнопке (keep === false) в историю не пишется.
   */
  if (options.keep !== false) {
    writeReportFile(fileName, html);
    saveDailyStats(stats, dayLabel(windowEnd).replace(/\./g, '-'));
  }

  const chatId = recipientId();
  if (!chatId) {
    console.log('[DailyReport] срез дня сохранён, Telegram-получатель не задан.');
    return false;
  }

  // Кнопка «Закрыть» убирает сообщение из переписки: иначе ежедневные отчёты
  // копятся и забивают чат.
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(html, 'utf-8'), fileName), {
    reply_markup: {
      inline_keyboard: [[{ text: '✕ Закрыть', callback_data: 'msg_close' }]],
    },
  });

  console.log(
    `[DailyReport] отчёт за ${dayLabel(windowEnd)} отправлен файлом (${fileName})${options.keep === false ? ', в базе не сохранён' : ''}.`,
  );
  return true;
}

/**
 * Запускает ежедневную отправку в 00:00 МСК. Таймер пересоздаётся после каждой
 * отправки (не setInterval): расписание не «съезжает» после рестарта.
 */
export function startDailyReport(bot: Bot): void {
  /*
   * Планировщик работает всегда: в полночь нужно сохранить срез для истории
   * статистики, даже если Telegram-получатель не задан. Отправка файла —
   * отдельная ветка внутри sendDailyReport.
   */
  const schedule = (): void => {
    const delay = msUntilNextMoscowMidnight();
    const timer = setTimeout(() => {
      void sendDailyReport(bot)
        .catch((err: unknown) =>
          console.error('[DailyReport] ошибка отправки:', err instanceof Error ? err.message : err),
        )
        .finally(schedule);
    }, delay);
    timer.unref?.();

    console.log(`[DailyReport] следующий отчёт через ${Math.round(delay / 60_000)} мин (00:00 МСК).`);
  };

  schedule();
}
