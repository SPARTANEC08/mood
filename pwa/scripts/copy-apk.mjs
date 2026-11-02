/**
 * Копирует свежий APK из корневого apk/ в public/apk/ перед сборкой PWA.
 *
 * Зачем: на лендинге должна работать прямая ссылка «Скачать с сайта».
 * Имя mood-latest.apk стабильное, поэтому ссылку не нужно править при
 * каждом релизе. Сам APK в git не попадает (apk/ в .gitignore), но в
 * собранный dist/ и на сервер — попадает.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
    console.warn('[apk] apk/*.apk не найден — ссылка «Скачать с сайта» останется без файла');
    process.exit(0);
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(apkDir, latest), join(outDir, 'mood-latest.apk'));
  copyFileSync(join(apkDir, latest), join(outDir, latest));
  console.log(`[apk] ${latest} → public/apk/mood-latest.apk`);
} catch (error) {
  console.warn('[apk] не удалось подготовить APK:', error instanceof Error ? error.message : error);
}
