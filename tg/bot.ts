import dotenv from 'dotenv';
import { initTelegramBot } from './telegramService.ts';
import { startMaintenance } from '../backend/services/maintenance/run.ts';
import { validateSecrets } from '../backend/utils/secretsCheck.ts';
import { safeErrorMessage } from './format.ts';

dotenv.config();

// Ежедневная уборка диска не зависит от бота: запускаем до него, чтобы работала
// и в режиме «только API».
startMaintenance();

/*
 * Секреты проверяются ДО запуска бота и API. Неверный формат ключа раньше
 * всплывал только на первой операции шифрования — то есть сервис поднимался,
 * отвечал на /health и молча ломался на входе пользователя. Теперь ошибка
 * формата останавливает процесс сразу, а предупреждения видны в журнале.
 */
{
  const { errors, warnings } = validateSecrets();
  for (const warning of warnings) console.warn(`[secrets] ${warning}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[secrets] ${error}`);
    console.error('[secrets] Исправьте .env и перезапустите сервис.');
    process.exit(1);
  }
}

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
