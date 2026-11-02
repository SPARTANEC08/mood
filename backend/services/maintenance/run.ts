/**
 * Прогон уборки: читает каталоги, применяет селекторы из cleanup.ts и удаляет
 * лишнее. Любая ошибка глушится — уборка не должна ронять процесс бота.
 *
 * Запускается сразу после старта (с задержкой) и раз в сутки.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { homeworkStore } from '../../../db/storage/homeworkStore.ts';
import { importantStore } from '../../../db/storage/importantStore.ts';
import { userStore, type StoredUser } from '../../../db/storage/userStore.ts';
import { getDb } from '../../../db/sqlite.ts';
import { activityByUser } from '../../server/devStats.ts';
import { deleteAccount } from '../account/deleteAccount.ts';
import {
  BACKUP_TTL_DAYS,
  DISK_WARN_RATIO,
  getDiskUsage,
  GUEST_TTL_DAYS,
  PREVIEW_TTL_MS,
  REPORT_TTL_DAYS,
  selectExpiredPreviews,
  selectOldBackups,
  selectOldReports,
  selectOrphanFiles,
  selectStaleGuestIds,
  selectStaleTmp,
  TMP_TTL_MS,
  type FileEntry,
} from './cleanup.ts';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');

export interface MaintenanceResult {
  previews: number;
  orphans: number;
  tmp: number;
  reports: number;
  backups: number;
  guests: number;
  freeMb: number | null;
}

async function listFiles(dir: string): Promise<Array<FileEntry & { name: string }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<FileEntry & { name: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) out.push({ filePath, name: entry.name, mtimeMs: stat.mtimeMs });
    }
    return out;
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<FileEntry[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) out.push({ filePath, mtimeMs: stat.mtimeMs });
    }
    return out;
  } catch {
    return [];
  }
}

async function removeAll(paths: string[], options: { recursive?: boolean } = {}): Promise<number> {
  let removed = 0;
  for (const target of paths) {
    try {
      await fs.rm(target, { force: true, recursive: options.recursive === true });
      removed += 1;
    } catch {
      // уже удалено или занято
    }
  }
  return removed;
}

/** Собирает ссылки на файлы из всех записей ДЗ и «Важного» (все группы). */
function referencedFiles(): Set<string> {
  const referenced = new Set<string>();
  for (const record of [...homeworkStore.all(), ...importantStore.all()]) {
    for (const file of record.files ?? []) {
      referenced.add(`${file.uploadedBy}:${file.fileId}`);
    }
  }
  return referenced;
}

/** Последняя активность гостя: запросы, правки записи и токены. */
function lastActivityAt(user: StoredUser, activity: Map<string, number>): number {
  let last = Date.parse(user.updatedAt) || 0;

  const live = activity.get(user.userId) ?? 0;
  if (live > last) last = live;

  for (const token of user.pwaTokens ?? []) {
    const used = Date.parse(token.lastUsedAt ?? '') || 0;
    const created = Date.parse(token.createdAt) || 0;
    const tokenTime = Math.max(used, created);
    if (tokenTime > last) last = tokenTime;
  }

  return last;
}

