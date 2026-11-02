#!/usr/bin/env node
/**
 * Заливает скрины в GitHub Release (не на наш сервер).
 * Видео сюда не попадает: оно живёт в Telegram.
 *
 *   npm run upload -- media/stock/10-calculator-plan.png --out drafts/2026-11-03/assets.json
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const dateIndex = args.indexOf('--date');
const date = dateIndex >= 0
  ? args[dateIndex + 1]
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

const files = args.filter((a, i) => {
  if (['--out', '--date'].includes(a)) return false;
  if (i > 0 && ['--out', '--date'].includes(args[i - 1])) return false;
  return !a.startsWith('--');
});

if (files.length === 0) {
  console.error('Укажи файлы: npm run upload -- media/stock/01-schedule.png');
  process.exit(1);
}

function token() {
  const cred = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  return cred.match(/^password=(.+)$/m)?.[1]?.trim() ?? '';
}

function repo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) throw new Error('Не удалось определить owner/repo из origin');
  return { owner: m[1], name: m[2] };
}

const ghToken = token();
if (!ghToken) {
  console.error('Нет GitHub-токена в git credential. Сначала сделай git push или gh auth login.');
  process.exit(1);
}

const { owner, name: repoName } = repo();
const tag = `media-${date}`;
const headers = {
  Authorization: `Bearer ${ghToken}`,
  'User-Agent': 'mood-smm',
  Accept: 'application/vnd.github+json',
};

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

let release = null;
try {
  release = await json(`https://api.github.com/repos/${owner}/${repoName}/releases/tags/${tag}`);
} catch {
  release = await json(`https://api.github.com/repos/${owner}/${repoName}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `Media ${date}`,
      body: 'Скрины для статей и постов. Видео — в Telegram.',
      draft: false,
      prerelease: false,
    }),
  });
}

const existing = new Map(
  (release.assets ?? []).map((asset) => [asset.name, asset.browser_download_url]),
);

let previous = {};
if (outPath && fs.existsSync(outPath)) {
  try {
    previous = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    previous = {};
  }
}

const mapping = {};
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-images-'));

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.warn('[upload] нет файла:', file);
    continue;
  }

  const base = path.basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'screen';

  const buffer = fs.readFileSync(file);
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  const name = `${date}-${base}-${hash}.jpg`;
  const tmp = path.join(tmpDir, name);

  execFileSync('sips', ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', tmp], {
    stdio: 'ignore',
  });

  let url = existing.get(name);
  if (!url) {
    const body = fs.readFileSync(tmp);
    const res = await fetch(
      `https://uploads.github.com/repos/${owner}/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(body.length),
        },
        body,
      },
    );
    const data = await res.json();
    if (!res.ok) {
      console.error('[upload] отказ:', file, JSON.stringify(data).slice(0, 300));
      continue;
    }
    url = data.browser_download_url;
    existing.set(name, url);
  }

  mapping[file] = url;
  console.log(`${file} → ${url}`);
}

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ...previous, ...mapping }, null, 2), 'utf8');
  console.log('[upload] assets:', outPath);
}
