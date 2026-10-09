/**
 * Разовый сброс базы пользователей Zbot.
 *
 * - Бэкапит текущий data/users.json в data/users.backup.json
 * - Перезаписывает data/users.json пустым объектом {}
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
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return Object.keys(parsed).length;
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

  fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2), 'utf-8');
  console.log('🧹 База пользователей очищена: data/users.json = {}');
  console.log('ℹ️  Теперь каждый, кто напишет боту, пройдёт вход через БАРС МЭИ.');
}

resetUsers().catch((err: unknown) => {
  console.error('❌ Ошибка сброса базы пользователей:', err);
  process.exit(1);
});