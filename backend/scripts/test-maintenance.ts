/**
 * Тесты уборки диска: селекторы и реальный прогон на временном каталоге.
 *
 * Селекторы проверяются без диска (чистые функции), а `runMaintenance` — на
 * настоящих файлах во временном cwd: важно, что удаляется ровно просроченное
 * и не трогается свежее/используемое.
 *
 * Запуск: npm run test:maintenance
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-maint-'));
const DATA = path.join(WORK_DIR, 'db', 'data');
fs.mkdirSync(path.join(DATA, 'files', 'user-a'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DATA, 'reports'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DATA, 'backup'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

const {
  BACKUP_TTL_DAYS,
  DISK_WARN_RATIO,
  GUEST_TTL_DAYS,
  MIN_FREE_DISK_BYTES,
  PREVIEW_TTL_MS,
  REPORT_TTL_DAYS,
  getDiskUsage,
  selectExpiredPreviews,
  selectOldBackups,
  selectOldReports,
  selectOrphanFiles,
  selectStaleGuestIds,
  selectStaleTmp,
} = await import('../services/maintenance/cleanup.ts');
const { runMaintenance } = await import('../services/maintenance/run.ts');
const { userStore } = await import('../../db/storage/userStore.ts');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

console.log('====================================================');
console.log('   ТЕСТЫ УБОРКИ ДИСКА');
console.log('====================================================');

section('Константы политики');
{
  check('превью живут 30 дней', PREVIEW_TTL_MS === 30 * DAY);
  check('отчёты храним 30 дней', REPORT_TTL_DAYS === 30);
  check('бэкапы на диске 7 дней', BACKUP_TTL_DAYS === 7);
  check('брошенные гости живут 30 дней', GUEST_TTL_DAYS === 30);
  check('порог свободного места 1 ГБ', MIN_FREE_DISK_BYTES === 1024 * 1024 * 1024);
  check('порог предупреждения 80%', DISK_WARN_RATIO === 0.8);
}

section('Селекторы');
{
  const previews = [
    { filePath: 'old.preview-800.jpg', mtimeMs: now - 31 * DAY },
    { filePath: 'fresh.preview-800.jpg', mtimeMs: now - 2 * DAY },
    // Старый оригинал НЕ должен считаться превью, даже если он старый.
    { filePath: 'old.bin', mtimeMs: now - 31 * DAY },
    { filePath: 'old.meta.json', mtimeMs: now - 31 * DAY },
  ];
  const expired = selectExpiredPreviews(previews, now);
  check('старое превью выбрано', expired.includes('old.preview-800.jpg') && expired.length === 1, expired.join(','));
  check('оригинал и метаданные не считаются превью', !expired.some((p) => p.endsWith('.bin') || p.endsWith('.meta.json')));

  const tmp = [
    { filePath: 'x.tmp', mtimeMs: now - 2 * 60 * 60 * 1000 },
    { filePath: 'y.tmp', mtimeMs: now - 5 * 60 * 1000 },
  ];
  const stale = selectStaleTmp(tmp, now);
  check('старый tmp выбран, свежий нет', stale.length === 1 && stale[0] === 'x.tmp', stale.join(','));

  const files = [
    { filePath: 'ref.bin', userId: 'u1', fileId: 'f1', mtimeMs: now - 10 * DAY },
    { filePath: 'orphan-old.bin', userId: 'u1', fileId: 'f2', mtimeMs: now - 10 * DAY },
    { filePath: 'orphan-fresh.bin', userId: 'u1', fileId: 'f3', mtimeMs: now - 1000 },
    { filePath: 'same-id-other-user.bin', userId: 'u2', fileId: 'f1', mtimeMs: now - 10 * DAY },
  ];
  const referenced = new Set(['u1:f1']);
  const orphans = selectOrphanFiles(files, referenced, now);
  check('ссылка защищает файл', !orphans.includes('ref.bin'));
  check('старый сирота удаляется', orphans.includes('orphan-old.bin'));
  check('свежий сирота не трогается', !orphans.includes('orphan-fresh.bin'));
  check('чужой каталог с тем же fileId — сирота', orphans.includes('same-id-other-user.bin'));

  const oldDay = new Date(now - 40 * DAY);
  const oldName = `stats-${oldDay.getUTCFullYear()}.${String(oldDay.getUTCMonth() + 1).padStart(2, '0')}.${String(oldDay.getUTCDate()).padStart(2, '0')}.html`;
  const today = new Date(now);
  const todayName = `stats-${today.getUTCFullYear()}.${String(today.getUTCMonth() + 1).padStart(2, '0')}.${String(today.getUTCDate()).padStart(2, '0')}.html`;
  const oldReports = selectOldReports([oldName, todayName, 'notes.html'], now);
  check('старый отчёт выбран', oldReports.includes(oldName), oldReports.join(','));
  check('свежий и мусорный не выбраны', !oldReports.includes(todayName) && !oldReports.includes('notes.html'));

  const backups = [
    { filePath: '/backup/old', mtimeMs: now - 10 * DAY },
    { filePath: '/backup/fresh', mtimeMs: now - 2 * DAY },
  ];
  const oldBackups = selectOldBackups(backups, now);
  check('старый бэкап выбран, свежий нет', oldBackups.length === 1 && oldBackups[0] === '/backup/old', oldBackups.join(','));

  const guests = [
    { id: 'guest-old', isGuest: true, lastActiveAt: now - 31 * DAY },
    { id: 'guest-fresh', isGuest: true, lastActiveAt: now - 2 * DAY },
    { id: 'user-old', isGuest: false, lastActiveAt: now - 31 * DAY },
  ];
  const staleGuests = selectStaleGuestIds(guests, now);
  check(
    'старый гость выбран, свежий и обычный — нет',
    staleGuests.length === 1 && staleGuests[0] === 'guest-old',
    staleGuests.join(','),
  );
}

section('Свободное место');
{
  const usage = await getDiskUsage(DATA);
  check('статистика диска доступна', usage !== null);
  if (usage) {
    check('свободно больше нуля', usage.freeBytes > 0);
    check('доля занятого в диапазоне 0..1', usage.usedRatio >= 0 && usage.usedRatio <= 1, String(usage.usedRatio));
  }
}

section('Полный прогон на временном каталоге');
{
  const userDir = path.join(DATA, 'files', '11111111-2222-4333-8444-555555555555');
  fs.mkdirSync(userDir, { recursive: true });

  const oldPreview = path.join(userDir, 'aaaaaaaa-1111-4111-8111-111111111111.preview-800.jpg');
  const freshPreview = path.join(userDir, 'bbbbbbbb-1111-4111-8111-111111111111.preview-800.jpg');
  const oldOrphan = path.join(userDir, 'cccccccc-1111-4111-8111-111111111111.bin');
  const freshOrphan = path.join(userDir, 'dddddddd-1111-4111-8111-111111111111.bin');
  const tmpFile = path.join(DATA, 'stale.tmp');

  for (const file of [oldPreview, freshPreview, oldOrphan, freshOrphan, tmpFile]) {
    fs.writeFileSync(file, 'x');
  }
  fs.utimesSync(oldPreview, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
  fs.utimesSync(oldOrphan, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
  fs.utimesSync(tmpFile, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));

  const oldReport = path.join(DATA, 'reports', 'stats-2020.01.01.html');
  const freshReport = path.join(DATA, 'reports', 'stats-2099.01.01.html');
  fs.writeFileSync(oldReport, '<html></html>');
  fs.writeFileSync(freshReport, '<html></html>');

  const oldBackup = path.join(DATA, 'backup', 'old-backup');
  const freshBackup = path.join(DATA, 'backup', 'fresh-backup');
  fs.mkdirSync(oldBackup);
  fs.mkdirSync(freshBackup);
  fs.writeFileSync(path.join(oldBackup, 'x.json'), '{}');
  fs.utimesSync(oldBackup, new Date(now - 10 * DAY), new Date(now - 10 * DAY));

  const result = await runMaintenance(now);

  check('превью: удалено одно', result.previews === 1, String(result.previews));
  check('сироты: удалён старый .bin', result.orphans === 1, String(result.orphans));
  check('tmp: удалён старый', result.tmp >= 1, String(result.tmp));
  check('отчёт 2020 удалён', result.reports === 1, String(result.reports));
  check('старый бэкап удалён', result.backups === 1, String(result.backups));

  check('старое превью исчезло', !fs.existsSync(oldPreview));
  check('свежее превью на месте', fs.existsSync(freshPreview));
  check('старый сирота-бин исчез', !fs.existsSync(oldOrphan));
  check('свежий бин на месте', fs.existsSync(freshOrphan));
  check('старый отчёт исчез', !fs.existsSync(oldReport));
  check('свежий отчёт на месте', fs.existsSync(freshReport));
  check('старый бэкап-каталог исчез', !fs.existsSync(oldBackup));
  check('свежий бэкап на месте', fs.existsSync(freshBackup));
}

section('Брошенные гости');
{
  const oldGuest = userStore.create({ barsLoginHash: 'guest:test-old', firstName: 'Старый гость' });
  userStore.patch(oldGuest.userId, { isGuest: true });
  const realUser = userStore.create({ barsLoginHash: 'real:test-user', firstName: 'Студент' });

  // Сдвигаем время вперёд: гость создан «сейчас», значит для будущего прогона
  // он уже старше 30 дней. Обычный пользователь не должен попасть под уборку.
  const result = await runMaintenance(now + 31 * DAY + 60_000);

  check('брошенный гость удалён', userStore.getByUserId(oldGuest.userId) === undefined);
  check('обычный пользователь не тронут', userStore.getByUserId(realUser.userId) !== undefined);
  check('счётчик гостей в результате', result.guests === 1, String(result.guests));
}

await fsp.rm(WORK_DIR, { recursive: true, force: true });

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
