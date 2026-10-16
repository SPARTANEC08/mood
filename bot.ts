import dotenv from 'dotenv';
import { initTelegramBot } from './src/bot/telegramService.ts';
import { safeErrorMessage } from './src/bot/format.ts';

dotenv.config();

/*
 * Последний предохранитель процесса.
 *
 * В Node 15+ необработанный rejected промис по умолчанию ОБРЫВАЕТ процесс. У нас
 * в одном процессе и бот, и API, и фоновый нотификатор: любой потерянный reject
 * (например, EPIPE при обрыве скачивания файла, который клиент закрыл) ронял бы
 * всё сразу — пропадал API, и приложение «перезагружалось». Логируем и
 * продолжаем вместо падения; по-настоящему фатальные вещи по-прежнему видит
 * systemd.
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
console.log('🤖 Запуск Telegram-бота расписания НИУ МЭИ...');
console.log('==============================================');

initTelegramBot().catch((err) => {
  console.error('❌ Критическая ошибка при запуске бота:', safeErrorMessage(err));
  process.exit(1);
});
