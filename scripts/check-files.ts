/**
 * Проверка живости прикреплённых файлов.
 *
 * Telegram привязывает file_id к конкретному боту: файл, загруженный одним
 * ботом, недоступен другому. Если база переносилась с другого бота, все
 * старые file_id становятся мёртвыми, и файлы просто не отправляются.
 *
 * Запуск: npx tsx scripts/check-files.ts
 */

import 'dotenv/config';
import { Bot } from 'grammy';

import { homeworkStore } from '../src/storage/homeworkStore.js';
import { importantStore } from '../src/storage/importantStore.js';
import { resolveFileType } from '../src/bot/telegramService.js';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN ?? '');
const me = await bot.api.getMe();

console.log('='.repeat(62));
console.log('   ПРОВЕРКА ФАЙЛОВ');
console.log('='.repeat(62));
console.log(`Бот: @${me.username} (id ${me.id})`);
console.log(`Канал-хранилище: ${process.env.TELEGRAM_STORAGE_CHANNEL_ID ?? 'не задан'}`);

let total = 0;
let alive = 0;
const dead: string[] = [];

/**
 * Проверяет один файл вызовом getFile.
 */
async function check(label: string, fileId: string, fileName: string): Promise<void> {
  total += 1;
  try {
    const f = await bot.api.getFile(fileId);
    if (f.file_path) {
      alive += 1;
      console.log(`  ✅ ${label}  ${fileName}`);
    } else {
      dead.push(`${label}  ${fileName}`);
      console.log(`  ⚠️  ${label}  ${fileName} — Telegram не вернул путь`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    dead.push(`${label}  ${fileName}`);
    console.log(`  ❌ ${label}  ${fileName} — ${msg}`);
  }
}

console.log('\n--- Домашние задания ---');
for (const hw of homeworkStore.all()) {
  if (!hw.files || hw.files.length === 0) continue;
  for (const f of hw.files) {
    await check(`ДЗ ${hw.discipline.slice(0, 24)}`, f.fileId, f.fileName);
  }
}

console.log('\n--- Важное ---');
const seen = new Set<string>();
for (const imp of importantStore.all()) {
  if (!imp.files || imp.files.length === 0) continue;
  for (const f of imp.files) {
    const label = imp.title.slice(0, 28);
    if (seen.has(f.fileId)) continue;
    seen.add(f.fileId);
    await check(label, f.fileId, f.fileName);
  }
}

console.log('\n--- Канал-хранилище ---');
const channel = process.env.TELEGRAM_STORAGE_CHANNEL_ID;
if (channel) {
  try {
    const chat = await bot.api.getChat(channel);
    console.log(`  ✅ канал доступен: ${'title' in chat ? chat.title : channel}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ канал недоступен: ${msg}`);
    console.log('     Бот не администратор канала, или id принадлежит другому боту.');
  }
} else {
  console.log('  (не задан в .env)');
}

console.log('\n' + '='.repeat(62));
console.log(`Живых файлов: ${alive} из ${total}`);

if (dead.length > 0) {
  console.log('\nМёртвые файлы (Telegram их больше не хранит):');
  for (const d of dead) {
    console.log(`  • ${d}`);
  }
  console.log('\nЧто делать:');
  console.log('  Эти file_id не восстановить. Файлы хранятся только в Telegram,');
  console.log('  а Telegram привязывает file_id к боту: загружено ботом 8886762009,');
  console.log('  а сейчас работает @z_mpei_bot (8694033725). Старые файлы недоступны.');
  console.log('');
  console.log('  Файлы нужно прикрепить заново — тогда они лягут в канал-хранилище');
  console.log('  уже с текущим ботом и будут жить там.');
}

console.log('='.repeat(62));
process.exit(0);