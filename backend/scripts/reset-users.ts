/**
 * Разовый сброс базы пользователей Mood (без ДЗ, объявлений и файлов).
 *
 * Сейчас данные живут в SQLite (`db/data/mood.sqlite`). Скрипт:
 * - бэкапит файл БД в `db/data/users.backup.sqlite`;
 * - бэкапит старый `users.json`, если он ещё лежит рядом;
 * - очищает таблицу `users` (остальные таблицы не трогает);
 * - оставляет пустой `users.json` — чтобы будущая миграция JSON → SQLite
 *   не вернула удалённых пользователей.
 *
 * Запускать при остановленном сервисе: у работающего процесса свои кэши.
 *
 * Запуск: npm run reset:users
 */

import fs from 'node:fs';
import path from 'node:path';

import { userStore } from '../../db/storage/userStore.ts';
import { closeDb, databaseFile } from '../../db/sqlite.ts';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_FILE = path.join(DATA_DIR, 'users.backup.json');
const DB_BACKUP = path.join(DATA_DIR, 'users.backup.sqlite');

const EMPTY_USERS = {
  users: {},
  index: { byTelegramId: {}, byBarsLoginHash: {} },
};

async function resetUsers(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const total = userStore.all().length;

  if (fs.existsSync(databaseFile)) {
    fs.copyFileSync(databaseFile, DB_BACKUP);
    console.log(
      `✅ Бэкап БД: ${path.relative(process.cwd(), DB_BACKUP)} (пользователей: ${total})`,
    );
  }

  if (fs.existsSync(USERS_FILE)) {
    fs.copyFileSync(USERS_FILE, BACKUP_FILE);
    console.log(`✅ Бэкап старого JSON: ${path.relative(process.cwd(), BACKUP_FILE)}`);
  }

  userStore.reset();
  closeDb();

  // Старый файл оставляем пустым: приложение его больше не читает, но миграция
  // не должна воскресить удалённых пользователей.
  fs.writeFileSync(USERS_FILE, `${JSON.stringify(EMPTY_USERS, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log('🧹 База пользователей очищена: таблица users пуста');
  console.log('ℹ️  Каждый, кто напишет боту или войдёт в PWA, заведёт запись заново.');
}

resetUsers().catch((err: unknown) => {
  console.error('❌ Ошибка сброса базы пользователей:', err);
  process.exit(1);
});
