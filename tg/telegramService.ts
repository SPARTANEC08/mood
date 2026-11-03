/**
 * Подключение Telegram-бота поддержки.
 *
 * Бот — самостоятельный процесс и НЕ импортирует ничего из `backend/` или
 * `db/`: ему не нужны ни база, ни БАРС, ни почта, ни ключи шифрования. Он умеет
 * только одно — раздавать ссылки: на установку, канал, GitHub и поддержку.
 *
 * Поэтому здесь нет ни запуска REST API, ни фонового нотификатора, ни ночного
 * отчёта. Всё это живёт в отдельном процессе `backend/server/main.ts`
 * (`dist/app.js`), а бот запускается из `tg/bot.ts` (`dist/bot.js`).
 */

import { Bot } from 'grammy';

import { processTelegramCallback, processTelegramMessage } from './botEngine.ts';
import { botSubscribers } from './subscribers.ts';
import { classifyEditError } from './editErrors.ts';
import { safeErrorMessage } from './format.ts';
import { type BotViewResult, type InlineButton } from './pwaView.ts';

const HTML_PARSE_MODE = 'HTML' as const;
const POLL_RESTART_DELAY_MS = 5_000;

function markupFor(keyboard: InlineButton[][] | undefined) {
  if (!keyboard || keyboard.length === 0) return undefined;

  const inline_keyboard = keyboard
    .map((row) =>
      row.map((button) =>
        button.url
          ? { text: button.text, url: button.url }
          : { text: button.text, callback_data: button.callback_data ?? 'menu' },
      ),
    )
    .filter((row) => row.length > 0);

  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
}

function replyTextParams(keyboard: InlineButton[][] | undefined) {
  return { parse_mode: HTML_PARSE_MODE, reply_markup: markupFor(keyboard) };
}

/** Long polling с самовосстановлением после фатального сбоя. */
function startPolling(bot: Bot): void {
  bot
    .start({
      onStart: (info) => {
        console.log(`[Telegram Bot] Polling запущен для @${info.username}`);
      },
    })
    .catch((err: unknown) => {
      console.error(
        `[Telegram Bot] Long polling остановлен, перезапуск через ${POLL_RESTART_DELAY_MS} мс:`,
        safeErrorMessage(err),
      );
      setTimeout(() => startPolling(bot), POLL_RESTART_DELAY_MS);
    });
}

async function sendView(bot: Bot, chatId: number, view: BotViewResult): Promise<void> {
  await bot.api.sendMessage(chatId, view.text, replyTextParams(view.keyboard));
}

export async function initTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || token.trim() === '' || token === 'MY_TELEGRAM_BOT_TOKEN') {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN не задан. Укажите токен в .env');
    return;
  }

  try {
    const bot = new Bot(token.trim());

    bot.catch((err) => {
      console.error('[Telegram Bot Error]:', safeErrorMessage(err));
    });

    // Запоминаем каждого, кто взаимодействует с ботом. Telegram не даёт
    // написать тому, кто ни разу не запускал бота, поэтому список нужен
    // именно здесь, в отдельном процессе.
    bot.use(async (ctx, next) => {
      if (ctx.from) botSubscribers.touch(ctx.from);
      await next();
    });

    bot.command('app', async (ctx) => {
      const sender = {
        id: ctx.from?.id ?? 0,
        firstName: ctx.from?.first_name ?? '',
        lastName: ctx.from?.last_name,
        username: ctx.from?.username,
      };
      const result = await processTelegramMessage(sender, '/start');
      await sendView(bot, ctx.chat.id, result.view);
    });

    bot.on('message:text', async (ctx) => {
      const sender = {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      };

      try {
        const result = await processTelegramMessage(sender, ctx.message.text ?? '');
        await sendView(bot, ctx.chat.id, result.view);
      } catch (err: unknown) {
        console.error('[Telegram Bot] Ошибка обработки сообщения:', safeErrorMessage(err));
      }
    });

    bot.on('callback_query:data', async (ctx) => {
      if (!ctx.chat) return;

      const chatId = ctx.chat.id;
      const sender = {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      };

      let result;
      try {
        result = await processTelegramCallback(sender, ctx.callbackQuery.data);
      } catch (err: unknown) {
        console.error('[Telegram Bot] Ошибка обработки нажатия:', safeErrorMessage(err));
        try {
          await ctx.answerCallbackQuery({ text: 'Произошла ошибка.' });
        } catch {
          // ignore
        }
        return;
      }

      try {
        await ctx.answerCallbackQuery(result.toast ? { text: result.toast } : undefined);
      } catch {
        // ignore
      }

      try {
        await ctx.editMessageText(result.view.text, replyTextParams(result.view.keyboard));
      } catch (err: unknown) {
        const kind = classifyEditError(err);

        if (kind === 'not_modified') return;

        console.warn('[Telegram Bot] Правка экрана не выполнена:', safeErrorMessage(err));
        await sendView(bot, chatId, result.view);
      }
    });

    const botInfo = await bot.api.getMe();
    console.log(`[Telegram Bot] Успешно запущен бот @${botInfo.username || 'unknown'}!`);

    // Останавливаем long polling по SIGTERM/SIGINT, чтобы systemd-рестарт не
    // оставлял два инстанса, дерущихся за один токен.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void bot.stop();
        process.exit(0);
      });
    }

    startPolling(bot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Telegram Bot] Ошибка запуска бота:', safeErrorMessage(msg));
  }
}
