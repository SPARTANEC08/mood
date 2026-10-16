/**
 * Разовый сброс базы пользователей Hub (без ДЗ, объявлений и файлов).
 *
 * - Бэкапит текущий data/users.json в data/users.backup.json
 * - Перезаписывает файл пустой формой НОВОЙ схемы
 *
 * Формат изменился вместе с ключом пользователя: теперь записи лежат под
 * userId (UUID), а рядом два индекса — по Telegram ID и по хэшу логина БАРС.
 * Запись `{}` больше не читается как база, поэтому пишется полная форма.
 *
 * Для полного сброса вместе с ДЗ и файлами есть scripts/reset-db.ts
 * (npm run reset:db).
 *
 * Запуск: npm run reset:users
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_FILE = path.join(DATA_DIR, 'users.backup.json');

function countUsers(file: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      users?: Record<string, unknown>;
    };
    // Файл мог остаться в старой форме (плоская карта telegramId -> запись),
    // поэтому при отсутствии поля users считаются верхнеуровневые ключи.
    return Object.keys(parsed.users ?? parsed).length;
  } catch {
    return 0;
  }
}

async function resetUsers(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const hadFile = fs.existsSync(USERS_FILE);
  const total = hadFile ? countUsers(USERS_FILE) : 0;

  if (hadFile && total > 0) {
    fs.copyFileSync(USERS_FILE, BACKUP_FILE);
    console.log(`✅ Бэкап создан: ${path.relative(process.cwd(), BACKUP_FILE)} (записей: ${total})`);
  } else if (hadFile) {
    // Пустая база: предыдущий бэкап не трогаем, чтобы его не потерять
    console.log('ℹ️  База уже пуста — бэкап не обновляется.');
  } else {
    console.log('ℹ️  Файл data/users.json не найден — бэкап не создается.');
  }

  // Пустая форма новой схемы: записи и оба индекса обязаны присутствовать,
  // иначе userStore посчитает файл пустым документом и перезапишет его сам.
  const empty = {
    users: {},
    index: { byTelegramId: {}, byBarsLoginHash: {} },
  };

  fs.writeFileSync(USERS_FILE, `${JSON.stringify(empty, null, 2)}\n`, { mode: 0o600 });
  console.log('🧹 База пользователей очищена: data/users.json — новая пустая схема');
  console.log('ℹ️  Теперь каждый, кто напишет боту, пройдёт вход через БАРС МЭИ.');
}

resetUsers().catch((err: unknown) => {
  console.error('❌ Ошибка сброса базы пользователей:', err);
  process.exit(1);
});