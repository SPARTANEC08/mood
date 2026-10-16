/**
 * Отправить отчёт «прямо сейчас» — из ЖИВОГО среза работающего процесса.
 *
 * Важно: счётчики статистики хранятся в памяти процесса бота, поэтому отдельный
 * скрипт (и `emit` из другого процесса) их не видит. Здесь мы не считаем сами, а
 * забираем готовый ответ у API (`/dev-api/stats`), то есть ровно то, что видно на
 * странице /dev/, и шлём его файлом.
 *
 * Запуск из корня проекта:
 *   npx tsx scripts/send-report-now.ts [period]   # period: 24h | 7d | 30d (по умолчанию 24h)
 */
import dotenv from 'dotenv';
import { Bot, InputFile } from 'grammy';

import { renderReportHtml } from '../src/services/notifications/reportHtml.ts';
import { writeReportFiles } from '../src/services/notifications/dailyReport.ts';
import type { StatsResponse } from '../src/server/devStats.ts';
import { safeErrorMessage } from '../src/bot/format.ts';

dotenv.config();

const PERIODS = new Set(['24h', '7d', '30d']);

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || token === 'MY_TELEGRAM_BOT_TOKEN') {
    console.error('TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
  }

  const devToken = process.env.DEV_STATS_TOKEN?.trim();
  if (!devToken) {
    console.error('DEV_STATS_TOKEN не задан');
    process.exit(1);
  }

  const chatId = Number(process.env.DAILY_REPORT_TELEGRAM_ID?.trim());
  if (!Number.isFinite(chatId)) {
    console.error('DAILY_REPORT_TELEGRAM_ID не задан');
    process.exit(1);
  }

  const requested = process.argv[2] ?? '24h';
  const period = PERIODS.has(requested) ? requested : '24h';
  const apiPort = process.env.API_PORT ?? '3000';
  const url = `http://127.0.0.1:${apiPort}/dev-api/stats?period=${period}&usersLimit=200`;

  const res = await fetch(url, { headers: { 'X-Dev-Token': devToken } });
  if (!res.ok) {
    console.error(`API вернул HTTP ${res.status}`);
    process.exit(1);
  }

  // Тот же объект, что отдаётся странице — без пересчёта здесь.
  const stats = (await res.json()) as StatsResponse;
  const day = stats.moscowNow?.date ?? 'today';

  const files = writeReportFiles(day, stats, `Срез за период ${period} (живые данные процесса)`);
  const html = renderReportHtml(stats, `Срез за период ${period} (живые данные процесса)`);

  const online = stats.online?.find((o) => o.windowMinutes === 15)?.count ?? 0;
  const w = stats.windows?.[period === '24h' ? 'd1' : period === '7d' ? 'd7' : 'd30'];
  const caption =
    `📊 <b>Hub — отчёт сейчас (${period})</b>\n` +
    `${stats.moscowNow?.date} ${stats.moscowNow?.time} МСК\n\n` +
    `Онлайн (15 мин): <b>${online}</b>\n` +
    `Запросов: <b>${w?.requests ?? 0}</b>\n` +
    `Активных: <b>${w?.activeUsers ?? 0}</b>\n` +
    `Всего пользователей: <b>${stats.kpi?.users ?? 0}</b>`;

  const bot = new Bot(token);
  await bot.api.sendMessage(chatId, caption, { parse_mode: 'HTML' });
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(html, 'utf-8'), files.html), {
    caption: `Срез за ${period} — открой файл в браузере.`,
  });
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(JSON.stringify(stats, null, 2), 'utf-8'), files.json), {
    caption: `Данные за ${period} (JSON).`,
  });

  console.log(`Отправлено: ${files.html}, ${files.json} (период ${period}).`);
}

main().catch((err: unknown) => {
  console.error('Ошибка:', safeErrorMessage(err));
  process.exit(1);
});
