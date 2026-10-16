import { Bot } from 'grammy';

import { userStore } from '../storage/userStore.ts';
import { buildPwaOpenView, type InlineButton } from './pwaView.ts';
import { flushSnapshots, setNotificationSender, startNotifier } from '../services/notifications/barsNotifier.ts';
import { startDailyReport } from '../services/notifications/dailyReport.ts';
import { recordNotification } from '../server/devStats.ts';
import { processTelegramCallback, processTelegramMessage } from './botEngine.ts';
import { safeErrorMessage } from './format.ts';

/**
 * Подключение Telegram: приём команд, нажатий и доставка уведомлений.
 *
 * Бот стал тонким push-каналом. Отсюда следует всё, что здесь есть: запуск
 * long polling, четыре обработчика (сообщение, нажатие, самоудаление
 * уведомления, закрытие экрана) и отправка фоновых уведомлений. Ни экранов с
 * данными, ни приёма файлов, ни нижней клавиатуры — расписание, задания,
 * оценки и почта живут в приложении.
 *
 * Что осталось по необходимости, а не по недосмотру. `getBotInstance()` нужен
 * `telegramFileDownload`, а тот — `fileStore.saveTelegramFile`; сама функция
 * мертва после удаления приёма файлов, но трогать её нельзя: `src/storage/**`
 * вне этой задачи, и его ломание уронило бы и API.
 */

const HTML_PARSE_MODE = 'HTML' as const;

/**
 * Пауза перед повторным запуском long polling после фатального сбоя.
 *
 * Пять секунд — компромисс: при кратковременном конфликте (второй инстанс бота
 * с тем же токеном) опрос возобновляется почти сразу, но при устойчивой проблеме
 * лог не забивается десятками строк в секунду.
 */
const POLL_RESTART_DELAY_MS = 5_000;

let botInstance: Bot | null = null;

/**
 * Инстанс grammY для операций вне обработчиков апдейта.
 *
 * Возвращает null, если бот ещё не инициализирован: вызывающий обязан быть
 * готов к этому, потому что при отсутствии TELEGRAM_BOT_TOKEN бота просто не
 * будет, а процесс продолжает жить ради API.
 */
export function getBotInstance(): Bot | null {
  return botInstance;
}

let botUsername: string | null = null;

/** Имя бота для deep link из приложения. */
export function getBotUsername(): string | null {
  return botUsername;
}

/** Клавиатура экрана или undefined, когда кнопок нет. */
function markupFor(keyboard: InlineButton[][] | undefined) {
  return keyboard && keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
}

/**
 * Long polling с самовосстановлением.
 *
 * `bot.start()` возвращает промис, который реджектится при фатальном сбое опроса
 * (классический случай — `409 Conflict`, когда рядом поднят второй инстанс бота
 * с тем же токеном). Раньше этот промис никто не ловил: reject уходил в
 * глобальный `unhandledRejection` в `bot.ts`, который намеренно НЕ роняет
 * процесс (в нём живёт и API), — и бот молча перестал получать сообщения,
 * оставаясь «живым» для systemd, который поэтому его не перезапускал.
 *
 * Теперь сбой опроса перезапускает его сам, не задевая API и нотификатор.
 */
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

