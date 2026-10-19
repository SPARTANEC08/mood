/**
 * Полное удаление одной записи пользователя вместе с сопутствующими данными.
 *
 * Заводится для разовых чисток: битая регистрация (например, БАРС вернул вместо
 * профиля заголовок страницы «Главная») оставляет мусорную запись, которая
 * портит статистику.
 *
 * Что удаляется: сама запись (`userStore.remove`), снимок БАРС для уведомлений
 * (`snapshotStore.remove`) и все файлы пользователя (`deleteAllFiles`).
 * Записи ДЗ и «Важного» по умолчанию НЕ трогаются: они принадлежат группе, а не
 * автору, и их удаление задело бы других. Их число печатается для справки.
 *
 * Запуск из корня проекта (там, где db/data/):
 *   npx tsx backend/scripts/delete-user.ts <userId>           # показать, что будет удалено
 *   npx tsx backend/scripts/delete-user.ts <userId> --yes      # удалить
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import { userStore } from '../../db/storage/userStore.ts';
import { snapshotStore } from '../../db/storage/snapshotStore.ts';
import { homeworkStore } from '../../db/storage/homeworkStore.ts';
import { importantStore } from '../../db/storage/importantStore.ts';
import { deleteAllFiles, getUserStorageUsage } from '../../db/storage/fileStore.ts';

dotenv.config();

/**
 * Убирает снимок и из памяти, и из файла.
 *
 * `snapshotStore.remove` меняет только кэш (это его штатное поведение — запись
 * идёт общим flush-ом в нотификаторе), поэтому на диске след остаётся. Здесь
 * файл правится сразу: иначе удалённый userId всплывёт при следующем flush
 * работающего процесса из его кэша.
 */
function purgeSnapshot(userId: string): void {
  snapshotStore.remove(userId);

  const file = path.resolve(process.cwd(), 'db', 'data', 'bars_snapshots.json');
  try {
    if (!fs.existsSync(file)) return;
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    if (doc && typeof doc === 'object' && userId in doc) {
      delete doc[userId];
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }
  } catch {
    // файл недоступен/битый — не критично для удаления записи
  }
}

async function main(): Promise<void> {
  const [userId, ...flags] = process.argv.slice(2);
  const confirmed = flags.includes('--yes');

  if (!userId) {
    console.error('Использование: npx tsx backend/scripts/delete-user.ts <userId> [--yes]');
    process.exit(1);
  }

  const user = userStore.getByUserId(userId);
  if (!user) {
    console.error(`Пользователь ${userId} не найден.`);
    process.exit(1);
  }

  const name = user.studentProfile?.fullName || user.firstName || '—';
  const snapshot = snapshotStore.get(userId);
  const filesBytes = await getUserStorageUsage(userId).catch(() => 0);
  const homework = homeworkStore.all().filter((h) => h.authorId === userId).length;
  const important = importantStore.all().filter((i) => i.authorId === userId).length;

  console.log('Запись:');
  console.log(`  userId:      ${userId}`);
  console.log(`  имя:         ${name}`);
  console.log(`  группа:      ${user.groupName ?? '—'}`);
  console.log(`  telegramId:  ${typeof user.telegramId === 'number' ? user.telegramId : 'нет'}`);
  console.log('Сопутствующее:');
  console.log(`  снимок БАРС: ${snapshot ? 'есть' : 'нет'}`);
  console.log(`  файлов:      ${filesBytes} байт`);
  console.log(`  ДЗ автора:   ${homework} (не удаляются)`);
  console.log(`  Важное:      ${important} (не удаляются)`);

  if (!confirmed) {
    console.log('\nЭто предпросмотр. Повторите с --yes, чтобы удалить запись, снимок и файлы.');
    return;
  }

  await deleteAllFiles(userId);
  purgeSnapshot(userId);
  const removed = userStore.remove(userId);

  console.log(removed ? '\nУдалено.' : '\nЗапись уже отсутствовала.');
  console.log(`Осталось пользователей: ${userStore.all().length}`);
}

main().catch((err: unknown) => {
  console.error('Ошибка:', err instanceof Error ? err.message : err);
  process.exit(1);
});
