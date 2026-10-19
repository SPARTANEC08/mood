/**
 * Разовая рассылка всем привязанным к боту пользователям.
 *
 * Текст и кнопка задаются переменными окружения: скрипт не хранит копию
 * сообщения, поэтому формулировку можно менять без правки кода.
 *
 *   BROADCAST_TEXT="..."          — текст в HTML-разметке Telegram (обязателен)
 *   BROADCAST_URL="https://..."   — ссылка для кнопки (необязательно)
 *   BROADCAST_BUTTON="..."        — подпись кнопки (по умолчанию «Открыть приложение»)
 *   BROADCAST_INCLUDE_DISABLED=1  — слать и тем, кто выключил уведомления
 *
 * По умолчанию уважается отказ: `notificationsEnabled === false` пропускается.
 *
 * Запуск из корня проекта (там, где лежит db/data/):
 *   BROADCAST_TEXT='...' BROADCAST_URL='https://...' npx tsx backend/scripts/broadcast.ts
 */
import dotenv from 'dotenv';
import { Bot } from 'grammy';

import { userStore, type StoredUser } from '../../db/storage/userStore.ts';
import { safeErrorMessage } from '../../tg/format.ts';

dotenv.config();

/**
 * Пауза между сообщениями. Telegram сам просит не превышать ~30 сообщений в
 * секунду, но нам важнее не попасть под антифлуд на маленькой выборке.
 */
const SEND_DELAY_MS = 120;

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || token === 'MY_TELEGRAM_BOT_TOKEN') {
    console.error('[broadcast] TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
  }

  const text = process.env.BROADCAST_TEXT?.trim();
  if (!text) {
    console.error('[broadcast] BROADCAST_TEXT не задан');
    process.exit(1);
  }

  const url = process.env.BROADCAST_URL?.trim();
  const buttonLabel = process.env.BROADCAST_BUTTON?.trim() || 'Открыть приложение';
  const includeDisabled = process.env.BROADCAST_INCLUDE_DISABLED === '1';

  const recipients = userStore
    .all()
    .filter((user): user is StoredUser & { telegramId: number } => typeof user.telegramId === 'number')
    .filter((user) => includeDisabled || user.notificationsEnabled !== false);

  console.log(
    `[broadcast] получателей: ${recipients.length}` +
      (includeDisabled ? ' (включая выключивших уведомления)' : ''),
  );

  const bot = new Bot(token);
  let sent = 0;
  let failed = 0;

  for (const user of recipients) {
    try {
      await bot.api.sendMessage(user.telegramId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(url ? { reply_markup: { inline_keyboard: [[{ text: buttonLabel, url }]] } } : {}),
      });
      sent += 1;
    } catch (err: unknown) {
      failed += 1;
      console.warn(`[broadcast] не доставлено (${user.userId.slice(0, 8)}…): ${safeErrorMessage(err)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
  }

  console.log(`[broadcast] готово: отправлено ${sent}, ошибок ${failed}`);
}

main().catch((err: unknown) => {
  console.error('[broadcast] ошибка рассылки:', safeErrorMessage(err));
  process.exit(1);
});
