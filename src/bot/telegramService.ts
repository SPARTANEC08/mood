import { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import {
  HomeworkRecord,
  homeworkStore,
  TelegramFileRef,
  TelegramFileType,
} from '../storage/homeworkStore.ts';
import { ImportantMessage, importantStore } from '../storage/importantStore.ts';
import { userStore } from '../storage/userStore.ts';
import { formatDisplayDate } from '../utils/time.ts';
import { setAuthFlowListener } from './authFlow.ts';
import { flushSnapshots, setNotificationSender, startNotifier } from '../services/notifications/barsNotifier.ts';
import { esc, toneButton } from './format.ts';
import { processTelegramCallback, processTelegramMessage } from './botEngine.ts';

/**
 * Все экраны собираются в HTML: это нужно для цитат <blockquote>,
 * сворачиваемых блоков и цветных кнопок.
 */
const HTML_PARSE_MODE = 'HTML' as const;

let botInstance: Bot | null = null;
let botUsername: string | null = null;

const BOTTOM_REPLY_KEYBOARD = {
  keyboard: [[{ text: '⚙️ Остальное' }]],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Префиксы file_id, по которым Telegram кодирует тип файла.
 * Нужны для записей, где поле `type` не сохранилось.
 */
const FILE_ID_PREFIX: Record<string, TelegramFileType> = {
  Ag: 'photo',
  BQ: 'document',
  BA: 'video',
  CQ: 'audio',
  Aw: 'voice',
};

/**
 * Определяет тип файла: сначала по сохранённому полю, затем по префиксу file_id.
 *
 * Раньше при отсутствии `type` файл уходил в sendDocument, и Telegram отвечал
 * «can't use file of type Photo as Document» — фото молча не доходило.
 */
export function resolveFileType(file: TelegramFileRef): TelegramFileType {
  if (file.type) return file.type;

  const prefix = (file.fileId ?? '').slice(0, 2);
  return FILE_ID_PREFIX[prefix] ?? 'document';
}

/**
 * Отправляет файлы открытой карточки в чат.
 *
 * Отдельная функция нужна по двум причинам:
 * - вызывается и из обработчика кнопок, и из обработчика текста (раньше
 *   файлы доставлялись только по кнопке, поэтому по тексту они терялись);
 * - сообщает пользователю, если файл недоступен, вместо молчаливого игнора.
 */
async function deliverFiles(
  bot: Bot,
  senderId: number,
  chatId: number | string,
  files: TelegramFileRef[] | undefined
): Promise<void> {
  if (!files || files.length === 0) return;

  let failed = 0;

  for (const file of files) {
    try {
      const sent = await sendSingleFile(bot, chatId, file);
      if (sent) {
        userStore.addTransientMessage(senderId, sent.message_id);
      }
    } catch (err: unknown) {
      failed += 1;
      const description = err instanceof Error ? err.message : String(err);
      console.error('[Telegram Bot] Не удалось отправить файл в чат:', description);
    }
  }

  // Пользователь должен знать, что файла нет, а не гадать
  if (failed > 0) {
    try {
      await bot.api.sendMessage(
        chatId,
        `⚠️ Не удалось прикрепить файл${failed > 1 ? 'ы' : ''}: Telegram больше не хранит его. ` +
          'Прикрепите файл заново — новые файлы будут работать.',
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Отправляет один файл, подбирая метод по типу.
 *
 * Telegram различает фото, видео, аудио и голосовые строго: отправив фото
 * через sendDocument, получим 400. Поэтому при неверном методе делаем
 * один повтор через sendDocument, а если и он не сработал — пробуем остальные
 * методы по очереди, прежде чем сдаться.
 */
async function sendSingleFile(
  bot: Bot,
  chatId: number | string,
  file: TelegramFileRef,
  extra: Record<string, unknown> = {}
) {
  const caption = file.fileName ? `📎 ${file.fileName}` : undefined;
  const type = resolveFileType(file);

  const attempts: (() => Promise<Message>)[] = [];

  if (type === 'photo') attempts.push(() => bot.api.sendPhoto(chatId, file.fileId, { caption, ...extra }));
  if (type === 'video') attempts.push(() => bot.api.sendVideo(chatId, file.fileId, { caption, ...extra }));
  if (type === 'audio') attempts.push(() => bot.api.sendAudio(chatId, file.fileId, { caption, ...extra }));
  if (type === 'voice') attempts.push(() => bot.api.sendVoice(chatId, file.fileId, { caption, ...extra }));

  // Документ — универсальный запасной вариант
  attempts.push(() => bot.api.sendDocument(chatId, file.fileId, { caption, ...extra }));

  // Если тип определился как документ, но на деле это фото/видео/аудио —
  // перебираем остальные методы, прежде чем считать файл потерянным.
  if (type === 'document') {
    attempts.push(() => bot.api.sendPhoto(chatId, file.fileId, { caption, ...extra }));
    attempts.push(() => bot.api.sendVideo(chatId, file.fileId, { caption, ...extra }));
    attempts.push(() => bot.api.sendAudio(chatId, file.fileId, { caption, ...extra }));
  }

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err: unknown) {
      lastError = err;

      // file_id не существует вовсе — перебор методов не поможет
      const description = err instanceof Error ? err.message : String(err);
      if (/wrong file identifier|invalid file_id|file_reference_expired/i.test(description)) {
        throw err;
      }
    }
  }

  throw lastError ?? new Error('Не удалось определить метод отправки файла.');
}

/**
 * Канал-хранилище файлов. Файлы живут только в Telegram: сервер хранит
 * лишь ссылки (file_id) и номера сообщений в канале.
 */
function getStorageChannelId(): string | null {
  const id = process.env.TELEGRAM_STORAGE_CHANNEL_ID?.trim();
  return id && id !== '' ? id : null;
}

/**
 * Кладёт файлы в канал-хранилище.
 *
 * Возвращает номера сообщений в канале. Если хоть один файл не удалось
 * положить, бот не считает запись сохранённой: ссылка на файл, которого
 * нет в Telegram, бесполезна.
 */
async function archiveFiles(
  bot: Bot,
  channelId: string,
  files: TelegramFileRef[],
  replyTo: number,
  userChatId: number,
  incomingMessageId?: number
): Promise<{ ids: number[]; failed: TelegramFileRef[] }> {
  const ids: number[] = [];
  const failed: TelegramFileRef[] = [];

  if (files.length === 0) return { ids, failed };

  // Копируем исходное сообщение целиком — это самый надёжный способ
  // перенести альбом с несколькими фото одним действием.
  if (incomingMessageId) {
    try {
      const copy = await bot.api.copyMessage(channelId, userChatId, incomingMessageId, {
        reply_to_message_id: replyTo,
      });
      ids.push(copy.message_id);
      return { ids, failed };
    } catch {
      // copyMessage не сработал (например, альбом из нескольких медиа) —
      // переходим к отправке файлов по одному
    }
  }

  for (const file of files) {
    try {
      const sent = await sendSingleFile(bot, channelId, file, { reply_to_message_id: replyTo });
      if (sent) {
        ids.push(sent.message_id);
      } else {
        failed.push(file);
      }
    } catch (err: unknown) {
      const description = err instanceof Error ? err.message : String(err);
      console.error('[Storage Channel] Файл не сохранён в Telegram:', file.fileName, description);
      failed.push(file);
    }
  }

  return { ids, failed };
}

/**
 * Публикует ДЗ в канал-хранилище.
 *
 * Если канал недоступен или файлы не легли — запись сохраняется без файлов,
 * а пользователь получает предупреждение. Лучше потерять вложение, чем
 * оставить в базе ссылку на несуществующий файл.
 */
async function archiveHomework(
  bot: Bot,
  hw: HomeworkRecord,
  userChatId: number,
  incomingMessageId?: number
): Promise<void> {
  const channelId = getStorageChannelId();
  if (!channelId) {
    if (hw.files.length > 0) {
      console.error('[Storage Channel] Канал не задан, файлы ДЗ не сохранены в Telegram');
      await notifyAboutLostFiles(bot, userChatId, hw.files);
    }
    return;
  }

  const groupTag = hw.groupName.replace(/[^a-zA-Zа-яА-Я0-9_]/g, '_');
  const typeStr = hw.kind === 'lecture' ? 'Лекция' : hw.kind === 'lab' ? 'Лабораторная' : 'Практика';
  const displayDate = formatDisplayDate(hw.targetDate);

  const lines = [
    `📚 #ДЗ #${groupTag}`,
    `Группа: ${hw.groupName}`,
    `Предмет: ${hw.discipline} (${typeStr})`,
    `Дата: ${displayDate}${hw.lessonNumber ? ` (${hw.lessonNumber} пара)` : ''}`,
    hw.text ? `Задание: ${hw.text}` : '',
    hw.authorName ? `Добавил: ${hw.authorName}` : '',
  ].filter(Boolean);

  let post: Message | undefined;

  try {
    post = await bot.api.sendMessage(channelId, lines.join('\n'));
  } catch (err: unknown) {
    const description = err instanceof Error ? err.message : String(err);
    console.error('[Storage Channel] Канал недоступен:', description);

    if (hw.files.length > 0) {
      // Канал недоступен — файлы точно нигде не сохранены
      homeworkStore.save({ ...hw, files: [] });
      await notifyAboutLostFiles(bot, userChatId, hw.files);
    }
    return;
  }

  const { ids, failed } = await archiveFiles(
    bot, channelId, hw.files, post.message_id, userChatId, incomingMessageId,
  );

  const channelIds = [post.message_id, ...ids];
  const savedFiles = hw.files.filter((f) => !failed.some((x) => x.fileId === f.fileId));

  homeworkStore.setChannelMessages(hw.id, channelIds, savedFiles);

  if (failed.length > 0) {
    await notifyAboutLostFiles(bot, userChatId, failed);
  }
}

/**
 * Публикует объявление в канал-хранилище.
 */
async function archiveImportant(
  bot: Bot,
  imp: ImportantMessage,
  userChatId: number,
  incomingMessageId?: number
): Promise<void> {
  const channelId = getStorageChannelId();
  if (!channelId) {
    if (imp.files.length > 0) {
      console.error('[Storage Channel] Канал не задан, файлы объявления не сохранены');
      await notifyAboutLostFiles(bot, userChatId, imp.files);
    }
    return;
  }

  const groupTag = imp.groupName.replace(/[^a-zA-Zа-яА-Я0-9_]/g, '_');
  const lines = [
    `📌 #Важное #${groupTag}`,
    `Группа: ${imp.groupName}`,
    `Заголовок: ${imp.title}`,
    `Текст: ${imp.text}`,
    imp.authorName ? `Автор: ${imp.authorName}` : '',
  ].filter(Boolean);

  let post: Message | undefined;

  try {
    post = await bot.api.sendMessage(channelId, lines.join('\n'));
  } catch (err: unknown) {
    const description = err instanceof Error ? err.message : String(err);
    console.error('[Storage Channel] Канал недоступен:', description);

    if (imp.files.length > 0) {
      importantStore.save({ ...imp, files: [] });
      await notifyAboutLostFiles(bot, userChatId, imp.files);
    }
    return;
  }

  const { ids, failed } = await archiveFiles(
    bot, channelId, imp.files, post.message_id, userChatId, incomingMessageId,
  );

  const channelIds = [post.message_id, ...ids];
  const savedFiles = imp.files.filter((f) => !failed.some((x) => x.fileId === f.fileId));

  importantStore.setChannelMessages(imp.id, channelIds, savedFiles);

  if (failed.length > 0) {
    await notifyAboutLostFiles(bot, userChatId, failed);
  }
}

/**
 * Честно предупреждает пользователя, что файл не сохранён.
 */
async function notifyAboutLostFiles(
  bot: Bot,
  chatId: number | string,
  files: TelegramFileRef[]
): Promise<void> {
  const names = files.map((f) => f.fileName ?? 'файл').join(', ');
  try {
    await bot.api.sendMessage(
      chatId,
      `⚠️ Не удалось сохранить файлы в Telegram: ${esc(names)}\n\n` +
        'Файл хранится только в Telegram — на сервере его нет. ' +
        'Поэтому прикреплять нужно заново.',
    );
  } catch {
    // ignore
  }
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

    // Асинхронные обновления онбординга (2FA, итог входа, ошибки) редактируют
    // то же главное сообщение — Single-Message UI.
    setAuthFlowListener(async (update) => {
      try {
        const mainMessageId = userStore.getMainMessageId(update.telegramId);
        const replyMarkup = update.keyboard ? { inline_keyboard: update.keyboard } : undefined;

        if (mainMessageId) {
          try {
            await bot.api.editMessageText(update.telegramId, mainMessageId, update.messageText, {
              parse_mode: HTML_PARSE_MODE,
              reply_markup: replyMarkup,
            });
            return;
          } catch {
            try {
              await bot.api.deleteMessage(update.telegramId, mainMessageId);
            } catch {
              // ignore
            }
          }
        }

        const sent = await bot.api.sendMessage(update.telegramId, update.messageText, {
          parse_mode: HTML_PARSE_MODE,
          reply_markup: replyMarkup,
        });
        userStore.setMainMessageId(update.telegramId, sent.message_id);
      } catch (err: unknown) {
        console.error('[AuthFlow] Не удалось обновить главное сообщение:', err);
      }
    });

    // Фоновые уведомления БАРС/ОСЭП приходят новым сообщением в личку:
    // они не относятся к навигации и не должны перетирать главный экран.
    //
    // Главное сообщение бота при каждом действии перезаписывается, а уведомление
    // остаётся в переписке навсегда — без кнопки оно копится и засоряет чат.
    // Поэтому на каждое уведомление вешаем кнопку самоудаления.
    setNotificationSender(async (chatId, text) => {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: HTML_PARSE_MODE,
        reply_markup: {
          inline_keyboard: [
            [toneButton('✕ Скрыть уведомление', 'neutral', 'notif_dismiss')],
          ],
        },
      });
    });

    bot.catch((err) => {
      console.error('[Telegram Bot Error]:', err);
    });

    bot.on(['message:text', 'message:document', 'message:photo', 'message:video', 'message:audio', 'message:voice'], async (ctx) => {
      const sender = {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      };

      const incomingText = ctx.message.text || ctx.message.caption || '';
      const attachedFiles: TelegramFileRef[] = [];
      const incomingMessageId = ctx.message.message_id;

      if (ctx.message.document) {
        attachedFiles.push({
          fileId: ctx.message.document.file_id,
          fileUniqueId: ctx.message.document.file_unique_id,
          fileName: ctx.message.document.file_name || 'Документ',
          fileSize: ctx.message.document.file_size,
          mimeType: ctx.message.document.mime_type,
          type: 'document',
        });
      } else if (ctx.message.photo && ctx.message.photo.length > 0) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        attachedFiles.push({
          fileId: photo.file_id,
          fileUniqueId: photo.file_unique_id,
          fileName: `photo_${photo.file_unique_id.slice(-6)}.jpg`,
          fileSize: photo.file_size,
          type: 'photo',
        });
      } else if (ctx.message.video) {
        attachedFiles.push({
          fileId: ctx.message.video.file_id,
          fileUniqueId: ctx.message.video.file_unique_id,
          fileName: ctx.message.video.file_name || 'video.mp4',
          fileSize: ctx.message.video.file_size,
          mimeType: ctx.message.video.mime_type,
          type: 'video',
        });
      } else if (ctx.message.audio) {
        attachedFiles.push({
          fileId: ctx.message.audio.file_id,
          fileUniqueId: ctx.message.audio.file_unique_id,
          fileName: ctx.message.audio.file_name || 'audio.mp3',
          fileSize: ctx.message.audio.file_size,
          mimeType: ctx.message.audio.mime_type,
          type: 'audio',
        });
      } else if (ctx.message.voice) {
        attachedFiles.push({
          fileId: ctx.message.voice.file_id,
          fileUniqueId: ctx.message.voice.file_unique_id,
          fileName: 'voice.ogg',
          fileSize: ctx.message.voice.file_size,
          mimeType: ctx.message.voice.mime_type,
          type: 'voice',
        });
      }

      // Очищаем временные файлы от предыдущего просмотра карточек
      const oldTransientFiles = userStore.takeTransientMessages(sender.id);
      for (const msgId of oldTransientFiles) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msgId);
        } catch {
          // ignore
        }
      }

      const result = await processTelegramMessage(sender, incomingText, attachedFiles);

      // Нижняя клавиатура инициализируется только после успешного входа в БАРС
      if (result.status === 'registered') {
        const userObj = userStore.get(sender.id);
        if (!userObj || !userObj.replyKeyboardSent) {
          try {
            const kbInit = await ctx.reply('Инициализация меню...', {
              reply_markup: BOTTOM_REPLY_KEYBOARD,
            });
            await ctx.api.deleteMessage(ctx.chat.id, kbInit.message_id);
            userStore.markReplyKeyboardSent(sender.id);
          } catch {
            // ignore
          }
        }
      }

      // Сначала публикуем в канал-хранилище: файлы копируются из входящего сообщения,
      // а удаляем мы его только после. Обратный порядок ломал копирование.
      if (result.newHomeworkCreated) {
        await archiveHomework(bot, result.newHomeworkCreated, ctx.chat.id, incomingMessageId);
      }
      if (result.newImportantCreated) {
        await archiveImportant(bot, result.newImportantCreated, ctx.chat.id, incomingMessageId);
      }

      // И только теперь удаляем входящее сообщение — чат остаётся чистым
      try {
        await ctx.deleteMessage();
      } catch {
        // ignore
      }

      const replyMarkup = result.keyboard
        ? { inline_keyboard: result.keyboard }
        : undefined;

      const existingMainMessageId = userStore.getMainMessageId(sender.id);
      let edited = false;

      if (existingMainMessageId) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            existingMainMessageId,
            result.messageText,
            { parse_mode: HTML_PARSE_MODE, reply_markup: replyMarkup }
          );
          edited = true;
        } catch {
          edited = false;
        }
      }

      if (!edited) {
        if (existingMainMessageId) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, existingMainMessageId);
          } catch {
            // ignore
          }
        }

        try {
          const sent = await ctx.reply(result.messageText, {
            parse_mode: HTML_PARSE_MODE,
            reply_markup: replyMarkup,
          });
          userStore.setMainMessageId(sender.id, sent.message_id);
        } catch (e) {
          console.error('[Telegram Bot] Reply failed:', e);
        }
      }

      // Файлы карточки — тоже при открытии по тексту, а не только по кнопке
      await deliverFiles(bot, sender.id, ctx.chat.id, result.filesToSend);
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

      const callbackData = ctx.callbackQuery.data;

      // Самоудаление фонового уведомления.
      //
      // Обрабатывается первым и до всего остального: клик не должен ни
      // затрагивать главный экран, ни удалять временные файлы открытой карточки —
      // это просто уборка уведомления из переписки.
      if (callbackData === 'notif_dismiss') {
        try {
          await ctx.answerCallbackQuery();
        } catch {}
        // Кнопка живёт на сообщении-уведомлении, но Telegram допускает
        // и callback без сообщения (например, через inline-режим) — тогда удалять нечего.
        const messageId = ctx.callbackQuery.message?.message_id;
        if (messageId === undefined) return;
        try {
          await ctx.api.deleteMessage(chatId, messageId);
        } catch (err) {
          console.warn('[Telegram Bot] Не удалось удалить уведомление:', err);
        }
        return;
      }

      // Удаляем временные файлы от предыдущего открытого занятия/ДЗ/важного
      const oldTransientFiles = userStore.takeTransientMessages(sender.id);
      for (const msgId of oldTransientFiles) {
        try {
          await ctx.api.deleteMessage(chatId, msgId);
        } catch {
          // ignore
        }
      }

      let result;
      try {
        result = await processTelegramCallback(sender, callbackData);
      } catch (err) {
        console.error('[Telegram Bot Callback Error]:', err);
        try {
          await ctx.answerCallbackQuery({ text: 'Произошла ошибка при обработке нажатия.' });
        } catch {}
        return;
      }

      // Удаление сообщений из канала-хранилища, если ДЗ или Важное было удалено
      const storageChannel = process.env.TELEGRAM_STORAGE_CHANNEL_ID;
      if (storageChannel && result.deletedChannelMessageIds && result.deletedChannelMessageIds.length > 0) {
        for (const msgId of result.deletedChannelMessageIds) {
          try {
            await bot.api.deleteMessage(storageChannel, msgId);
          } catch {}
        }
      }

      if (result.toast) {
        try {
          await ctx.answerCallbackQuery({
            text: result.toast,
            show_alert: callbackData === 'lunch_joke',
          });
        } catch {}
      } else {
        try {
          await ctx.answerCallbackQuery();
        } catch {}
      }

      if (result.messageText) {
        const replyMarkup = result.keyboard
          ? { inline_keyboard: result.keyboard }
          : undefined;

        try {
          await ctx.editMessageText(result.messageText, {
            parse_mode: HTML_PARSE_MODE,
            reply_markup: replyMarkup,
          });
        } catch (err) {
          console.warn('[Telegram Bot] Edit callback skipped:', err);
        }
      }

      // Файлы карточки отправляем в обход главного сообщения
      await deliverFiles(bot, sender.id, chatId, result.filesToSend);
    });

    const botInfo = await bot.api.getMe();
    botUsername = botInfo.username || null;

    console.log(`[Telegram Bot] Успешно запущен бот @${botUsername}!`);

    // Фоновый мониторинг БАРС/ОСЭП живёт в процессе бота, но не зависит от него:
    // любые сбои сети глушатся внутри воркера.
    startNotifier();

    // systemd шлёт SIGTERM при остановке/рестарте. Без этого снимки,
    // накопленные в памяти с последнего круга, потерялись бы, и после
    // рестарта бот повторно прислал бы уже отправленные уведомления.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        flushSnapshots();
        process.exit(0);
      });
    }

    bot.start({
      onStart: (info) => {
        console.log(`[Telegram Bot] Polling запущен для @${info.username}`);
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Telegram Bot] Ошибка запуска бота:', msg);
  }
}
