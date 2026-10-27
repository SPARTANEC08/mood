/**
 * Ежедневный срез статистики и push-уведомление админам в 00:00 МСК.
 *
 * ── Что описывает отчёт ─────────────────────────────────────────────────────
 *
 * Скользящее окно 24 часа, заканчивающееся в 00:00 МСК: ровно закончившиеся
 * сутки. «Состояние сейчас» берётся из последнего минутного сэмпла (23:59),
 * иначе в ночном отчёте всегда стояли бы нули.
 *
 * ── Что сохраняется ─────────────────────────────────────────────────────────
 *
 * HTML-файл и JSON-срез в `db/data/reports/` — из них собирается история на
 * экране статистики. Файл в Telegram больше не отправляется: админы получают
 * push со ссылкой на статистику.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getStats, type StatsResponse } from '../../server/devStats.ts';
import { listAdminUsers } from '../../utils/adminAuth.ts';
import { saveDailyStats } from '../admin/statsHistory.ts';
import { sendBroadcastPush } from './webPush.ts';
import { renderReportHtml } from './reportHtml.ts';

const REPORTS_DIR = path.resolve(process.cwd(), 'db', 'data', 'reports');
const KEEP_REPORTS = 30;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

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
  return midnightMsk - MSK_OFFSET_MS;
}

/** День, который описывает окно (по его последней минуте). */
function dayLabel(windowEnd: number): string {
  const last = new Date(windowEnd - MINUTE_MS);
  const msk = new Date(last.getTime() + MSK_OFFSET_MS);
  const dd = String(msk.getUTCDate()).padStart(2, '0');
  const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${msk.getUTCFullYear()}.${mm}.${dd}`;
}

/**
 * Сохраняет HTML-отчёт и подчищает старые.
 *
 * JSON-срезы не трогаем: это история статистики, а не хвосты прошлых версий.
 */
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
      fs.rmSync(path.join(REPORTS_DIR, `stats-${old}.json`), { force: true });
    }
  } catch {
    // Уборка не критична.
  }
}

export interface SendReportOptions {
  /** Сохранять ли отчёт в историю. Автоотчёт — да. */
  keep?: boolean;
  /** Подпись под шапкой. */
  note?: string;
  /** Конец окна: для автоотчёта — полночь МСК. */
  windowEnd?: number;
}

/** Формирует срез, сохраняет и отправляет push админам. */
export async function sendDailyReport(options: SendReportOptions = {}): Promise<boolean> {
  const windowEnd = options.windowEnd ?? windowEndForDailyReport();
  const stats: StatsResponse = getStats({ windowEnd });
  const fileName = `stats-${dayLabel(windowEnd)}.html`;
  const html = renderReportHtml(stats, options.note);

  if (options.keep !== false) {
    writeReportFile(fileName, html);
    saveDailyStats(stats, dayLabel(windowEnd).replace(/\./g, '-'));
  }

  const admins = listAdminUsers().filter(
    (user) => user.pushEnabled !== false && (user.pushSubscriptions?.length ?? 0) > 0,
  );

  let sent = 0;
  for (const admin of admins) {
    try {
      const ok = await sendBroadcastPush(
        admin,
        'Отчёт за вчера готов. Откройте статистику в приложении.',
        '/?tab=profile&admin=stats',
        'report',
      );
      if (ok) sent += 1;
    } catch {
      // Один недоступный админ не должен мешать остальным.
    }
  }

  console.log(
    `[DailyReport] срез ${dayLabel(windowEnd)} сохранён, push админам: ${sent}/${admins.length}.`,
  );
  return sent > 0;
}

/**
 * Планировщик на 00:00 МСК. Таймер пересоздаётся после каждого запуска, чтобы
 * расписание не «съезжало» после рестарта.
 */
export function startDailyReport(): void {
  const schedule = (): void => {
    const delay = msUntilNextMoscowMidnight();
    const timer = setTimeout(() => {
      void sendDailyReport()
        .catch((err: unknown) =>
          console.error('[DailyReport] ошибка:', err instanceof Error ? err.message : err),
        )
        .finally(schedule);
    }, delay);
    timer.unref?.();

    console.log(`[DailyReport] следующий срез через ${Math.round(delay / 60_000)} мин (00:00 МСК).`);
  };

  schedule();
}
