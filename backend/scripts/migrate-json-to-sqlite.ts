/**
 * Одноразовая миграция JSON → SQLite.
 *
 * Запуск (при остановленном сервисе):
 *   npm run migrate:sqlite
 *   npm run migrate:sqlite -- --force   # перезаписать уже существующие данные
 *
 * Старые JSON-файлы НЕ удаляются: они остаются снимком для проверки и отката.
 * Приложение после миграции читает только SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';

import { closeDb, databaseFile, getDb } from '../../db/sqlite.ts';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');

/** Плоские сторы: файл — карта «ключ → запись». */
const FLAT_FILES = [
  'homework.json',
  'important.json',
  'bars_snapshots.json',
  'bot_flows.json',
  'admins.json',
] as const;

/** Документы: файл — один JSON целиком. */
const DOCUMENT_FILES = [
  'announcements.json',
  'registration.json',
  'stats_window.json',
  'stats_daily.json',
  'consents.json',
] as const;

function readJson(fileName: string): unknown {
  const file = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: unknown) {
    throw new Error(
      `Не удалось прочитать ${fileName}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function main(): void {
  const force = process.argv.includes('--force');
  const db = getDb();

  const counts = db
    .prepare(
      "SELECT (SELECT count(*) FROM users) AS users, " +
        "(SELECT count(*) FROM records) AS records, " +
        "(SELECT count(*) FROM documents) AS documents",
    )
    .get() as { users: number; records: number; documents: number };

  if ((counts.users > 0 || counts.records > 0 || counts.documents > 0) && !force) {
    console.error(
      `В SQLite уже есть данные (users=${counts.users}, records=${counts.records}, ` +
        `documents=${counts.documents}). Миграция остановлена.\n` +
        'Если нужно перезаписать — повторите с --force.',
    );
    process.exit(1);
  }

  const insertUser = db.prepare(
    'INSERT OR REPLACE INTO users(user_id, bars_login_hash, telegram_id, data, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertRecord = db.prepare(
    'INSERT OR REPLACE INTO records(store, key, value) VALUES (?, ?, ?)',
  );
  const insertDocument = db.prepare(
    'INSERT OR REPLACE INTO documents(name, value) VALUES (?, ?)',
  );

  let users = 0;
  let records = 0;
  let documents = 0;

  const migrate = db.transaction(() => {
    if (force) {
      db.exec('DELETE FROM users; DELETE FROM records; DELETE FROM documents;');
    }

    // ── пользователи ──────────────────────────────────────────────────────
    const usersJson = readJson('users.json');
    if (isRecord(usersJson) && isRecord(usersJson.users)) {
      const now = new Date().toISOString();

      for (const [userId, value] of Object.entries(usersJson.users)) {
        if (!isRecord(value)) continue;
        const user = value as Record<string, unknown>;
        const json = JSON.stringify(user);

        insertUser.run(
          userId,
          typeof user.barsLoginHash === 'string' ? user.barsLoginHash : '',
          typeof user.telegramId === 'number' ? user.telegramId : null,
          json,
          typeof user.createdAt === 'string' ? user.createdAt : now,
          typeof user.updatedAt === 'string' ? user.updatedAt : now,
        );
        users += 1;
      }
    }

    // ── плоские сторы ─────────────────────────────────────────────────────
    for (const fileName of FLAT_FILES) {
      const data = readJson(fileName);
      if (!isRecord(data)) continue;

      for (const [key, value] of Object.entries(data)) {
        insertRecord.run(fileName, key, JSON.stringify(value));
        records += 1;
      }
    }

    // ── документы ─────────────────────────────────────────────────────────
    for (const fileName of DOCUMENT_FILES) {
      const data = readJson(fileName);
      if (data === null) continue;
      insertDocument.run(fileName, JSON.stringify(data));
      documents += 1;
    }
  });

  migrate();

  console.log(`\n✅ Миграция JSON → SQLite завершена: ${databaseFile}`);
  console.log(`   пользователей: ${users}`);
  console.log(`   записей:       ${records}`);
  console.log(`   документов:    ${documents}`);
  console.log('\nСтарые JSON-файлы оставлены на месте. Удаляйте их только после проверки.\n');

  closeDb();
}

main();
