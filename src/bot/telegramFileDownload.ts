/**
 * Скачивание файла из Telegram по file_id.
 *
 * Отдельный модуль, потому что его используют две несвязанные стороны:
 * бот (кладёт присланный файл в файловое хранилище) и fileStore (импортирует
 * отсюда буфер). Вынесено, чтобы не было цикла импортов между хранилищем и
 * сервисом Telegram.
 *
 * Само по себе это последнее место в проекте, где ещё нужен Bot API для
 * файлов: приём файла от пользователя. Всё остальное (показ, отправка) идёт
 * уже с диска.
 */

import { getBotInstance } from './telegramService.ts';

/**
 * Возвращает содержимое файла из Telegram.
 *
 * У file_id есть срок жизни (около суток), поэтому файл нужно забрать сразу:
 * завтра тот же file_id уже может не отдаться. Именно поэтому бот сохраняет
 * присланный файл на диск немедленно, а не «когда понадобится».
 */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const bot = getBotInstance();

  if (!bot) {
    throw new Error('Бот не запущен: файл из Telegram недоступен.');
  }

  const result = await bot.api.getFile(fileId);

  if (!result.file_path) {
    throw new Error('Telegram не вернул путь к файлу.');
  }

  // Bot API отдаёт содержимое только по этому адресу и только с серверным токеном.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error('Не задан TELEGRAM_BOT_TOKEN.');
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram вернул ${response.status} при скачивании файла.`);
  }

  return Buffer.from(await response.arrayBuffer());
}