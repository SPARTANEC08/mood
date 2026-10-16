/**
 * Разовая (тестовая) отправка ежедневного отчёта в Telegram.
 *
 * Ничего не планирует — просто собирает отчёт за текущий московский день
 * «на сейчас» и шлёт владельцу так же, как это сделает ежедневный таймер.
 *
 * Запуск из корня проекта:
 *   npx tsx scripts/daily-report-test.ts
 */
import dotenv from 'dotenv';
import { Bot } from 'grammy';

import { toMoscow } from '../src/utils/time.ts';
import { sendDailyReport } from '../src/services/notifications/dailyReport.ts';
import { safeErrorMessage } from '../src/bot/format.ts';

dotenv.config();

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || token === 'MY_TELEGRAM_BOT_TOKEN') {
    console.error('TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
  }

  const bot = new Bot(token);
  const today = toMoscow().rawDate;

  const sent = await sendDailyReport(bot, {
    day: today,
    note: 'Тестовая отправка · данные за сегодня на текущий момент',
  });

  console.log(sent ? 'Тестовый отчёт отправлен.' : 'Отчёт не отправлен (нет получателя).');
}

main().catch((err: unknown) => {
  console.error('Ошибка тестовой отправки:', safeErrorMessage(err));
  process.exit(1);
});
