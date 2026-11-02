#!/usr/bin/env node
/**
 * Один заход: собрать черновики → залить новые скрины → опубликовать/обновить
 * статью → отправить итоги и пост в чат бота.
 *
 *   npm run finish -- --date 2026-11-03
 *   npm run finish -- --date 2026-11-03 --no-send
 *   npm run finish -- --date 2026-11-03 --no-publish
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMO = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const at = args.indexOf('--date');
const moscowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const date = at >= 0 ? args[at + 1] : moscowDate;

const noSend = args.includes('--no-send');
const noPublish = args.includes('--no-publish');
const noUpload = args.includes('--no-upload');
const dryRun = args.includes('--dry-run');

function run(script, extra = []) {
  console.log(`\n▶ ${script} ${extra.join(' ')}`);
  execFileSync(process.execPath, [path.join(HERE, script), ...extra], {
    cwd: PROMO,
    stdio: 'inherit',
  });
}

run('build-drafts.mjs', ['--date', date]);

if (!noUpload) {
  run('upload-images.mjs', ['--date', date]);
  // после загрузки в assets.json появились URL — пересобираем статью
  run('build-drafts.mjs', ['--date', date]);
}

if (!noPublish) {
  const hasPage = fs.existsSync(path.join(PROMO, 'drafts', date, 'telegraph.json'));
  run('publish-telegraph.mjs', hasPage ? ['--date', date, '--update'] : ['--date', date]);
  // в посте должна быть свежая ссылка на статью
  run('build-drafts.mjs', ['--date', date]);
}

if (!noSend) {
  run('send-post.mjs', ['--date', date, ...(dryRun ? ['--dry-run'] : [])]);
}

console.log(`\n✅ Готово: drafts/${date}/`);
