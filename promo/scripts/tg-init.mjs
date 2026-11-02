#!/usr/bin/env node
/**
 * Находит chat_id для отправки постов и кладёт его в promo/.env.
 *
 *   1. Открой бота @mood_mpei_bot и нажми /start.
 *   2. npm run tg:init
 *
 * Скрипт пробует TELEGRAM_CHAT_ID, ADMIN_TELEGRAM_IDS и getUpdates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');
const ROOT = path.resolve(PROMO, '..');
const envPath = path.join(PROMO, '.env');

function readEnv() {
  const out = {};
  for (const file of [path.join(ROOT, '.env'), envPath]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = readEnv();
const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Нет TELEGRAM_BOT_TOKEN в корневом .env.');
  process.exit(1);
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

const candidates = new Set(
  [
    env.TELEGRAM_CHAT_ID,
    ...(env.ADMIN_TELEGRAM_IDS || '').split(','),
  ]
    .map((id) => (id || '').trim())
    .filter(Boolean),
);

const updates = await api('getUpdates', { limit: 100 });
if (updates.ok) {
  for (const update of updates.result) {
    const chat = update.message?.chat ?? update.edited_message?.chat;
    if (chat?.id) candidates.add(String(chat.id));
  }
}

if (candidates.size === 0) {
  console.error('Не нашёл chat_id.');
  console.error('Открой @mood_mpei_bot, нажми /start и запусти npm run tg:init снова.');
  process.exit(1);
}

let found = null;
for (const id of candidates) {
  const result = await api('sendMessage', {
    chat_id: id,
    text: '✅ Mood SMM подключён. Сюда будут приходить итоги дня и готовый пост.',
    disable_web_page_preview: true,
  });
  if (result.ok) {
    found = id;
    console.log(`[tg:init] сообщение отправлено в chat_id ${id}`);
    break;
  }
  console.log(`[tg:init] ${id}: ${result.description}`);
}

if (!found) {
  console.error('Ни один chat_id не принял сообщение.');
  console.error('Открой @mood_mpei_bot, нажми /start и запусти npm run tg:init снова.');
  process.exit(1);
}

let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').replace(/\n*$/, '\n') : '';
if (/^TELEGRAM_CHAT_ID=.*$/m.test(lines)) {
  lines = lines.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${found}`);
} else {
  lines += `TELEGRAM_CHAT_ID=${found}\n`;
}
fs.writeFileSync(envPath, lines, { mode: 0o600 });
console.log(`[tg:init] TELEGRAM_CHAT_ID=${found} → promo/.env`);