export async function runMaintenance(now: number = Date.now()): Promise<MaintenanceResult> {
  // Обслуживание SQLite: раз в сутки — дешево, а планировщику даёт статистику
  // для индексов, которая иначе копится только при ANALYZE вручную.
  try {
    getDb().pragma('optimize');
  } catch (err: unknown) {
    console.warn(
      '[Maintenance] PRAGMA optimize не выполнен:',
      err instanceof Error ? err.message : err,
    );
  }

  // Брошенные гости — до обхода файлов: deleteAccount убирает и их каталог,
  // чтобы уборка не считала его содержимое сиротами.
  let guests = 0;
  const activity = activityByUser(now);
  const guestUsers = userStore
    .all()
    .filter((user) => user.isGuest === true)
    .map((user) => ({ user, lastActiveAt: lastActivityAt(user, activity) }));
  const staleGuestIds = new Set(
    selectStaleGuestIds(
      guestUsers.map(({ user, lastActiveAt }) => ({ id: user.userId, isGuest: true, lastActiveAt })),
      now,
    ),
  );

  for (const { user } of guestUsers) {
    if (!staleGuestIds.has(user.userId)) continue;
    try {
      await deleteAccount(user);
      guests += 1;
    } catch (err: unknown) {
      console.warn(
        '[Maintenance] не удалось удалить гостя:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (guests > 0) {
    console.log(`[Maintenance] удалено брошенных гостей: ${guests} (TTL ${GUEST_TTL_DAYS} дн.)`);
  }

  const referenced = referencedFiles();

  const userDirs = await listDirs(FILES_DIR);
  const previewPaths: string[] = [];
  const mainFiles: Array<FileEntry & { userId: string; fileId: string }> = [];

  for (const dir of userDirs) {
    const userId = path.basename(dir.filePath);
    const files = await listFiles(dir.filePath);
    // Только превью: .bin и .meta.json удаляются отдельной веткой (сироты),
    // иначе старый оригинал мог быть стёрт как «превью».
    const previewsOnly = files.filter((file) => /\.preview-\d+\.jpg$/.test(file.name));
    previewPaths.push(...selectExpiredPreviews(previewsOnly, now, PREVIEW_TTL_MS));
    for (const file of files) {
      const match = /^([0-9a-f-]{36})\.bin$/.exec(file.name);
      if (match) mainFiles.push({ ...file, userId, fileId: match[1]! });
    }
  }

  const previews = await removeAll(previewPaths);
  const orphans = await removeAll(selectOrphanFiles(mainFiles, referenced, now));

  // .tmp лежат рядом с данными (db/data и подкаталоги) — берём два уровня.
  const tmpCandidates: FileEntry[] = [];
  for (const dir of [DATA_DIR, ...userDirs.map((d) => d.filePath)]) {
    const files = await listFiles(dir);
    tmpCandidates.push(...files.filter((file) => file.name.endsWith('.tmp')));
  }
  const tmp = await removeAll(selectStaleTmp(tmpCandidates, now, TMP_TTL_MS));

  const reportNames = (await listFiles(REPORTS_DIR)).map((file) => file.name);
  const reports = await removeAll(
    selectOldReports(reportNames, now, REPORT_TTL_DAYS).map((name) => path.join(REPORTS_DIR, name)),
  );

  const backups = await removeAll(selectOldBackups(await listDirs(BACKUP_DIR), now, BACKUP_TTL_DAYS), {
    recursive: true,
  });

  const disk = await getDiskUsage(DATA_DIR);
  if (disk) {
    const freeMb = Math.round(disk.freeBytes / 1024 / 1024);
    const usedPercent = Math.round(disk.usedRatio * 100);
    console.log(
      `[Maintenance] превью: ${previews}, сироты: ${orphans}, tmp: ${tmp}, отчёты: ${reports}, бэкапы: ${backups}, гости: ${guests}; ` +
        `диск занят ${usedPercent}%, свободно ${freeMb} МБ.`,
    );
    if (disk.usedRatio > DISK_WARN_RATIO) {
      console.warn(`[Maintenance] ВНИМАНИЕ: диск заполнен на ${usedPercent}% — пора чистить.`);
    }
    return { previews, orphans, tmp, reports, backups, guests, freeMb };
  }

  console.log(
    `[Maintenance] превью: ${previews}, сироты: ${orphans}, tmp: ${tmp}, отчёты: ${reports}, бэкапы: ${backups}, гости: ${guests}.`,
  );
  return { previews, orphans, tmp, reports, backups, guests, freeMb: null };
}

/** Запуск по расписанию: первый прогон через 10 минут, дальше раз в сутки. */
export function startMaintenance(): void {
  const timer = setInterval(() => {
    void runMaintenance().catch((err: unknown) => {
      console.error('[Maintenance] ошибка уборки:', err instanceof Error ? err.message : err);
    });
  }, 24 * 60 * 60 * 1000);
  timer.unref?.();

  const first = setTimeout(() => {
    void runMaintenance().catch((err: unknown) => {
      console.error('[Maintenance] ошибка уборки:', err instanceof Error ? err.message : err);
    });
  }, 10 * 60 * 1000);
  first.unref?.();

  console.log('[Maintenance] ежедневная уборка включена (первая — через 10 мин).');
}

export { REPORT_TTL_DAYS };
