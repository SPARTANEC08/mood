#!/usr/bin/env node
/**
 * Сжимает скрины и заливает их на mood-app.ru/media/.
 *
 *   npm run upload -- media/stock/10-calculator-plan.png
 *   npm run upload -- media/stock/*.png --out drafts/2026-11-03/assets.json
 *
 * Telegraph upload закрыт в 2026, поэтому используем свой VPS.
 * Файлы кладутся в /var/www/mood-media и отдаются nginx как /media/.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const remoteIndex = args.indexOf('--remote');
const remote = remoteIndex >= 0 ? args[remoteIndex + 1] : 'ru';
const dirIndex = args.indexOf('--dir');
const remoteDir = dirIndex >= 0 ? args[dirIndex + 1] : '/var/www/mood-media';
const dateIndex = args.indexOf('--date');
const date = dateIndex >= 0
  ? args[dateIndex + 1]
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

const files = args.filter((a, i) => {
  if (a === '--out' || a === '--remote' || a === '--dir' || a === '--date') return false;
  if (i > 0 && ['--out', '--remote', '--dir', '--date'].includes(args[i - 1])) return false;
  return !a.startsWith('--');
});

if (files.length === 0) {
  console.error('Укажи файлы: npm run upload -- media/stock/01-schedule.png');
  process.exit(1);
}

execFileSync('ssh', ['-o', 'ConnectTimeout=20', remote, `mkdir -p ${remoteDir}`], { stdio: 'ignore' });

const mapping = {};
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-upload-'));

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

  execFileSync('scp', ['-q', '-o', 'ConnectTimeout=20', tmp, `${remote}:${remoteDir}/${name}`], {
    stdio: 'inherit',
  });

  const url = `https://mood-app.ru/media/${name}`;
  mapping[file] = url;

  try {
    const res = await fetch(url, { method: 'HEAD' });
    console.log(`${file} → ${url} ${res.ok ? 'ok' : `HTTP ${res.status}`}`);
  } catch {
    console.log(`${file} → ${url} (проверь вручную)`);
  }
}

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(mapping, null, 2), 'utf8');
  console.log('[upload] assets:', outPath);
}
