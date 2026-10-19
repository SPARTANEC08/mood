/**
 * Отправить отчёт «прямо сейчас» — из ЖИВОГО среза работающего процесса.
 *
 * Важно: счётчики статистики хранятся в памяти процесса бота, поэтому отдельный
 * скрипт (и `emit` из другого процесса) их не видит. Здесь мы не считаем сами, а
 * забираем готовый ответ у API (`/dev-api/stats`), то есть ровно то, что видно на
 * странице /dev/, и шлём ОДНИМ HTML-файлом — без текста в чат и без JSON.
 *
 * Запуск из корня проекта:
 *   npx tsx backend/scripts/send-report-now.ts [подпись]
 *
 * В БД отчёт НЕ сохраняется: он нужен здесь и сейчас (в архиве остаются только
 * автоотчёты в 00:00). То же самое делает кнопка «📊 Отчёт сейчас» в админке —
 * она работает в процессе бота и берёт данные напрямую, без HTTP.
 */
import dotenv from 'dotenv';
import { Bot, InputFile } from 'grammy';

import { renderReportHtml } from '../services/notifications/reportHtml.ts';
import type { StatsResponse } from '../server/devStats.ts';
import { safeErrorMessage } from '../../tg/format.ts';

dotenv.config();

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

  const note = process.argv.slice(2).join(' ').trim() || 'Отчёт сейчас';
  const apiPort = process.env.API_PORT ?? '3000';
  const url = `http://127.0.0.1:${apiPort}/dev-api/stats`;

  const res = await fetch(url, { headers: { 'X-Dev-Token': devToken } });
  if (!res.ok) {
    console.error(`API вернул HTTP ${res.status}`);
    process.exit(1);
  }

  // Тот же объект, что отдаётся странице — без пересчёта здесь.
  const stats = (await res.json()) as StatsResponse;
  const html = renderReportHtml(stats, note);

  // Только HTML-файл: ни текстовой сводки, ни JSON, ни caption. В базе не храним.
  const bot = new Bot(token);
  await bot.api.sendDocument(
    chatId,
    new InputFile(Buffer.from(html, 'utf-8'), `stats-${stats.moscowNow?.date ?? 'now'}.html`),
  );

  console.log('Отправлено файлом (в базе не сохранено).');
}

main().catch((err: unknown) => {
  console.error('Ошибка:', safeErrorMessage(err));
  process.exit(1);
});
