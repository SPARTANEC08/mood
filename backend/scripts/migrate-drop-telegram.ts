/**
 * Миграция: убрать Telegram из данных.
 *
 * Что делает:
 *   - удаляет `telegramId` и `notificationsEnabled` из записей пользователей;
 *   - обнуляет колонку `telegram_id` в таблице users;
 *   - очищает назначенных TG-админов (`admins.json`) и состояния бота
 *     (`bot_flows.json`).
 *
 * Push-подписки, pushEnabled и PWA-токены НЕ трогаются.
 *
 * Запуск (с бэкапом БД):
 *   npm run migrate:drop-telegram
 */

import { getDb } from '../../db/sqlite.ts';
import { userStore } from '../../db/storage/userStore.ts';

function main(): void {
  const db = getDb();
  const users = userStore.all();

  let cleared = 0;
  for (const user of users) {
    if (user.telegramId === undefined && user.notificationsEnabled === undefined) continue;

    userStore.patchByUserId(user.userId, {
      telegramId: undefined,
      notificationsEnabled: undefined,
    });
    cleared += 1;
  }

  const nulled = db.prepare('UPDATE users SET telegram_id = NULL WHERE telegram_id IS NOT NULL').run();
  const admins = db.prepare("DELETE FROM records WHERE store = 'admins.json'").run();
  const flows = db.prepare("DELETE FROM records WHERE store = 'bot_flows.json'").run();

  console.log(`[migrate] пользователей очищено: ${cleared}`);
  console.log(`[migrate] строк users.telegram_id обнулено: ${nulled.changes}`);
  console.log(`[migrate] TG-админов удалено: ${admins.changes}`);
  console.log(`[migrate] состояний бота удалено: ${flows.changes}`);
  console.log('[migrate] готово');
}

main();
