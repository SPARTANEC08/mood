/**
 * Проверка полного удаления аккаунта на живом Fastify и реальной SQLite.
 *
 * Работает во временном каталоге: рабочая база не читается. Проверяются не
 * только ответы API, но и строки в таблицах users / records / documents /
 * user_events / homework_done и каталог файлов — иначе «удалено» могло бы
 * означать «скрыто из выдачи».
 *
 * Запуск: npm run test:account-delete
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-account-delete-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'a'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'b'.repeat(64);

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { snapshotStore } = await import('../../db/storage/snapshotStore.ts');
const { userEventStore } = await import('../../db/storage/userEventStore.ts');
const { homeworkDoneStore } = await import('../../db/storage/homeworkDoneStore.ts');
const { homeworkStore } = await import('../../db/storage/homeworkStore.ts');
const { importantStore } = await import('../../db/storage/importantStore.ts');
const { announcementStore } = await import('../../db/storage/announcementStore.ts');
const { saveFile } = await import('../../db/storage/fileStore.ts');
const { recordActivity } = await import('../server/devStats.ts');
const { getDb } = await import('../../db/sqlite.ts');
const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');

const app = await buildServer();
await app.ready();

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function auth(token: string): Record<string, string> {
  return { 'x-pwa-token': token };
}

const user = userStore.create({
  barsLoginHash: computeBarsLoginHash('delete-account-test'),
});
const userId = user.userId;

userStore.patch(userId, {
  barsAuth: {
    encryptedLogin: 'x',
    encryptedPass: 'x',
    iv: 'x',
    tag: 'x',
    ivPass: 'x',
    tagPass: 'x',
    cookiesJson: '{}',
    savedAt: new Date().toISOString(),
  },
  studentProfile: { fullName: 'Удаляемый Студент', groupName: 'ИЭ-11-26' },
});

const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));

const snapshot = {
  gradesHash: { 'Математический анализ_КТ1': 10 },
  lastSeenMailUid: 5,
  ordersCount: 1,
  scholarshipStatus: 'нет',
  lastCheckedAt: new Date().toISOString(),
};
snapshotStore.save(userId, snapshot);

userEventStore.add({
  userId,
  key: 'test:grade',
  kind: 'grade',
  label: 'Новые оценки',
  details: ['Математический анализ · КМ1: 10'],
  createdAt: new Date().toISOString(),
});

const homework = {
  id: 'homework-delete-test',
  groupName: 'ИЭ-11-26',
  discipline: 'Математический анализ',
  kind: 'practice' as const,
  targetDate: '2099.01.10',
  text: 'Удалить вместе с автором',
  files: [],
  authorId: userId,
  authorName: 'Удаляемый Студент',
  createdAt: new Date().toISOString(),
};
homeworkStore.save(homework);
homeworkDoneStore.setDone(userId, homework.id, true);

const groupmate = userStore.create({ barsLoginHash: computeBarsLoginHash('delete-account-groupmate') });
homeworkDoneStore.setDone(groupmate.userId, homework.id, true);

const important = {
  id: 'important-delete-test',
  groupName: 'ИЭ-11-26',
  title: 'Объявление',
  text: 'Удалить вместе с автором',
  files: [],
  authorId: userId,
  authorName: 'Удаляемый Студент',
  createdAt: new Date().toISOString(),
};
importantStore.save(important);

const announcement = announcementStore.create('Объявление удаляемого пользователя', userId);
announcementStore.dismiss(userId, announcement.id);

const uploaded = await saveFile(
  userId,
  Buffer.from('file to delete', 'utf8'),
  'delete-me.txt',
  'text/plain',
);

recordActivity(userId, '/api/bootstrap');

const db = getDb();
const fileDir = path.join(WORK_DIR, 'db', 'data', 'files', userId);

function count(sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

console.log('\n=== Удаление аккаунта ===\n');

const wrong = await app.inject({
  method: 'POST',
  url: '/api/account/delete',
  headers: auth(token),
  payload: { confirmation: 'удалить' },
});
check('неверное подтверждение → 400', wrong.statusCode === 400, String(wrong.statusCode));
check('аккаунт не удалён без подтверждения', userStore.getByUserId(userId) !== undefined);

const deleted = await app.inject({
  method: 'POST',
  url: '/api/account/delete',
  headers: auth(token),
  payload: { confirmation: 'УДАЛИТЬ' },
});
check('верное подтверждение → 200', deleted.statusCode === 200, String(deleted.statusCode));

check('запись users удалена', userStore.getByUserId(userId) === undefined);
check(
  'строка users в SQLite удалена',
  count('SELECT COUNT(*) AS count FROM users WHERE user_id = ?', userId) === 0,
);

const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
check('старый токен больше не работает', me.statusCode === 401, String(me.statusCode));

check(
  'user_events удалены',
  count('SELECT COUNT(*) AS count FROM user_events WHERE user_id = ?', userId) === 0,
);
check(
  'homework_done удалены',
  count('SELECT COUNT(*) AS count FROM homework_done WHERE user_id = ?', userId) === 0,
);
check(
  'отметки одногруппников по удалённому ДЗ убраны',
  count('SELECT COUNT(*) AS count FROM homework_done WHERE homework_id = ?', homework.id) === 0,
);
check(
  'снимок БАРС удалён из records',
  count(
    "SELECT COUNT(*) AS count FROM records WHERE store = 'bars_snapshots.json' AND key = ?",
    userId,
  ) === 0,
);
check(
  'ДЗ автора удалено',
  count(
    "SELECT COUNT(*) AS count FROM records WHERE store = 'homework.json' AND json_extract(value, '$.authorId') = ?",
    userId,
  ) === 0,
);
check(
  '«Важное» автора удалено',
  count(
    "SELECT COUNT(*) AS count FROM records WHERE store = 'important.json' AND json_extract(value, '$.authorId') = ?",
    userId,
  ) === 0,
);

const announcementsRow = db
  .prepare("SELECT value FROM documents WHERE name = 'announcements.json'")
  .get() as { value: string } | undefined;
const announcements = announcementsRow
  ? (JSON.parse(announcementsRow.value) as {
      items: Array<{ id: string; createdBy?: number }>;
      dismissed: Record<string, string[]>;
    })
  : { items: [], dismissed: {} };
check('отметки о закрытии удалены', announcements.dismissed[userId] === undefined);

const statsRow = db
  .prepare("SELECT value FROM documents WHERE name = 'stats_window.json'")
  .get() as { value: string } | undefined;
const stats = statsRow
  ? (JSON.parse(statsRow.value) as {
      minutes: Array<{ users: string[]; barsNew: string[] }>;
    })
  : { minutes: [] };
check(
  'пользователь убран из статистики',
  !stats.minutes.some(
    (bucket) => bucket.users.includes(userId) || bucket.barsNew.includes(userId),
  ),
);

check('каталог файлов удалён', !fs.existsSync(fileDir), fileDir);
check('файл больше не числится', uploaded.uploadedBy === userId);

await app.close();
fs.rmSync(WORK_DIR, { recursive: true, force: true });

console.log('\n====================================================');
console.log(`ИТОГО: ${failures === 0 ? '✅' : '❌'} ${checks - failures} / ${checks}`);
console.log('====================================================\n');

process.exit(failures === 0 ? 0 : 1);
