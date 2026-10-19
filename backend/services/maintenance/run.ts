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
import {
  BACKUP_TTL_DAYS,
  DISK_WARN_RATIO,
  getDiskUsage,
  PREVIEW_TTL_MS,
  REPORT_TTL_DAYS,
  selectExpiredPreviews,
  selectOldBackups,
  selectOldReports,
  selectOrphanFiles,
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

export async function runMaintenance(now: number = Date.now()): Promise<MaintenanceResult> {
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
      `[Maintenance] превью: ${previews}, сироты: ${orphans}, tmp: ${tmp}, отчёты: ${reports}, бэкапы: ${backups}; ` +
        `диск занят ${usedPercent}%, свободно ${freeMb} МБ.`,
    );
    if (disk.usedRatio > DISK_WARN_RATIO) {
      console.warn(`[Maintenance] ВНИМАНИЕ: диск заполнен на ${usedPercent}% — пора чистить.`);
    }
    return { previews, orphans, tmp, reports, backups, freeMb };
  }

  console.log(
    `[Maintenance] превью: ${previews}, сироты: ${orphans}, tmp: ${tmp}, отчёты: ${reports}, бэкапы: ${backups}.`,
  );
  return { previews, orphans, tmp, reports, backups, freeMb: null };
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
