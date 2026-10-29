#!/usr/bin/env node
/**
 * Копирует самый свежий APK из общего `apk/` в каталог бота `tg/apk/`.
 *
 * Зачем отдельная копия: бот живёт своим процессом и может стоять на другом
 * сервере. Ему не нужен ни проект приложения, ни `apk/`, ни база — достаточно
 * собственного каталога `tg/apk/` рядом с `dist/bot.js`.
 *
 * Запуск: npm run apk:bot
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = path.resolve(root, 'apk');
const targetDir = path.resolve(root, 'tg', 'apk');

function latestApk(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  return (
    names
      .filter((name) => name.toLowerCase().endsWith('.apk'))
      .map((name) => {
        const filePath = path.join(dir, name);
        try {
          return { filePath, mtime: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, z) => z.mtime - a.mtime)[0]?.filePath ?? null
  );
}

const source = latestApk(sourceDir);
if (!source) {
  console.error(`[apk:bot] В ${sourceDir} нет ни одного .apk — сначала соберите APK (npm run apk:build).`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
const target = path.join(targetDir, path.basename(source));

// Старые версии в tg/apk не копим: бот всегда отдаёт один, самый свежий файл.
for (const name of fs.readdirSync(targetDir)) {
  if (name.toLowerCase().endsWith('.apk') && path.join(targetDir, name) !== target) {
    fs.rmSync(path.join(targetDir, name), { force: true });
  }
}

fs.copyFileSync(source, target);
console.log(`[apk:bot] ${path.relative(root, source)} → ${path.relative(root, target)} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} МБ)`);
