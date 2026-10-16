/**
 * Проверка целостности прикреплённых файлов.
 *
 * Что было раньше. Файлы лежали в закрытом Telegram-канале, а в базе хранился
 * только file_id. Проверка била getFile по каждому file_id и выясняла, живой
 * ли он: Telegram привязывает file_id к боту и ко времени, поэтому после
 * переезда базы или истечения срока файлы просто переставали открываться, и
 * это выяснялось только по жалобе пользователя.
 *
 * Что стало. Файлы лежат на диске в data/files/<userId>/, и проверить их можно
 * точно: файл существует, размер совпадает с метаданными, а sha256 совпадает с
 * записанным. Расхождение по хэшу означает порчу файла, а не просто его
 * отсутствие — и это ловится до того, как человек откроет битое задание.
 *
 * Запуск: npm run check:files
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getFile } from '../src/storage/fileStore.ts';
import { homeworkStore } from '../src/storage/homeworkStore.js';
import { importantStore } from '../src/storage/importantStore.js';

let total = 0;
let ok = 0;
const problems: string[] = [];

interface Found {
  /** Где файл упоминается — для понятного сообщения. */
  label: string;
  uploadedBy: string;
  fileId: string;
  originalName: string;
  size: number;
  sha256: string;
}

/**
 * Проверяет один файл: наличие, размер и хэш.
 *
 * Хэш считается целиком, а не по первым байтам: обрезанный файл проходит по
 * размеру только если обрезан ровно до края, а вот подмена содержимого — это
 * ровно тот случай, ради которого в метаданных и лежит sha256.
 */
async function check(file: Found): Promise<void> {
  total += 1;

  const found = await getFile(file.uploadedBy, file.fileId);

  if (!found) {
    problems.push(`${file.label} — ${file.originalName}: файла нет на диске`);
    console.log(`  ❌ ${file.label}  ${file.originalName} — файла нет на диске`);
    return;
  }

  if (found.meta.originalName !== file.originalName) {
    problems.push(
      `${file.label} — имя в базе «${file.originalName}», на диске «${found.meta.originalName}»`,
    );
    console.log(`  ⚠️  ${file.label}  ${file.originalName} — имя на диске отличается`);
    return;
  }

  const content = await fs.readFile(found.path);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');

  if (content.length !== file.size) {
    problems.push(
      `${file.label} — ${file.originalName}: размер ${content.length} вместо ${file.size}`,
    );
    console.log(`  ❌ ${file.label}  ${file.originalName} — размер ${content.length} вместо ${file.size}`);
    return;
  }

  if (sha256 !== file.sha256) {
    problems.push(`${file.label} — ${file.originalName}: содержимое не совпадает с sha256 в базе`);
    console.log(`  ❌ ${file.label}  ${file.originalName} — хэш не совпадает`);
    return;
  }

  ok += 1;
  console.log(`  ✅ ${file.label}  ${file.originalName}  ${(content.length / 1024).toFixed(0)} КБ`);
}

console.log('='.repeat(62));
console.log('   ПРОВЕРКА ФАЙЛОВ');
console.log('='.repeat(62));
console.log(`Каталог: ${path.resolve(process.cwd(), 'data', 'files')}`);
console.log(`Канал-хранилище Telegram не используется: ${process.env.TELEGRAM_STORAGE_CHANNEL_ID ? 'переменная задана, но игнорируется' : 'не задан'}`);

console.log('\n--- Домашние задания ---');
for (const hw of homeworkStore.all()) {
  for (const file of hw.files ?? []) {
    await check({
      label: `ДЗ ${hw.discipline.slice(0, 24)}`,
      uploadedBy: file.uploadedBy,
      fileId: file.fileId,
      originalName: file.originalName,
      size: file.size,
      sha256: file.sha256,
    });
  }
}

