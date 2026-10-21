/**
 * SQLite: одно файловое хранилище вместо набора JSON-файлов.
 *
 * ── Почему SQLite ───────────────────────────────────────────────────────────
 *
 * Старые сторы переписывали файл целиком на каждое изменение: `users.json`
 * (~100 КБ) — при каждом patch, `bars_snapshots.json` — на каждый flush,
 * `stats_window.json` — каждые 5 минут. На 1 vCPU это лишний I/O и память.
 *
 * Здесь:
 *   - `users` — отдельная строка на пользователя (индексы по логину и Telegram);
 *   - `records` — плоские сторы (ДЗ, «Важное», снимки, админы, bot flows);
 *   - `documents` — небольшие документы (объявления, регистрация, статистика,
 *     согласия), которые пока удобнее хранить одним JSON.
 *
 * WAL + synchronous=NORMAL: запись не ждёт fsync на каждый коммит, читатели не
 * блокируют писателя. Процесс один, поэтому этого достаточно.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');
const DB_FILE = path.join(DATA_DIR, 'mood.sqlite');

let db: Database.Database | null = null;

/** Ленивое открытие: тесты успевают сделать chdir до первого обращения. */
export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  const instance = new Database(DB_FILE);
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('foreign_keys = ON');

  instance.exec(`
    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (store, key)
    );

    CREATE TABLE IF NOT EXISTS documents (
      name  TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id         TEXT PRIMARY KEY,
      bars_login_hash TEXT NOT NULL,
      telegram_id     INTEGER,
      data            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_bars_hash ON users(bars_login_hash);
    CREATE INDEX IF NOT EXISTS idx_users_telegram  ON users(telegram_id);
  `);

  try {
    fs.chmodSync(DATA_DIR, 0o700);
    fs.chmodSync(DB_FILE, 0o600);
  } catch {
    // Права выставит umask/система; отсутствие chmod не критично.
  }

  db = instance;
  return db;
}

/** Закрыть соединение — для скриптов и тестов. */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

/** Путь к файлу БД — для скриптов бэкапа/миграции. */
export const databaseFile = DB_FILE;
