/**
 * Доступ к файлам вложений для одногруппников.
 *
 * Регрессия: скачивание и превью искали файл только в каталоге запрашивающего,
 * поэтому фотографии видел лишь автор загрузки. Здесь проверяется, что файл,
 * привязанный к записи группы, открывается любому участнику группы, но не
 * чужакам и не по «голому» fileId без привязки.
 *
 * Запуск: npm run test:file-access
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-file-access-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'a'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'b'.repeat(64);

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { saveFile } = await import('../../db/storage/fileStore.ts');
const { homeworkStore } = await import('../../db/storage/homeworkStore.ts');

const app = await buildServer();
await app.ready();

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function createUser(login: string, groupName: string) {
  const user = userStore.create({ barsLoginHash: computeBarsLoginHash(login) });
  userStore.patchByUserId(user.userId, {
    groupName,
    studentProfile: { fullName: `Студент ${login}`, groupName },
  });
  const { token } = issuePwaToken(user.userId);
  userStore.addToken(user.userId, hashToken(token), new Date(Date.now() + 86_400_000));
  return { user: userStore.getByUserId(user.userId)!, token, auth: { 'x-pwa-token': token } };
}

console.log('\n=== Доступ к файлам вложений ===\n');

const author = createUser('file-author', 'ИЭ-11-26');
const classmate = createUser('file-classmate', 'ИЭ-11-26');
const stranger = createUser('file-stranger', 'ИЭ-12-26');

// Крошечный валидный PNG — превью для него строится, если sharp доступен.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
  'base64',
);

const file = await saveFile(author.user.userId, png, 'photo.png', 'image/png', author.user.userId);

const homework = {
  id: 'hw-file-access',
  groupName: 'ИЭ-11-26',
  discipline: 'Математический анализ',
  kind: 'practice' as const,
  targetDate: '2026.10.28',
  text: 'Фото задания',
  files: [file],
  authorId: author.user.userId,
  authorName: 'Студент file-author',
  createdAt: new Date().toISOString(),
};
homeworkStore.save(homework);

const url = (suffix = '') => `/api/files/${encodeURIComponent(file.fileId)}${suffix}`;

const own = await app.inject({ method: 'GET', url: url(), headers: author.auth });
check('автор скачивает свой файл', own.statusCode === 200, String(own.statusCode));

const mate = await app.inject({ method: 'GET', url: url(), headers: classmate.auth });
check('одногруппник скачивает файл', mate.statusCode === 200, String(mate.statusCode));
check('содержимое совпадает', mate.rawPayload.equals(png));

const foreign = await app.inject({ method: 'GET', url: url(), headers: stranger.auth });
check('чужая группа не получает файл', foreign.statusCode === 404, String(foreign.statusCode));

const mateMeta = await app.inject({ method: 'GET', url: url('/meta'), headers: classmate.auth });
check('одногруппник видит метаданные', mateMeta.statusCode === 200, String(mateMeta.statusCode));

const foreignMeta = await app.inject({ method: 'GET', url: url('/meta'), headers: stranger.auth });
check('чужая группа не видит метаданные', foreignMeta.statusCode === 404, String(foreignMeta.statusCode));

const matePreview = await app.inject({ method: 'GET', url: url('/preview?w=200'), headers: classmate.auth });
check('одногруппник получает превью', matePreview.statusCode !== 404, String(matePreview.statusCode));

const foreignPreview = await app.inject({ method: 'GET', url: url('/preview?w=200'), headers: stranger.auth });
check('чужая группа не получает превью', foreignPreview.statusCode === 404, String(foreignPreview.statusCode));

const mateShare = await app.inject({ method: 'POST', url: url('/share'), headers: classmate.auth, payload: {} });
check('одногруппник получает share-ссылку', mateShare.statusCode === 200, String(mateShare.statusCode));

const foreignShare = await app.inject({ method: 'POST', url: url('/share'), headers: stranger.auth, payload: {} });
check('чужая группа не получает share-ссылку', foreignShare.statusCode === 404, String(foreignShare.statusCode));

// Файл, который ещё не привязан к записи, чужим не отдаётся.
const loose = await saveFile(author.user.userId, png, 'loose.png', 'image/png', author.user.userId);
const looseMate = await app.inject({
  method: 'GET',
  url: `/api/files/${encodeURIComponent(loose.fileId)}`,
  headers: classmate.auth,
});
check('непривязанный файл одногруппнику недоступен', looseMate.statusCode === 404, String(looseMate.statusCode));

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалов: ${failures}\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);