export async function initTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || token.trim() === '' || token === 'MY_TELEGRAM_BOT_TOKEN') {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN не задан. Укажите токен в .env');
    return;
  }

  try {
    const bot = new Bot(token.trim());
    botInstance = bot;

    /**
     * Фоновые уведомления — единственное, ради чего бот теперь существует.
     *
     * Они приходят НОВЫМ сообщением, а не правкой главного экрана: уведомление
     * не относится к навигации, и затирать им экран нельзя. На каждое вешается
     * кнопка самоудаления — без неё уведомления копятся в переписке и засоряют
     * её, а Telegram сам их не убирает.
     */
    setNotificationSender(async (chatId, text) => {
      // Счётчик для статистики (память, без I/O) — до самой отправки.
      recordNotification();
      await bot.api.sendMessage(chatId, text, {
        parse_mode: HTML_PARSE_MODE,
        reply_markup: {
          inline_keyboard: [[{ text: '✕ Скрыть уведомление', callback_data: 'notif_dismiss' }]],
        },
      });
    });

    bot.catch((err) => {
      console.error('[Telegram Bot Error]:', safeErrorMessage(err));
    });

    /**
     * `/app` — экран со ссылкой на приложение.
     *
     * Команда осталась, потому что люди помнят именно её. Отдельный экран у
     * `/app` и у `/start` теперь один и тот же: различать их нечем.
     *
     * Регистрируется ДО общего обработчика текста, иначе команда ушла бы в
     * логику меню.
     */
    bot.command('app', async (ctx) => {
      const view = buildPwaOpenView(ctx.from?.id ?? 0);

      await ctx.reply(view.text, {
        parse_mode: HTML_PARSE_MODE,
        reply_markup: markupFor(view.keyboard),
      });
    });

    bot.on('message:text', async (ctx) => {
      const sender = {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      };

      let view;
      try {
        view = (await processTelegramMessage(sender, ctx.message.text ?? '')).view;
      } catch (err: unknown) {
        console.error('[Telegram Bot] Ошибка обработки сообщения:', safeErrorMessage(err));
        return;
      }

      await ctx.reply(view.text, {
        parse_mode: HTML_PARSE_MODE,
        reply_markup: markupFor(view.keyboard),
      });
    });

    bot.on('callback_query:data', async (ctx) => {
      if (!ctx.chat) return;
      const chatId = ctx.chat.id;

      /**
       * Самоудаление фонового уведомления.
       *
       * Обрабатывается первым и до всего остального: клик по уведомлению не
       * должен трогать ни экран, ни что-либо ещё — это просто уборка
       * уведомления из переписки.
       */
      if (ctx.callbackQuery.data === 'notif_dismiss') {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // ignore
        }

        const messageId = ctx.callbackQuery.message?.message_id;
        if (messageId === undefined) return;

        try {
          await bot.api.deleteMessage(chatId, messageId);
        } catch (err: unknown) {
          console.warn('[Telegram Bot] Не удалось удалить уведомление:', safeErrorMessage(err));
        }

        return;
      }

      /**
       * Закрытие экрана.
       *
       * Кнопка вешалась под файлами карточек, которых у бота больше нет, но
       * сообщение с ней может остаться в переписке у людей, обновившихся не
       * с самой свежей версии. Удаляем — это единственное, что делает кнопка.
       */
      if (ctx.callbackQuery.data === 'app_back_to_menu') {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // ignore
        }

        const ownMessageId = ctx.callbackQuery.message?.message_id;
        if (typeof ownMessageId === 'number') {
          try {
            await bot.api.deleteMessage(chatId, ownMessageId);
          } catch {
            // Сообщение уже удалено или слишком старое — игнорируем.
          }
        }

        return;
      }

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

      // Правка не всегда возможна: сообщение могло быть удалено руками, или
      // текст не изменился и Telegram отвечает «message is not modified».
      // В обоих случаях молчание — правильный исход.
      try {
        await ctx.editMessageText(result.view.text, {
          parse_mode: HTML_PARSE_MODE,
          reply_markup: markupFor(result.view.keyboard),
        });
      } catch (err: unknown) {
        console.warn('[Telegram Bot] Правка экрана не выполнена:', safeErrorMessage(err));
      }
    });

    // REST API для PWA живёт в том же процессе и переиспользует сервисы бота.
    // Если порт занят или API_PORT не задан — бот продолжает работать.
    if (process.env.API_PORT) {
      try {
        const { startServer } = await import('../server/index.ts');
        await startServer();
      } catch (err: unknown) {
        console.error('[API] Не удалось запустить сервер PWA:', safeErrorMessage(err));
      }
    }

    const botInfo = await bot.api.getMe();
    botUsername = botInfo.username || null;

    console.log(`[Telegram Bot] Успешно запущен бот @${botUsername}!`);

    /**
     * Фоновый нотификатор: единственный источник сообщений в чат.
     *
     * Живёт в процессе бота, но не зависит от него: любые сбои сети глушатся
     * внутри воркера, и обрыв Telegram не должен обрывать опрос БАРС.
     */
    startNotifier();

    // Ежедневный отчёт владельцу в 00:00 МСК (см. services/notifications/dailyReport).
    startDailyReport(bot);

    /**
     * systemd шлёт SIGTERM при остановке/рестарте. Без этого снимки,
     * накопленные в памяти с последнего круга, потерялись бы, и после
     * рестарта бот повторно прислал бы уже отправленные уведомления.
     */
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        flushSnapshots();
        process.exit(0);
      });
    }

    startPolling(bot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Telegram Bot] Ошибка запуска бота:', safeErrorMessage(msg));
  }
}

/**
 * Имя бота для deep link, который приложение вставляет в кнопку
 * «Подключить уведомления в Telegram».
 *
 * Отдельный экспорт, потому что ссылку вида `https://t.me/<bot>?start=<userId>`
 * собирает фронтенд, а знать имя бота на сервере обязан он — из переменной
 * окружения, до того как бот зарегистрирован.
 */
export function botDeepLink(userId: string): string | null {
  const name = process.env.TELEGRAM_BOT_USERNAME?.trim() || botUsername;

  return name ? `https://t.me/${name}?start=${userId}` : null;
}
