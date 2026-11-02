/**
 * Ежедневная уборка диска и мониторинг свободного места.
 *
 * Зачем. Диск 10 ГБ не расширяется, а данные растут: файлы ДЗ/«Важного»,
 * превью, отчёты HTML, бэкапы, временные файлы. Без лимитов и уборки однажды
 * кончается место — и первым делом падают именно загрузки.
 *
 * Что убираем:
 *  - превью старше 30 дней (их всегда можно пересобрать из оригинала sharp-ом);
 *  - «осиротевшие» файлы: записи ДЗ/«Важного» удалены, а .bin/.meta остались;
 *  - временные `.tmp`, оставшиеся после сбоя записи;
 *  - отчёты старше 30 дней;
 *  - каталоги бэкапов `db/data/backup/*` старше 7 дней (бэкап должен лежать
 *    ВНЕ сервера; на диске держим только страховку на несколько дней).
 *
 * Селекторы вынесены отдельными чистыми функциями: их проверяем тестами без
 * реального диска, а сам прогон лишь читает каталоги и вызывает unlink/rm.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Превью живут 30 дней: пересобираются из оригинала. */
export const PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `.tmp` старше часа — мусор после сбоя записи. */
export const TMP_TTL_MS = 60 * 60 * 1000;

/** Свежие файлы без ссылки в записях не трогаем сутки: человек мог только что загрузить. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Отчёты храним 30 дней. */
export const REPORT_TTL_DAYS = 30;

/** Бэкапы на том же диске — не дольше недели. */
export const BACKUP_TTL_DAYS = 7;

/** Брошенные гостевые профили живут 30 дней с последней активности. */
export const GUEST_TTL_DAYS = 30;
export const GUEST_TTL_MS = GUEST_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Порог свободного места для отказа в загрузке. */
export const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;

/** Доля занятого диска, после которой пишем предупреждение. */
export const DISK_WARN_RATIO = 0.8;

export interface FileEntry {
  filePath: string;
  mtimeMs: number;
}

/**
 * Превью старше TTL.
 *
 * Обязательно проверяем ИМЯ: в каталоге пользователя рядом лежат `.bin` и
 * `.meta.json` — без фильтра по шаблону `.preview-<width>.jpg` уборка удалила
 * бы старый оригинал, посчитав его «превью». Это была реальная ошибка,
 * которую поймал тест полного прогона.
 */
const PREVIEW_NAME_RE = /\.preview-\d+\.jpg$/;

export function selectExpiredPreviews(entries: FileEntry[], now: number, ttlMs = PREVIEW_TTL_MS): string[] {
  return entries
    .filter((entry) => PREVIEW_NAME_RE.test(entry.filePath))
    .filter((entry) => now - entry.mtimeMs > ttlMs)
    .map((entry) => entry.filePath);
}

/** Временные файлы старше TTL. */
export function selectStaleTmp(entries: FileEntry[], now: number, ttlMs = TMP_TTL_MS): string[] {
  return entries.filter((entry) => now - entry.mtimeMs > ttlMs).map((entry) => entry.filePath);
}

/**
 * Осиротевшие основные файлы: нет ссылки в записях и файл старше суток.
 * Ключ ссылки — `${uploadedBy}:${fileId}`: один и тот же fileId в разных
 * каталогах пользователей не должен считаться ссылкой.
 */
export function selectOrphanFiles(
  files: Array<FileEntry & { userId: string; fileId: string }>,
  referenced: ReadonlySet<string>,
  now: number,
  minAgeMs = ORPHAN_MIN_AGE_MS,
): string[] {
  return files
    .filter((file) => !referenced.has(`${file.userId}:${file.fileId}`))
    .filter((file) => now - file.mtimeMs > minAgeMs)
    .map((file) => file.filePath);
}

/** Отчёты старше N дней по имени `stats-YYYY.MM.DD.html`. */
export function selectOldReports(names: string[], now: number, ttlDays = REPORT_TTL_DAYS): string[] {
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  const out: string[] = [];

  for (const name of names) {
    const match = /^stats-(\d{4})\.(\d{2})\.(\d{2})\.html$/.exec(name);
    if (!match) continue;
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (time < cutoff) out.push(name);
  }

  return out;
}

/** Каталоги бэкапов старше N дней. */
export function selectOldBackups(dirs: FileEntry[], now: number, ttlDays = BACKUP_TTL_DAYS): string[] {
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  return dirs.filter((dir) => dir.mtimeMs < cutoff).map((dir) => dir.filePath);
}

export interface GuestActivity {
  id: string;
  isGuest: boolean;
  /** Последняя реальная активность, ms (0 — не было). */
  lastActiveAt: number;
}

/**
 * Брошенные гости: только `isGuest`, без активности дольше TTL.
 *
 * Гость — временный профиль без БАРС и контента. Если человек удалил приложение
 * или потерял токен, запись иначе осталась бы в users и в статистике навсегда.
 */
export function selectStaleGuestIds(
  entries: GuestActivity[],
  now: number,
  ttlMs = GUEST_TTL_MS,
): string[] {
  const cutoff = now - ttlMs;
  return entries
    .filter((entry) => entry.isGuest && entry.lastActiveAt < cutoff)
    .map((entry) => entry.id);
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedRatio: number;
}

/** Свободное место для каталога данных. null — платформа не отдала статистику. */
export async function getDiskUsage(dir: string): Promise<DiskUsage | null> {
  try {
    const stat = await fs.statfs(dir);
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    return { totalBytes, freeBytes, usedRatio: totalBytes > 0 ? 1 - freeBytes / totalBytes : 0 };
  } catch {
    return null;
  }
}
