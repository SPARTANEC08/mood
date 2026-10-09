import dotenv from 'dotenv';
import { initTelegramBot } from './src/bot/telegramService.ts';

dotenv.config();

console.log('==============================================');
console.log('🤖 Запуск Telegram-бота расписания НИУ МЭИ...');
console.log('==============================================');

initTelegramBot().catch((err) => {
  console.error('❌ Критическая ошибка при запуске бота:', err);
  process.exit(1);
});