console.log('\n--- Важное ---');
// Один и тот же файл может упоминаться в нескольких записях: он лежит на диске
// один раз, и второй раз проверять его — только тратить время.
const seen = new Set<string>();
for (const imp of importantStore.all()) {
  for (const file of imp.files ?? []) {
    const key = `${file.uploadedBy}:${file.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await check({
      label: imp.title.slice(0, 28),
      uploadedBy: file.uploadedBy,
      fileId: file.fileId,
      originalName: file.originalName,
      size: file.size,
      sha256: file.sha256,
    });
  }
}

console.log('\n' + '='.repeat(62));

if (total === 0) {
  console.log('Файлов в базе нет — проверять нечего.');
} else {
  console.log(`Проверено: ${total}, целых: ${ok}, проблем: ${problems.length}`);

  if (problems.length > 0) {
    console.log('\nПроблемы:');
    for (const problem of problems) console.log(`  · ${problem}`);
    console.log('\nФайл отсутствует или повреждён — запись в базе ссылается на то,');
    console.log('чего уже нет. Приложение покажет битую иконку, бот — откажется');
    console.log('отправлять файл. Удалите такую запись или загрузите файл заново.');
  }
}

/*
 * ── Осиротевшие файлы: обратная проверка ──────────────────────────────────────
 *
 * Всё выше обходит ЗАПИСИ и ищет их файлы. Проверка обратная: обходятся
 * каталоги в data/files/, и для каждого файла ищется запись, которая на него
 * ссылается.
 *
 * Зачем: осиротевшие файлы не видны сверху вниз, а видны только в интерфейсе.
 * Так вышло после сброса users.json — записи ДЗ и «Важного» остались, файлы
 * остались, а каталог стал принадлежать несуществующему userId. Проверка
 * проходила как «всё цело», и каждый файл при этом отдавал 404: getFile ищет
 * файл в каталоге ТЕКУЩЕГО пользователя, а каталога не было.
 */
const filesRoot = path.resolve(process.cwd(), 'data', 'files');

/** Каталог может отсутствовать (свежая установка) — это не ошибка. */
async function existsSafe(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

if (await existsSafe(filesRoot)) {
  const referenced = new Map<string, string[]>();

  for (const rec of homeworkStore.all()) {
    for (const file of rec.files ?? []) {
      referenced.set(file.fileId, [...(referenced.get(file.fileId) ?? []), rec.id]);
    }
  }

  for (const rec of importantStore.all()) {
    for (const file of rec.files ?? []) {
      referenced.set(file.fileId, [...(referenced.get(file.fileId) ?? []), rec.id]);
    }
  }

  const orphans: string[] = [];

  for (const userDir of await fs.readdir(filesRoot)) {
    const fullDir = path.join(filesRoot, userDir);
    const info = await fs.stat(fullDir).catch(() => null);
    if (!info?.isDirectory()) continue;

    for (const name of await fs.readdir(fullDir)) {
      if (!name.endsWith('.bin')) continue;

      const fileId = name.slice(0, -'.bin'.length);
      if (referenced.has(fileId)) continue;

      const size = await fs.stat(path.join(fullDir, name)).then((s) => s.size, () => 0);
      orphans.push(`${fileId} (${Math.round(size / 1024)} КБ) в каталоге ${userDir}`);
    }
  }

  console.log('\n' + '='.repeat(62));
  console.log(`Осиротевшие файлы (на диске, но не прикреплены ни к одной записи): ${orphans.length}`);

  if (orphans.length > 0) {
    for (const orphan of orphans) console.log(`  · ${orphan}`);
    console.log('\nТакой файл не откроется: getFile ищет его в каталоге того, кто');
    console.log('сейчас вошёл, а каталог остался за прежним аккаунтом. Либо верните');
    console.log('файлы прежнему userId, либо перенесите их в каталог текущего:');
    console.log('  cp -p data/files/<старый>/ data/files/<новый>/');
  }
}

console.log('');

// Найденные проблемы — повод разбираться, а не повод для ненулевого кода:
// проверка читающая, она ничего не меняет и вызывается руками.
process.exit(0);
