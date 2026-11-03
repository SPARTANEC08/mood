/**
 * Точка входа Telegram-бота.
 *
 * Это ОТДЕЛЬНЫЙ процесс, и это важно: бот — только распространитель ссылок.
 * Он не открывает базу, не ходит в БАРС и OWA, не поднимает REST API и не
 * запускает нотификатор. Ему нужны ровно две переменные окружения:
 *
 *   TELEGRAM_BOT_TOKEN — токен от @BotFather;
 *   PWA_URL            — публичный адрес приложения для кнопки «Установить».
 *
 * Необязательная TELEGRAM_APK_POST_URL задаёт пост с последней версией APK
 * для кнопки «Скачать из Telegram». Сам файл бот не хранит и не отправляет:
 * установка идёт с лендинга или из поста канала.
 *
 * Приложение (API + нотификатор + Web Push + отчёты) живёт в соседнем процессе
 * `backend/server/main.ts` (`dist/app.js`) и запускается своим systemd-юнитом.
 * Общих модулей у процессов нет, поэтому падение или компрометация бота не
 * даёт доступа к персональным данным студентов.
 */

import 'dotenv/config';

import { safeErrorMessage } from './format.ts';
import { initTelegramBot } from './telegramService.ts';

/*
 * Последний предохранитель процесса.
 *
 * В Node 15+ необработанный rejected промис по умолчанию обрывает процесс.
 * У бота нет ничего, что стоило бы ронять целиком из-за одного потерянного
 * reject: long polling сам восстановится. Логируем и продолжаем.
 */
process.on('unhandledRejection', (reason) => {
  console.error(
    '[process] Необработанный rejected промис (процесс продолжает работу):',
    safeErrorMessage(reason),
  );
});

process.on('uncaughtException', (err) => {
  console.error(
    '[process] Необработанное исключение (процесс продолжает работу):',
    safeErrorMessage(err),
  );
});

console.log('==============================================');
console.log('🤖 Запуск Telegram-бота поддержки Mood...');
console.log('==============================================');

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';

if (!token || token === 'MY_TELEGRAM_BOT_TOKEN') {
  console.error('[Telegram Bot] TELEGRAM_BOT_TOKEN не задан — бот не запустится.');
  process.exit(1);
}

if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
  console.error('[Telegram Bot] TELEGRAM_BOT_TOKEN не похож на токен BotFather.');
  process.exit(1);
}

initTelegramBot().catch((err) => {
  console.error('❌ Критическая ошибка при запуске бота:', safeErrorMessage(err));
  process.exit(1);
});
