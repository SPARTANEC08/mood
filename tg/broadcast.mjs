/**
 * Рассылка от Telegram-бота по сохранённым подписчикам.
 *
 * Запуск (из каталога, где лежит bot-subscribers.json и .env):
 *
 *   node tg/broadcast.mjs --text-file /tmp/text.txt
 *   node tg/broadcast.mjs --text "Текст" --apk tg/apk/mood-1.1.0.apk
 *   node tg/broadcast.mjs --text "Тест" --id 123456789 --dry-run
 *
 * Telegram не позволяет писать тем, кто ни разу не запускал бота. Список
 * пополняется автоматически при любом сообщении/нажатии в боте.
 */

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { Bot, InputFile } from 'grammy';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

const textFile = arg('text-file');
const text = textFile ? fs.readFileSync(path.resolve(textFile), 'utf-8').trim() : arg('text');
const apk = arg('apk');
const onlyId = arg('id');
const dryRun = has('dry-run');

if (!text) {
  console.error('Нужен --text "..." или --text-file /path/to/text.txt');
  process.exit(1);
}

const subscribersPath = path.resolve(process.cwd(), 'bot-subscribers.json');
let subscribers = [];
try {
  const parsed = JSON.parse(fs.readFileSync(subscribersPath, 'utf-8'));
  subscribers = Object.values(parsed);
} catch {
  console.error(`Нет файла подписчиков: ${subscribersPath}`);
  console.error('Попросите пользователей нажать /start в боте — после этого они появятся.');
  process.exit(1);
}

if (onlyId) subscribers = subscribers.filter((item) => String(item.id) === String(onlyId));

if (subscribers.length === 0) {
  console.log('Подписчиков нет — отправлять некому.');
  process.exit(0);
}

console.log(`Подписчиков: ${subscribers.length}${apk ? `, APK: ${apk}` : ''}${dryRun ? ' (dry-run)' : ''}`);

if (dryRun) {
  console.log('Dry-run: ничего не отправлено.');
  process.exit(0);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

let sent = 0;
let failed = 0;

for (const subscriber of subscribers) {
  try {
    if (apk) {
      await bot.api.sendDocument(
        subscriber.id,
        new InputFile(path.resolve(apk)),
        { caption: text },
      );
    } else {
      await bot.api.sendMessage(subscriber.id, text, {
        disable_web_page_preview: true,
      });
    }
    sent += 1;
  } catch (err) {
    failed += 1;
    const code = err && typeof err === 'object' ? err.statusCode ?? err.error_code : undefined;
    console.log(`[broadcast] ${subscriber.id}: ошибка ${code ?? 'unknown'}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.log(JSON.stringify({ sent, failed, total: subscribers.length }));
