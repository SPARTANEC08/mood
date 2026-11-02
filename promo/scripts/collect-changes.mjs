#!/usr/bin/env node
/**
 * Собирает пользовательские коммиты за день и пишет drafts/<date>/changes.md.
 *
 *   npm run collect -- --date 2026-11-03
 *   npm run collect -- --since-last
 *
 * По умолчанию период — календарный день по Москве.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');
const REPO = path.resolve(PROMO, '..');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const moscowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const date = arg('--date') || moscowDate;

function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const since = arg('--since') || `${date} 00:00:00 +0300`;
const until = arg('--until') || `${nextDay(date)} 00:00:00 +0300`;
let rangeLabel = `за ${date}`;

const gitArgs = ['log', '--date=short', '--name-only', '--pretty=format:%x1e%H%x09%ad%x09%s'];

if (args.includes('--since-last')) {
  const lastPath = path.join(PROMO, 'smm', 'last-published.json');
  const last = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
  if (last.commit) {
    gitArgs.push(`${last.commit}..HEAD`);
    rangeLabel = `${String(last.commit).slice(0, 8)}..HEAD`;
  } else if (last.publishedAt) {
    gitArgs.push(`--since=${last.publishedAt}`);
    rangeLabel = `с ${last.publishedAt}`;
  }
} else {
  gitArgs.push(`--since=${since}`, `--until=${until}`);
}

const log = execFileSync('git', gitArgs, {
  cwd: REPO,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
}).trim();

const USER_PATHS = [
  /^pwa\/(?!src\/test\/|scripts\/)/,
  /^ios\/(?!README|check\.sh)/,
  /^backend\/server\//,
  /^backend\/services\//,
  /^backend\/parser\//,
  /^backend\/scheduleCache\.ts$/,
];

const IGNORED_PATHS = [
  /^backend\/scripts\//,
  /^backend\/deploy\//,
  /^docs\//,
  /^promo\//,
  /^db\//,
  /^tg\//,
  /^pwa\/public\/landing/,
  /^pwa\/public\/sw\.js$/,
  /^pwa\/index\.html$/,
  /^pwa\/vite\.config/,
  /^pwa\/package(-lock)?\.json$/,
  /^pwa\/preview\//,
];

const groups = { feat: [], fix: [], perf: [] };
const typeRe = /^(feat|fix|perf)(\(|!?:)/;

for (const record of log.split('\x1e')) {
  const clean = record.trim();
  if (!clean) continue;

  const [header, ...fileLines] = clean.split('\n');
  const [hash, day, ...subjectParts] = header.split('\t');
  const subject = subjectParts.join('\t');
  if (!hash || !subject) continue;

  const type = subject.match(typeRe)?.[1];
  if (!type) continue;

  const userFiles = fileLines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (file) =>
        USER_PATHS.some((re) => re.test(file)) &&
        !IGNORED_PATHS.some((re) => re.test(file)),
    );

  if (userFiles.length === 0) continue;

  groups[type].push({ hash, day, subject, files: userFiles.slice(0, 6) });
}

const total = groups.feat.length + groups.fix.length + groups.perf.length;
const outDir = path.join(PROMO, 'drafts', date);
fs.mkdirSync(outDir, { recursive: true });

const titles = { feat: 'Features', fix: 'Fixes', perf: 'Performance' };
const lines = [
  `# Изменения за ${date}`,
  '',
  `Период: ${rangeLabel}`,
  `Пользовательских коммитов: ${total}`,
  '',
];

for (const key of ['feat', 'fix', 'perf']) {
  lines.push(`## ${titles[key]}`);
  if (groups[key].length === 0) {
    lines.push('- нет');
  } else {
    for (const item of groups[key]) {
      lines.push(`- \`${item.hash.slice(0, 8)}\` ${item.day} — ${item.subject}`);
      lines.push(`  файлы: ${item.files.join(', ')}`);
    }
  }
  lines.push('');
}

fs.writeFileSync(path.join(outDir, 'changes.md'), lines.join('\n'), 'utf8');
console.log(`[collect] ${total} коммитов ${rangeLabel} → drafts/${date}/changes.md`);
for (const key of ['feat', 'fix', 'perf']) {
  console.log(`  ${titles[key]}: ${groups[key].length}`);
}
