#!/usr/bin/env node
/**
 * Собирает коммиты за период и раскладывает пользовательские изменения
 * в drafts/<date>/changes.md.
 *
 * Использование:
 *   npm run collect -- --date 2026-11-03
 *   npm run collect -- --date 2026-11-03 --since 2026-11-01
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

const date = arg('--date') || new Date().toISOString().slice(0, 10);
const sinceArg = arg('--since');
const untilArg = arg('--until');

const lastPath = path.join(PROMO, 'smm', 'last-published.json');
const last = JSON.parse(fs.readFileSync(lastPath, 'utf8'));

function git(argv) {
  return execFileSync('git', argv, { cwd: REPO, encoding: 'utf8' }).trim();
}

let rangeArgs;
let rangeLabel;
if (sinceArg) {
  rangeArgs = [`--since=${sinceArg}`];
  rangeLabel = `с ${sinceArg}`;
} else if (last.commit) {
  rangeArgs = [`${last.commit}..HEAD`];
  rangeLabel = `${last.commit.slice(0, 8)}..HEAD`;
} else {
  rangeArgs = [`--since=${last.publishedAt}`];
  rangeLabel = `с ${last.publishedAt}`;
}
if (untilArg) rangeArgs.push(`--until=${untilArg}`);

const log = git([
  'log',
  ...rangeArgs,
  '--date=short',
  '--pretty=format:%H%x09%ad%x09%s',
]);

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
  // Лендинг и обвязка сборки: пользователю важнее фичи внутри приложения.
  /^pwa\/public\/landing/,
  /^pwa\/public\/sw\.js$/,
  /^pwa\/index\.html$/,
  /^pwa\/vite\.config/,
  /^pwa\/package(-lock)?\.json$/,
  /^pwa\/preview\//,
];

const groups = { feat: [], fix: [], perf: [], other: [] };

for (const line of log ? log.split('\n') : []) {
  const [hash, day, subject] = line.split('\t');
  if (!hash || !subject) continue;

  const match = subject.match(/^(feat|fix|perf|refactor|style|chore|docs|test|ci|build)(\(|!?:)/);
  const type = match?.[1] ?? 'other';
  if (!['feat', 'fix', 'perf'].includes(type)) continue;

  const files = git(['show', '--name-only', '--pretty=format:', hash])
    .split('\n')
    .filter(Boolean);

  const userFiles = files.filter(
    (file) =>
      USER_PATHS.some((re) => re.test(file)) &&
      !IGNORED_PATHS.some((re) => re.test(file)),
  );

  if (userFiles.length === 0) continue;

  groups[type].push({
    hash,
    day,
    subject,
    files: userFiles.slice(0, 6),
  });
}

const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
const outDir = path.join(PROMO, 'drafts', date);
fs.mkdirSync(outDir, { recursive: true });

const lines = [
  `# Изменения за ${date}`,
  '',
  `Период: ${rangeLabel}`,
  `Пользовательских коммитов: ${total}`,
  '',
];

const titles = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  other: 'Other',
};

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
console.log(`[collect] ${total} коммитов → drafts/${date}/changes.md`);
for (const key of ['feat', 'fix', 'perf']) {
  console.log(`  ${titles[key]}: ${groups[key].length}`);
}
