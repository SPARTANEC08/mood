#!/usr/bin/env node
/**
 * Собирает черновики Telegram и Telegraph из drafts/<date>/scenario.md.
 *
 * Использование:
 *   npm run drafts -- --date 2026-11-03
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const at = args.indexOf('--date');
const date = at >= 0 ? args[at + 1] : new Date().toISOString().slice(0, 10);

const dir = path.join(PROMO, 'drafts', date);
const scenarioPath = path.join(dir, 'scenario.md');
if (!fs.existsSync(scenarioPath)) {
  console.error(`Нет ${scenarioPath}. Сначала напиши сценарий.`);
  process.exit(1);
}

const scenario = fs.readFileSync(scenarioPath, 'utf8');
const links = JSON.parse(
  fs.readFileSync(path.join(PROMO, 'config', 'links.json'), 'utf8'),
);

const meta = {};
for (const line of scenario.split('\n').slice(0, 20)) {
  const m = line.match(/^(title|lead|telegraph):\s*(.+)$/i);
  if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}

function section(name) {
  const re = new RegExp(`^##\\s+${name}\\s*$`, 'im');
  const start = scenario.search(re);
  if (start < 0) return '';
  const rest = scenario.slice(start).split('\n').slice(1);
  const out = [];
  for (const line of rest) {
    if (/^##\s+/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function bullets(block, limit = 8) {
  const out = [];
  let current = null;

  for (const line of block.split('\n')) {
    const start = line.match(/^\s*-\s+(.+)$/);
    if (start) {
      if (current) out.push(current);
      current = start[1].trim();
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
      continue;
    }
    if (current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);

  return out.slice(0, limit);
}

const main = bullets(section('Главное'), 6);
const fixes = bullets(section('Исправления'), 4);
const speed = bullets(section('Скорость'), 3);
const site = bullets(section('Сайт'), 2);
const combined = main.length >= 3 ? main : [...main, ...fixes, ...speed, ...site];
const seen = new Set();
const allBullets = combined
  .filter((item) => {
    const key = item.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .slice(0, 6);

const telegraph = meta.telegraph || links.telegraph || '{{telegraph}}';

function utm(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('mood-app.ru')) return url;
    u.searchParams.set('utm_source', 'telegram');
    u.searchParams.set('utm_medium', 'post');
    u.searchParams.set('utm_campaign', date);
    return u.toString();
  } catch {
    return url;
  }
}

const footer = [
  ['web', utm(links.web)],
  ['tg_bot', links.bot],
  ['support', links.support],
  ['GitHub', links.github],
]
  .filter(([, url]) => Boolean(url))
  .map(([label, url]) => `[${label}](${url})`)
  .join(' // ');

const tg = [
  `🎓 ${meta.title || 'Обновление Mood'}`,
  '',
  ...allBullets.map((b) => `- ${b}`),
  '',
  `Подробнее об обновлении тут (тык) — ${telegraph}`,
  '',
  footer,
  '',
].join('\n');

/* ── Telegraph ── */

const mediaBlock = section('Медиа');
const screens = [];
for (const line of mediaBlock.split('\n')) {
  const m = line.match(/^-\s+(media\/stock\/[^—]+?)(?:\s+—\s+(.+))?$/);
  if (m) screens.push({ path: m[1].trim(), caption: (m[2] || '').trim() });
}

let assets = {};
const assetsPath = path.join(dir, 'assets.json');
if (fs.existsSync(assetsPath)) {
  assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
}

const image = (screen) => {
  const url = assets[screen.path];
  if (url) return `![${screen.caption || ''}](${url})`;
  return `{{img:${screen.path}|${screen.caption || ''}}}`;
};

const features = section('Фичи');
const siteSection = section('Сайт');
const videoLine = mediaBlock
  .split('\n')
  .find((line) => line.startsWith('- video:'))
  ?.replace('- video:', '')
  .trim();

const article = [
  `# ${meta.title || 'Обновление Mood'}`,
  '',
  meta.lead || 'Что нового в Mood и чем это полезно.',
  '',
  '## Что нового',
  '',
  features || allBullets.map((b) => `- ${b}`).join('\n'),
  '',
  fixes.length ? `## Исправления\n\n${fixes.map((b) => `- ${b}`).join('\n')}\n` : '',
  speed.length ? `## Скорость\n\n${speed.map((b) => `- ${b}`).join('\n')}\n` : '',
  '## Скриншоты',
  '',
  ...screens.map(image),
  '',
  videoLine
    ? `## Видео\n\n20-секундный обзор: \`${videoLine}\`. В статье — ссылка на пост или страница с плеером.\n`
    : '',
  siteSection ? `## Сайт\n\n${siteSection}\n` : '',
  '## Как установить',
  '',
  `1. Открыть ${utm(links.web)} в Safari или Chrome.`,
  '2. «Поделиться» → «На экран Домой» (iOS) или «Установить» (Android).',
  '3. Войти логином и паролем БАРС.',
  '',
  '## Ссылки',
  '',
  `- Сайт: ${utm(links.web)}`,
  links.support ? `- Поддержка: ${links.support}` : '',
  links.github ? `- GitHub: ${links.github}` : '',
  '',
].join('\n');

fs.writeFileSync(path.join(dir, 'telegram.md'), tg, 'utf8');
fs.writeFileSync(path.join(dir, 'telegraph.md'), article, 'utf8');

console.log(`[drafts] ${allBullets.length} пунктов`);
console.log(`  drafts/${date}/telegram.md`);
console.log(`  drafts/${date}/telegraph.md`);
console.log(`  скринов: ${screens.length}, assets.json: ${Object.keys(assets).length}`);
