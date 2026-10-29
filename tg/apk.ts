/**
 * Поиск последнего собранного APK для выдачи в Telegram.
 *
 * Бот не знает, установил ли человек APK, и не должен: он просто отдаёт файл
 * (если он лежит рядом с ботом) или инструкцию по установке PWA.
 *
 * APK специально живёт в `tg/apk/` — внутри каталога бота, а не в общем `apk/`
 * приложения. Так бот остаётся самостоятельным: ему достаточно собственного
 * каталога, он не ходит в файлы приложения и не зависит от его сборки.
 *
 * Каталоги проверяются по очереди, берётся самый свежий файл:
 *   1. MOOD_APK_DIR (явный путь из окружения);
 *   2. ./tg/apk относительно рабочего каталога;
 *   3. ./apk (старое место, для совместимости);
 *   4. tg/apk рядом с самим скриптом — и в исходниках (tsx), и в dist.
 *
 * Отсутствие файла — не ошибка, а штатный случай «APK ещё не собран».
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Каталог, где лежит текущий модуль: tg/ при tsx, dist/ в собранном боте. */
function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Все каталоги, где бот готов искать APK, без дублей. */
export function apkDirs(): string[] {
  const dirs = [
    process.env.MOOD_APK_DIR?.trim(),
    path.resolve(process.cwd(), 'tg', 'apk'),
    path.resolve(process.cwd(), 'apk'),
    path.resolve(moduleDir(), 'apk'),
    path.resolve(moduleDir(), '..', 'tg', 'apk'),
  ].filter((dir): dir is string => !!dir);

  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

/** Первый существующий каталог — для совместимости и диагностики. */
export function defaultApkDir(): string {
  const dirs = apkDirs();
  return dirs.find((dir) => fs.existsSync(dir)) ?? dirs[0]!;
}

interface ApkCandidate {
  filePath: string;
  mtime: number;
}

function apksIn(dir: string): ApkCandidate[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.toLowerCase().endsWith('.apk'))
    .flatMap((name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? [{ filePath, mtime: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Самый свежий .apk или null.
 *
 * Явный `dir` отключает автопоиск: он нужен тестам и отладочным вызовам.
 */
export function findLatestApk(dir?: string): string | null {
  const candidates = (dir ? [dir] : apkDirs()).flatMap(apksIn);

  candidates.sort((a, z) => z.mtime - a.mtime);
  return candidates[0]?.filePath ?? null;
}
