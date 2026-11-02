#!/usr/bin/env node
/**
 * Собирает пост для Telegram и статью для Telegraph из drafts/<date>/scenario.md.
 *
 * Формат сценария:
 *
 *   title: Mood: обновление
 *   date: 2026-11-03
 *   lead: Вот что нового.
 *
 *   ## Пост
 *   - пункт
 *   - пункт
 *
 *   ## Статья
 *   ### 🎯 Успеваемость
 *   Текст раздела.
 *
 *   {{img:media/stock/04-grades.png}}
 *
 *   ### 🧮 Калькулятор оценок
 *   Текст.
 *
 *   npm run drafts -- --date 2026-11-03
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const at = args.indexOf('--date');
const moscowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const date = at >= 0 ? args[at + 1] : moscowDate;

const dir = path.join(PROMO, 'drafts', date);
const scenarioPath = path.join(dir, 'scenario.md');
if (!fs.existsSync(scenarioPath)) {
  console.error(`Нет ${scenarioPath}. Сначала напиши сценарий.`);
  process.exit(1);
}

const scenario = fs.readFileSync(scenarioPath, 'utf8');
const links = JSON.parse(fs.readFileSync(path.join(PROMO, 'config', 'links.json'), 'utf8'));
const schedule = JSON.parse(fs.readFileSync(path.join(PROMO, 'config', 'schedule.json'), 'utf8'));

/* ── meta ── */

const meta = {};
for (const line of scenario.split('\n').slice(0, 30)) {
  const m = line.match(/^(title|lead|telegraph|date):\s*(.+)$/i);
  if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}

/* ── секции сценария ── */

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

function splitSections(block) {
  const sections = [];
  const intro = [];
  let current = null;

  for (const line of block.split('\n')) {
    const m = line.match(/^###\s+(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (line.trim()) intro.push(line);
  }
  if (current) sections.push(current);

  return {
    intro: intro.join('\n').trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })),
  };
}

/* ── ссылки, UTM ── */

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

const footerPairs = [
  ['web', utm(links.web)],
  ['tg_bot', links.bot],
  ['support', links.support],
  ['GitHub', links.github],
].filter(([, url]) => Boolean(url));

const footerMd = footerPairs.map(([label, url]) => `[${label}](${url})`).join(' // ');
const footerHtml = footerPairs
  .map(([label, url]) => `<a href="${url}">${label}</a>`)
  .join(' // ');

/* ── статья ── */

let assets = {};
const assetsPath = path.join(dir, 'assets.json');
if (fs.existsSync(assetsPath)) {
  try {
    assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
  } catch {
    assets = {};
  }
}

const missing = new Set();

