#!/usr/bin/env node
/**
 * Публикует drafts/<date>/telegraph.md в Telegraph.
 *
 * Первый запуск создаёт аккаунт и сохраняет токен в promo/.env (в git не идёт).
 * Дальше страница создаётся через createPage.
 *
 *   npm run publish -- --date 2026-11-03
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const at = args.indexOf('--date');
const date = at >= 0 ? args[at + 1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const dir = path.join(ROOT, 'drafts', date);
const mdPath = path.join(dir, 'telegraph.md');

if (!fs.existsSync(mdPath)) {
  console.error(`Нет ${mdPath}`);
  process.exit(1);
}

const update = args.includes('--update');
const md = fs.readFileSync(mdPath, 'utf8');
const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Обновление Mood';

/* ── inline ── */

function inlineNodes(text) {
  const re = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  const parts = text.split(re).filter((part) => part !== '');

  return parts.map((part) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return { tag: 'a', attrs: { href: link[2] }, children: [link[1]] };

    const code = part.match(/^`([^`]+)`$/);
    if (code) return { tag: 'code', children: [code[1]] };

    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) return { tag: 'strong', children: [bold[1]] };

    return part;
  });
}

/* ── markdown → telegraph nodes ── */

function toNodes(markdown) {
  const nodes = [];
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      nodes.push({ tag: 'p', children: inlineNodes(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const closeList = () => {
    flushParagraph();
    if (list) {
      nodes.push({ tag: 'ul', children: list });
      list = null;
    }
  };

  for (const line of markdown.split('\n')) {
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      closeList();
      nodes.push({
        tag: 'figure',
        children: [
          { tag: 'img', attrs: { src: img[2] } },
          { tag: 'figcaption', children: [img[1] || ''] },
        ],
      });
      continue;
    }

    if (line.startsWith('### ')) {
      closeList();
      nodes.push({ tag: 'h4', children: inlineNodes(line.slice(4)) });
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      nodes.push({ tag: 'h3', children: inlineNodes(line.slice(3)) });
      continue;
    }
    if (line.startsWith('# ')) {
      closeList();
      continue;
    }
    if (/^-\s+/.test(line)) {
      flushParagraph();
      if (!list) list = [];
      list.push({ tag: 'li', children: inlineNodes(line.replace(/^-\s+/, '')) });
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }

    if (list) {
      nodes.push({ tag: 'ul', children: list });
      list = null;
    }
    paragraph.push(line.trim());
  }
  closeList();

  return nodes;
}

/* ── env ── */

function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function createAccount() {
  const body = new URLSearchParams({
    short_name: `mood-mpei-${Math.random().toString(36).slice(2, 8)}`,
    author_name: 'Mood',
    author_url: 'https://mood-app.ru',
  });
  const res = await fetch('https://api.telegra.ph/createAccount', { method: 'POST', body });
  const data = await res.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  return data.result.access_token;
}

const env = readEnv();
let token = env.TELEGRAPH_TOKEN;

if (!token) {
  token = await createAccount();
  const file = path.join(ROOT, '.env');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\n*$/, '\n') : '';
  fs.writeFileSync(file, `${lines}TELEGRAPH_TOKEN=${token}\n`, { mode: 0o600 });
  console.log('[telegraph] аккаунт создан, токен в promo/.env');
}

const nodes = toNodes(md);
const body = new URLSearchParams({
  access_token: token,
  title,
  author_name: 'Mood',
  author_url: 'https://mood-app.ru',
  content: JSON.stringify(nodes),
  return_content: 'false',
});

const previousPath = path.join(dir, 'telegraph.json');
let endpoint = 'createPage';
if (update && fs.existsSync(previousPath)) {
  try {
    const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
    if (previous.path) {
      body.set('path', previous.path);
      endpoint = 'editPage';
    }
  } catch {
    // нет валидной прошлой страницы — создадим новую
  }
}

const res = await fetch(`https://api.telegra.ph/${endpoint}`, { method: 'POST', body });
const data = await res.json();
if (!data.ok) {
  console.error('[telegraph] отказ:', JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

const info = {
  url: data.result.url,
  path: data.result.path,
  publishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(dir, 'telegraph.json'), JSON.stringify(info, null, 2), 'utf8');
console.log(`[telegraph] ${endpoint === 'editPage' ? 'обновлено' : 'создано'}: ${info.url}`);
console.log(`[telegraph] токен: promo/.env (не коммитится)`);
