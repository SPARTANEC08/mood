#!/usr/bin/env node
/**
 * Отправляет готовый пост в чат бота, чтобы ссылки были кликабельными.
 * Telegram не парсит Markdown/HTML, вставленный руками, поэтому пост
 * приходит сообщением с parse_mode=HTML: его можно скопировать в канал
 * вместе со ссылками.
 *
 *   npm run send -- --date 2026-11-03
 *   npm run send -- --date 2026-11-03 --dry-run
 *   npm run send -- --summary-only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');
const ROOT = path.resolve(PROMO, '..');

const args = process.argv.slice(2);
const at = args.indexOf('--date');
const moscowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const date = at >= 0 ? args[at + 1] : moscowDate;
const dryRun = args.includes('--dry-run');
const summaryOnly = args.includes('--summary-only');
const postOnly = args.includes('--post-only');

const dir = path.join(PROMO, 'drafts', date);

function readEnv() {
  const out = {};
  for (const file of [path.join(ROOT, '.env'), path.join(PROMO, '.env')]) {
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
const chatId = env.TELEGRAM_CHAT_ID || (env.ADMIN_TELEGRAM_IDS || '').split(',')[0].trim();

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTelegramHtml(markdown) {
  return markdown
    .split('\n')
    .map((line) =>
      escapeHtml(line)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code>$1</code>'),
    )
    .join('\n');
}

function read(file, fallback = '') {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return fallback;
  }
}

const telegramMd = read('telegram.md');
if (!telegramMd) {
  console.error(`Нет drafts/${date}/telegram.md. Сначала: npm run drafts -- --date ${date}`);
  process.exit(1);
}

const changes = read('changes.md');
const telegraphMd = read('telegraph.md');
const telegraph = (() => {
  try {
    return JSON.parse(read('telegraph.json', '{}')).url || '';
  } catch {
    return '';
  }
})();

const commitCount = changes.match(/Пользовательских коммитов:\s*(\d+)/)?.[1] ?? '—';
const bulletCount = (telegramMd.match(/^-\s+/gm) ?? []).length;
const sectionCount = (telegraphMd.match(/^####\s+/gm) ?? []).length;
const imageCount = (telegraphMd.match(/^!\[/gm) ?? []).length;

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

const summaryLines = [
  `📊 <b>Итоги дня · ${date.split('-').reverse().join('.')}</b>`,
  '',
  `Коммитов в дайджесте: ${commitCount}`,
  `Пост: ${bulletCount} ${plural(bulletCount, ['пункт', 'пункта', 'пунктов'])}`,
  `Статья: ${sectionCount} ${plural(sectionCount, ['раздел', 'раздела', 'разделов'])}, ${imageCount} ${plural(imageCount, ['скрин', 'скрина', 'скринов'])}`,
  telegraph ? `Telegraph: <a href="${telegraph}">${telegraph}</a>` : 'Telegraph: ссылки пока нет',
  '',
  'Ниже — готовый пост. Скопируй, поправь и отправь в канал.',
];

const summary = summaryLines.join('\n');
const post = toTelegramHtml(telegramMd);

if (dryRun) {
  console.log('── summary ──\n' + summary + '\n\n── post ──\n' + post);
  process.exit(0);
}

if (!token) {
  console.error('Нет TELEGRAM_BOT_TOKEN в promo/.env или корневом .env.');
  process.exit(1);
}
if (!chatId) {
  console.error('Нет TELEGRAM_CHAT_ID. Запусти npm run tg:init и нажми /start у бота.');
  process.exit(1);
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${data.error_code}: ${data.description}`);
  return data.result;
}

try {
  if (!postOnly) {
    const msg = await send(summary);
    console.log(`[send] summary → ${chatId} (message ${msg.message_id})`);
  }
  if (!summaryOnly) {
    const msg = await send(post);
    console.log(`[send] post → ${chatId} (message ${msg.message_id})`);
    fs.writeFileSync(
      path.join(dir, 'sent.json'),
      JSON.stringify({ chatId, messageId: msg.message_id, sentAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  }
} catch (error) {
  console.error('[send] не отправлено:', error.message);
  console.error('Проверь: бот запущен, ты нажал /start, chat_id верный (npm run tg:init).');
  process.exit(1);
}