function renderBody(body) {
  return body
    // видео в статью не вставляем никогда
    .replace(/^\s*\{\{video:[^}]*\}\}\s*$/gim, '')
    .replace(/\{\{img:([^|}]+)\|?([^}]*)\}\}/g, (_, rawPath) => {
      const p = rawPath.trim();
      const url = assets[p];
      if (!url) {
        missing.add(p);
        return `_[нет скрина: ${p}]_`;
      }
      return `![](${url})`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function headingLine(raw) {
  const clean = raw.replace(/\*\*/g, '').trim();
  const emoji = clean.match(/^(\p{Extended_Pictographic}\uFE0F?)\s+(.+)$/u);
  if (emoji) return `#### ${emoji[1]} **${emoji[2]}**`;
  return `#### **${clean}**`;
}

const articleSource = section('Статья') || section('Фичи');
const parsed = splitSections(articleSource);

const title = meta.title || 'Mood: обновление';
const lead = meta.lead || parsed.intro || 'Вот что нового.';
const day = meta.date || date;
const dateLine = /^\d{4}-\d{2}-\d{2}$/.test(day)
  ? day.split('-').reverse().join('.')
  : day;

let telegraph = meta.telegraph || '{{telegraph}}';
const publishedPath = path.join(dir, 'telegraph.json');
if (fs.existsSync(publishedPath)) {
  try {
    const published = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
    if (published.url) telegraph = published.url;
  } catch {
    // битый файл не должен ломать сборку
  }
}
if (telegraph === '{{telegraph}}' && links.telegraph) {
  telegraph = links.telegraph;
  console.warn('[drafts] нет telegraph.json — ссылка «тык» ведёт на прошлую статью из links.json');
}

const articleParts = [
  `# ${title}`,
  '',
  footerMd,
  '',
  dateLine,
  '',
  lead,
  '',
];

for (const s of parsed.sections) {
  const body = renderBody(s.body);
  articleParts.push(headingLine(s.heading), '', body, '');
}

articleParts.push(footerMd, '');

const article = articleParts.join('\n');

/* ── пост ── */

const postSource = section('Пост') || section('Главное');
const postBullets = bullets(postSource, 6);
if (postBullets.length === 0) {
  console.error('В сценарии нет блока «## Пост» с пунктами.');
  process.exit(1);
}

const linkLabel = schedule?.post?.linkLabel || 'Подробнее об обновлении тут (тык)';
const tg = [
  `🎓 ${title}`,
  '',
  ...postBullets.map((b) => `- ${b}`),
  '',
  `[${linkLabel}](${telegraph})`,
  '',
  footerMd,
  '',
].join('\n');

/* ── HTML для проверки ── */

function inlineHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function toHtml(markdown) {
  const out = [];
  let paragraph = [];
  let list = null;
  let listTag = 'ul';

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inlineHtml(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  const closeList = () => {
    flushParagraph();
    if (list) {
      out.push(`</${listTag}>`);
      list = null;
    }
  };

  for (const line of markdown.split('\n')) {
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      closeList();
      out.push(`<figure><img src="${img[2]}" alt="${img[1]}"></figure>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list) {
        out.push('<ol>');
        list = [];
        listTag = 'ol';
      }
      out.push(`<li>${inlineHtml(ordered[1])}</li>`);
      continue;
    }
    if (/^-\s+/.test(line)) {
      flushParagraph();
      if (!list) {
        out.push('<ul>');
        list = [];
        listTag = 'ul';
      }
      out.push(`<li>${inlineHtml(line.replace(/^-\s+/, ''))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    if (list) closeList();
    paragraph.push(line.trim());
  }
  closeList();

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{max-width:720px;margin:40px auto;padding:0 20px;font:18px/1.55 -apple-system,BlinkMacSystemFont,Inter,sans-serif;color:#15131e}img{max-width:100%;border-radius:12px}h1,h2,h3,h4{line-height:1.2}a{color:#7c4dff}</style></head><body>${out.join('\n')}</body></html>`;
}

const telegramHtml = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>body{max-width:680px;margin:40px auto;padding:0 20px;font:18px/1.55 -apple-system,BlinkMacSystemFont,Inter,sans-serif}a{color:#7c4dff}</style></head><body><p>🎓 <b>${title}</b></p><ul>${postBullets.map((b) => `<li>${inlineHtml(b)}</li>`).join('')}</ul><p><a href="${telegraph}">${linkLabel}</a></p><p>${footerHtml}</p></body></html>`;

/* ── запись ── */

fs.writeFileSync(path.join(dir, 'telegram.md'), tg, 'utf8');
fs.writeFileSync(path.join(dir, 'telegram.html'), telegramHtml, 'utf8');
fs.writeFileSync(path.join(dir, 'telegraph.md'), article, 'utf8');
fs.writeFileSync(path.join(dir, 'telegraph.html'), toHtml(article), 'utf8');

console.log(`[drafts] ${postBullets.length} пунктов, ${parsed.sections.length} разделов`);
console.log(`  drafts/${date}/telegram.md`);
console.log(`  drafts/${date}/telegraph.md`);
console.log(`  drafts/${date}/telegraph.html`);
console.log(`  ссылка: ${telegraph}`);
if (missing.size > 0) {
  console.warn(`[drafts] нет в assets.json: ${[...missing].join(', ')}`);
  console.warn('[drafts] залей скрины: npm run upload -- --date ' + date);
}
