import { Bot, InputFile } from 'grammy';

import { flushSnapshots, setNotificationSender, startNotifier } from '../backend/services/notifications/barsNotifier.ts';
import { startDailyReport } from '../backend/services/notifications/dailyReport.ts';
import { buildMailRefreshRunningView } from './adminView.ts';
import { processTelegramCallback, processTelegramMessage, type MailProgress } from './botEngine.ts';
import { type BroadcastSend } from './broadcast.ts';
import { classifyEditError } from './editErrors.ts';
import { safeErrorMessage } from './format.ts';
import { type InlineButton } from './pwaView.ts';

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
 * мертва после удаления приёма файлов, но трогать её нельзя: `db/storage/**`
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

/**
 * Клавиатура для grammY.
 *
 * Собираем объекты заново, а не отдаём наш InlineButton как есть: у него есть
 * служебное поле `style`, которого Telegram не знает. Кнопка — либо ссылка,
 * либо callback; пустые строки отбрасываем.
 */
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

/** Отправка текста в чат с HTML-разметкой. */
function replyTextParams(keyboard: InlineButton[][] | undefined) {
  return { parse_mode: HTML_PARSE_MODE, reply_markup: markupFor(keyboard) };
}

/**
 * Long polling с самовосстановлением.
 *
 * `bot.start()` возвращает промис, который реджектится при фатальном сбое опроса
 * (классический случай — `409 Conflict`, когда рядом поднят второй инстанс бота
 * с тем же токеном). Раньше этот промис никто не ловил: reject уходил в
 * глобальный `unhandledRejection` в `tg/bot.ts`, который намеренно НЕ роняет
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
    /**
     * Куда ведёт кнопка «📧 Перейти в ОСЭП».
     *
     * Прямо в папку «Почта» веб-интерфейса OWA. Прежние варианты (голый `/owa`
     * и эндпоинт FBA `CookieAuth.dll`) открывали лишний шаг — выбор компьютера,
     * после которого почта либо не открывалась, либо отдавала ошибку. Этот адрес
     * проверен и ведёт в список писем сразу.
     *
     * Логин и пароль в URL не передаются ни в каком виде: Mood не входит в почту
     * за человека и не должен.
     */
    const osepLoginUrl = 'https://mail.mpei.ru/owa/#path=/mail';

    setNotificationSender(async (chatId, text) => {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: HTML_PARSE_MODE,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📧 Перейти в ОСЭП', url: osepLoginUrl }],
            [{ text: '🏠 В главное меню', callback_data: 'notif_menu' }],
            [{ text: '✕ Скрыть', callback_data: 'notif_dismiss' }],
          ],
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
    /** Отправка экрана новым сообщением (для /app, FSM и удалённых экранов). */
    async function sendView(
      chatId: number,
      view: { text: string; keyboard: InlineButton[][]; document?: { path?: string; filename: string; html?: string } },
    ): Promise<void> {
      if (view.text) {
        await bot.api.sendMessage(chatId, view.text, replyTextParams(view.keyboard));
      }
      if (view.document) {
        try {
          await bot.api.sendDocument(chatId, new InputFile(view.document.path as string), {
            caption: 'Mood — установочный файл',
          });
        } catch (err: unknown) {
          console.warn('[Telegram Bot] Не удалось отправить файл:', safeErrorMessage(err));
          await bot.api.sendMessage(chatId, 'Файл недоступен. Установи PWA из Chrome.', replyTextParams(view.keyboard));
        }
      }
    }

    /**
     * Рассылка: обычный текст без parse_mode. HTML в объявлении не
     * интерпретируется намеренно — так невозможно сломать разметку и
     * случайно упомянуть не того.
     */
    const broadcastSend: BroadcastSend = async (chatId, text) => {
      await bot.api.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [[{ text: '✕ Закрыть', callback_data: 'msg_close' }]],
        },
      });
    };

    bot.command('app', async (ctx) => {
      const sender = {
        id: ctx.from?.id ?? 0,
        firstName: ctx.from?.first_name ?? '',
        lastName: ctx.from?.last_name,
        username: ctx.from?.username,
      };
      const result = await processTelegramMessage(sender, '/start');
      await sendView(ctx.chat.id, result.view);
    });

    bot.on('message:text', async (ctx) => {
      const sender = {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      };

      let result;
      try {
        result = await processTelegramMessage(sender, ctx.message.text ?? '');
      } catch (err: unknown) {
        console.error('[Telegram Bot] Ошибка обработки сообщения:', safeErrorMessage(err));
        return;
      }

      await sendView(ctx.chat.id, result.view);
    });

    bot.on('callback_query:data', async (ctx) => {
      if (!ctx.chat) return;
      const chatId = ctx.chat.id;
      const data = ctx.callbackQuery.data;

      // Старые кнопки из прошлых версий: просто убираем сообщение.
      if (data === 'app_back_to_menu') {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // ignore
        }
        const messageId = ctx.callbackQuery.message?.message_id;
        if (typeof messageId === 'number') {
          try {
            await bot.api.deleteMessage(chatId, messageId);
          } catch {
            // уже удалено
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

      // Долгие действия: ответить на callback сразу, иначе Telegram крутит
      // спиннер и обрывает его через несколько секунд. Результат придёт
      // правкой сообщения.
      const longAction = data === 'admin_mail_yes' || data === 'broadcast_send';
      if (longAction) {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // ignore
        }
        try {
          const running =
            data === 'admin_mail_yes'
              ? buildMailRefreshRunningView()
              : '⏳ Отправляю рассылку…';
          await ctx.editMessageText(running, { parse_mode: HTML_PARSE_MODE });
        } catch {
          // сообщение могли удалить
        }
      }

      // Прогресс прогона почты: правки сообщения не чаще раза в секунду,
      // иначе Telegram-флуд от собственного бота. Финальный кадр — всегда.
      let lastProgressEdit = 0;
      const onMailProgress: MailProgress = async (processed, total) => {
        const now = Date.now();
        const finished = processed >= total;
        if (!finished && now - lastProgressEdit < 1000) return;
        lastProgressEdit = now;
        try {
          await ctx.editMessageText(`⏳ Обновляю почту… ${processed}/${total}`, {
            parse_mode: HTML_PARSE_MODE,
          });
        } catch {
          // сообщение могли удалить или оно без текста
        }
      };

      let result;
      try {
        result = await processTelegramCallback(sender, data, { broadcast: broadcastSend, onMailProgress });
      } catch (err: unknown) {
        console.error('[Telegram Bot] Ошибка обработки нажатия:', safeErrorMessage(err));
        try {
          await ctx.answerCallbackQuery({ text: 'Произошла ошибка.' });
        } catch {
          // ignore
        }
        return;
      }

      if (!longAction) {
        try {
          await ctx.answerCallbackQuery(result.toast ? { text: result.toast } : undefined);
        } catch {
          // ignore
        }
      }

      const messageId = ctx.callbackQuery.message?.message_id;

      // «Скрыть» / «Закрыть»: только удаление, без нового экрана.
      if (result.deleteCurrent) {
        if (typeof messageId === 'number') {
          try {
            await bot.api.deleteMessage(chatId, messageId);
          } catch {
            // уже удалено
          }
        }
        if (!result.view.text && !result.view.document) return;
      }

      // Отчёт: документ с подписью и клавиатурой «В админку».
      if (result.view.document) {
        const doc = result.view.document;
        const file = doc.html
          ? new InputFile(Buffer.from(doc.html, 'utf-8'), doc.filename)
          : new InputFile(doc.path as string);
        try {
          await bot.api.sendDocument(chatId, file, {
            caption: result.view.text || undefined,
            parse_mode: HTML_PARSE_MODE,
            reply_markup: markupFor(result.view.keyboard),
          });
        } catch (err: unknown) {
          console.warn('[Telegram Bot] Отчёт не отправлен:', safeErrorMessage(err));
          await bot.api.sendMessage(chatId, 'Файл отчёта не найден.', replyTextParams(result.view.keyboard));
        }
        return;
      }

      if (!result.view.text) return;

      if (result.deleteCurrent || result.forceNewMessage) {
        await sendView(chatId, result.view);
        return;
      }

      // Одностраничная логика: правим текущее сообщение.
      try {
        await ctx.editMessageText(result.view.text, replyTextParams(result.view.keyboard));
      } catch (err: unknown) {
        const kind = classifyEditError(err);

        // «message is not modified» — нажали ту же кнопку, текст и кнопки те же.
        // Это НЕ повод отправлять второе сообщение: иначе как раз и ломалась
        // одностраничность — каждое повторное нажатие плодило копию меню.
        if (kind === 'not_modified') {
          return;
        }

        // Сообщение без текста (документ, фото) править нельзя — заменяем его
        // новым, удалив старое, чтобы в чате остался один экран.
        const notEditable = kind === 'not_editable';

        console.warn('[Telegram Bot] Правка экрана не выполнена:', safeErrorMessage(err));

        if (notEditable && typeof messageId === 'number') {
          try {
            await bot.api.deleteMessage(chatId, messageId);
          } catch {
            // уже удалено
          }
        }

        await sendView(chatId, result.view);
      }
    });

    // REST API для PWA живёт в том же процессе и переиспользует сервисы бота.
    // Если порт занят или API_PORT не задан — бот продолжает работать.
    if (process.env.API_PORT) {
      try {
        const { startServer } = await import('../backend/server/index.ts');
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

    // Ежедневный отчёт владельцу в 00:00 МСК: HTML-файл документом с кнопкой
    // «Закрыть». Тот же файл ложится в db/data/reports/ и появляется в
    // админ-меню «📜 Отчёты».
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
