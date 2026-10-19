/**
 * Поиск последнего собранного APK для выдачи в Telegram.
 *
 * Бот не знает, установил ли человек APK, и не должен: он просто отдаёт файл
 * (если он лежит на сервере) или инструкцию по установке PWA. Каталог `apk/`
 * появляется после `npm run apk:build` и на сервер выкладывается отдельно; его
 * отсутствие — не ошибка, а штатный случай «APK ещё не собран».
 */

import fs from 'node:fs';
import path from 'node:path';

/** Каталог с APK относительно рабочего каталога процесса. */
export function defaultApkDir(): string {
  return path.resolve(process.cwd(), 'apk');
}

/** Самый свежий .apk в каталоге или null. */
export function findLatestApk(dir: string = defaultApkDir()): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const candidates = names
    .filter((name) => name.toLowerCase().endsWith('.apk'))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { filePath, mtime: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is { filePath: string; mtime: number } => value !== null)
    .sort((a, z) => z.mtime - a.mtime);

  return candidates[0]?.filePath ?? null;
}
