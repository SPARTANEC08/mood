/**
 * Точка входа приложения Mood (PWA/TWA): API + нотификатор + отчёты.
 *
 * Это ОТДЕЛЬНЫЙ процесс от Telegram-бота. Здесь всё, что работает с данными
 * студентов и внешними системами:
 *
 *   - REST API для PWA (`backend/server/index.ts`);
 *   - фоновый опрос БАРС/OWA и Web Push (`startNotifier`);
 *   - ночной отчёт администраторам (`startDailyReport`);
 *   - уборка диска (`startMaintenance`).
 *
 * Бот (`tg/bot.ts`, `dist/app.js` vs `dist/bot.js`) не импортирует ни один из
 * этих модулей: он только раздаёт ссылки. Такое разделение позволяет держать
 * бота на одном сервере, а приложение с базой и ключами — на другом, и не
 * даёт скомпрометированному боту доступ к персональным данным.
 *
 * Запуск: `node dist/app.js` (прод) или `npx tsx backend/server/main.ts` (dev).
 */

import 'dotenv/config';

import { startMaintenance } from '../services/maintenance/run.ts';
import { startDailyReport } from '../services/notifications/dailyReport.ts';
import { flushSnapshots, startNotifier } from '../services/notifications/barsNotifier.ts';
import { migrateCookieEncryption } from '../../db/storage/userSecrets.ts';
import { safeErrorMessage } from '../../tg/format.ts';
import { validateSecrets } from '../utils/secretsCheck.ts';
import { startServer } from './index.ts';

/*
 * Разовая миграция старых записей: cookie БАРС/OWA из плейнтекста в шифр.
 *
 * Запускается при остановленном сервисе:
 *   node dist/app.js --migrate-cookies
 * Иначе кэш пользователей в работающем процессе перезапишет строки старым
 * содержимым. После миграции сервис стартует обычным образом.
 */
if (process.argv.includes('--migrate-cookies')) {
  try {
    const result = migrateCookieEncryption();
    console.log(
      `[migrate] cookie: проверено ${result.scanned}, зашифровано ${result.updated}, пропущено ${result.skipped}.`,
    );
    process.exit(0);
  } catch (err: unknown) {
    console.error('[migrate] не удалось зашифровать cookie:', safeErrorMessage(err));
    process.exit(1);
  }
}

// Ежедневная уборка диска не зависит от API: запускаем до него, чтобы работала
// и в режиме «только нотификатор».
startMaintenance();

/*
 * Секреты проверяются ДО старта API. Неверный формат ключа раньше всплывал
 * только на первой операции шифрования — то есть сервис поднимался, отвечал на
 * /health и молча ломался на входе пользователя. Теперь ошибка формата
 * останавливает процесс сразу, а предупреждения видны в журнале.
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
 * в одном процессе API, нотификатор и уборка: любой потерянный reject
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

/** Снимки БАРС копятся в памяти: при остановке их нужно сбросить на диск. */
function setupShutdown(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      flushSnapshots();
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  console.log('==============================================');
  console.log('🌐 Запуск Mood: API + уведомления...');
  console.log('==============================================');

  // API включается только при заданном порту — так же, как раньше.
  if (process.env.API_PORT) {
    try {
      await startServer();
    } catch (err: unknown) {
      console.error('[API] Не удалось запустить сервер PWA:', safeErrorMessage(err));
      process.exit(1);
    }
  } else {
    console.warn('[API] API_PORT не задан — REST API не поднимается.');
  }

  startNotifier();
  startDailyReport();
  setupShutdown();
}

main().catch((err: unknown) => {
  console.error('❌ Критическая ошибка при запуске приложения:', safeErrorMessage(err));
  process.exit(1);
});
