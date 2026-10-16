/**
 * Полный сброс базы Hub: пользователи, ДЗ, объявления, снимки и файлы.
 *
 * Зачем он шире старого reset:users. Схема базы поменялась целиком. Ключом
 * человека стал userId (UUID), а не telegramId, появился barsLoginHash как
 * общая точка бота и PWA, а файлы переехали из Telegram-канала на диск. Старые
 * данные в новой схеме не имеют смысла — их нельзя ни прочитать, ни свести, и
 * миграции для них не пишется намеренно (см. «Не мигрировать старые данные»).
 *
 * Что происходит:
 *  - каждый затронутый файл копируется в data/backup/<метка>/ — откат возможен;
 *  - файлы перезаписываются пустой формой НОВОЙ схемы, а не `{}`;
 *  - каталог data/files очищается целиком: файлы без записей — мусор, а записи
 *    всё равно удаляются;
 *  - права на файлы остаются 0600, каталоги 0700 (в базе шифрованные креды).
 *
 * Что НЕ делается: папка data/ не удаляется. В ней может лежать то, что этому
 * скрипту неизвестно, и rm -rf по каталогу с данными — плохая идея даже при
 * намерении «начать с нуля».
 *
 * Запуск:
 *   npm run reset:db            — с бэкапом
 *   npm run reset:db -- --force — без бэкапа и без вопросов
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const FILES_DIR = path.join(DATA_DIR, 'files');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Пустая форма users.json новой схемы: записи и оба индекса. */
const EMPTY_USERS = {
  users: {},
  index: { byTelegramId: {}, byBarsLoginHash: {} },
};

/** Метка каталога бэкапа: время в UTC, безопасное для имени каталога. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Сколько записей в файле — только чтобы показать в отчёте. */
function describe(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const users = (parsed.users ?? parsed) as Record<string, unknown>;

    return `${Object.keys(users).length} записей`;
  } catch {
    return 'нечитаемый или отсутствует';
  }
}

/** Сколько файлов и сколько байт в data/files. */
function describeFiles(): string {
  if (!fs.existsSync(FILES_DIR)) return 'каталога нет';

  let files = 0;
  let bytes = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      if (!entry.name.endsWith('.bin')) continue;

      files += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        // файл мог исчезнуть — не считаем
      }
    }
  };

  walk(FILES_DIR);
  return `${files} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function backupDir(): string {
  const dir = path.join(BACKUP_DIR, stamp());
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/** Копирует файл в бэкап и затирает новой формой. */
function resetJson(fileName: string, emptyValue: unknown, backup: string | null): void {
  const file = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(file)) {
    console.log(`   · ${fileName}: не существует — создаю пустую`);
  } else if (backup) {
    fs.copyFileSync(file, path.join(backup, fileName));
    console.log(`   · ${fileName}: сброслен, копия в ${path.relative(process.cwd(), backup)}`);
  } else {
    console.log(`   · ${fileName}: сброслен без копии (--force)`);
  }

  fs.writeFileSync(file, `${JSON.stringify(emptyValue, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: FILE_MODE,
  });
}

function resetFiles(backup: string | null): void {
  if (!fs.existsSync(FILES_DIR)) {
    console.log('   · data/files: каталога нет — нечего чистить');
    return;
  }

  if (backup) {
    // Файлы копируются целиком: структура вложенных каталогов сохраняется,
    // и откат — это просто возврат каталога на место.
    fs.cpSync(FILES_DIR, path.join(backup, 'files'), { recursive: true });
    console.log(`   · data/files: очищен, копия в ${path.relative(process.cwd(), backup)}/files`);
  } else {
    console.log('   · data/files: очищен без копии (--force)');
  }

  fs.rmSync(FILES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: DIR_MODE });
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  console.log('🧹 Сброс базы Hub\n');

  console.log('До сброса:');
  console.log(`   · users.json — ${describe(path.join(DATA_DIR, 'users.json'))}`);
  console.log(`   · homework.json — ${describe(path.join(DATA_DIR, 'homework.json'))}`);
  console.log(`   · important.json — ${describe(path.join(DATA_DIR, 'important.json'))}`);
  console.log(`   · bars_snapshots.json — ${describe(path.join(DATA_DIR, 'bars_snapshots.json'))}`);
  console.log(`   · data/files — ${describeFiles()}`);
  console.log('');

  // Вопрос задаётся только в терминале: при запуске из пайплайна или CI
  // stdin не TTY, ждать ответа некому — там работает --force.
  if (!force && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      '\nУдалить все пользователей, ДЗ, объявления, снимки и файлы? Бэкап будет создан в data/backup/. (y/N) ',
    );
    rl.close();

    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Отменено, база не тронута.');
      return;
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
  const backup = force ? null : backupDir();

  resetJson('users.json', EMPTY_USERS, backup);
  resetJson('homework.json', {}, backup);
  resetJson('important.json', {}, backup);
  resetJson('bars_snapshots.json', {}, backup);
  resetFiles(backup);

  // Права выставляются ещё раз: mkdir выше мог отдать каталог с umask.
  try {
    fs.chmodSync(DATA_DIR, DIR_MODE);
    fs.chmodSync(FILES_DIR, DIR_MODE);
  } catch {
    // нет прав — не критично, содержимое пустое
  }

  console.log('\n✅ База пуста.');
  console.log('   Каждый, кто напишет боту, пройдёт вход через БАРС МЭИ.');
  console.log('   Вход в PWA — логином и паролем БАРС, база заведётся заново.');

  if (process.env.ENCRYPTION_SECRET_KEY) {
    console.log('\n⚠️  ENCRYPTION_SECRET_KEY задан: зашифрованные креды старой базы');
    console.log('   больше не расшифруются этим ключом, если он был заменён.');
  }
}

await main();
