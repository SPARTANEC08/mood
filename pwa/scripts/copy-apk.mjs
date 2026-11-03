/**
 * Копирует свежий APK из корневого apk/ в public/apk/ перед сборкой PWA.
 *
 * Имя файла сохраняется как у собранного APK (`mood-1.1.0.apk`), без
 * обезличенного `mood-latest.apk`: при скачивании пользователь видит рабочую
 * версию, а не служебное имя. При выпуске новой версии ссылку на лендинге и
 * в InstallScreen нужно обновить вместе с APK.
 *
 * Сам APK в git не попадает (apk/ в .gitignore), но в собранный dist/ и на
 * сервер — попадает.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const apkDir = join(projectRoot, 'apk');
const outDir = join(here, '..', 'public', 'apk');

function pickLatestApk() {
  if (!existsSync(apkDir)) return null;

  const files = readdirSync(apkDir).filter((name) => name.endsWith('.apk'));
  if (files.length === 0) return null;

  return files
    .map((name) => ({ name, mtime: statSync(join(apkDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].name;
}

try {
  const latest = pickLatestApk();
  if (!latest) {
    console.warn('[apk] apk/*.apk не найден — ссылка «Скачать APK» останется без файла');
    process.exit(0);
  }

  mkdirSync(outDir, { recursive: true });

  // Не копим старые версии и не оставляем mood-latest.apk: в public/apk
  // должен лежать ровно один файл — тот, на который ссылается интерфейс.
  for (const name of readdirSync(outDir)) {
    if (name.toLowerCase().endsWith('.apk') && name !== latest) {
      rmSync(join(outDir, name), { force: true });
    }
  }

  copyFileSync(join(apkDir, latest), join(outDir, latest));
  console.log(`[apk] ${latest} → public/apk/${latest}`);
} catch (error) {
  console.warn('[apk] не удалось подготовить APK:', error instanceof Error ? error.message : error);
}
