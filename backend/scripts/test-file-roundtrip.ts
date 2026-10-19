/**
 * Сквозная проверка файлов: загрузка → привязка к записи → скачивание.
 *
 * Существует отдельно от test-pwa-routes потому, что тот проверяет авторизацию,
 * а здесь важна другая часть цепочки: файлы хранятся в db/data/files/<userId>/,
 * адресуются по fileId и прикрепляются к записям через fileIds. Место, где
 * эта цепочка рвётся, не видно ни по одному маршруту по отдельности — нужна
 * вся последовательность целиком.
 *
 * Работает в отдельном каталоге: хранилище берёт путь из process.cwd() при
 * загрузке модуля, поэтому переход выполняется ДО импорта сервера.
 *
 * Сеть не используется. Запуск: npx tsx backend/scripts/test-file-roundtrip.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-file-rt-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'd'.repeat(64);

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');
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

console.log('\n=== Файлы: загрузка → привязка → скачивание ===\n');

const created = userStore.create({ barsLoginHash: computeBarsLoginHash('st000042') });
const userId = created.userId;

// Загрузка файлов идёт через requireBars, поэтому креды БАРС в тесте нужны с
// самого начала. Ниже (шаг 5) они будут сняты намеренно — и вот там уже
// проверяется, что чтение файла от сессии БАРС не зависит.
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
  studentProfile: { fullName: 'Тестов Тест', groupName: 'ИЭ-11-26' },
});

const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));

const auth = { 'x-pwa-token': token };

// ── 1. загрузка ───────────────────────────────────────────────────────────────
const sharp = (await import('sharp')).default;
const CONTENT = await sharp({
  create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 120, b: 200 } },
}).jpeg().toBuffer();

const form = new FormData();
form.append('file', new Blob([CONTENT], { type: 'image/jpeg' }), 'photo.jpg');

const uploaded = await app.inject({ method: 'POST', url: '/api/files/upload', headers: auth, payload: form });

check(
  'POST /api/files/upload → 200',
  uploaded.statusCode === 200,
  `${uploaded.statusCode} ${uploaded.body.slice(0, 200)}`,
);

const fileRef = uploaded.json<{ file?: { fileId?: string; originalName?: string; uploadedBy?: string } }>().file;
check('ответ содержит file.fileId', typeof fileRef?.fileId === 'string', JSON.stringify(fileRef));

if (typeof fileRef?.fileId !== 'string') {
  console.error('\nДальше проверять нечего: файл не загрузился.');
  process.exit(1);
}

check('file.uploadedBy = владелец', fileRef.uploadedBy === userId, `${fileRef.uploadedBy} != ${userId}`);

// ── 1b. превышение потолка размера одного файла ───────────────────────────────
const { MAX_FILE_SIZE_BYTES } = await import('../../db/storage/fileStore.ts');
{
  const oversizeForm = new FormData();
  oversizeForm.append(
    'file',
    new Blob([Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)], { type: 'application/pdf' }),
    'big.pdf',
  );
  const tooBig = await app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: auth,
    payload: oversizeForm,
  });
  check(
    'файл больше 20 МБ → 413 file_rejected',
    tooBig.statusCode === 413 && tooBig.json<{ error?: string }>().error === 'file_rejected',
    `${tooBig.statusCode} ${tooBig.body.slice(0, 160)}`,
  );
}

// Ни MIME/расширение, ни содержимое не должны позволять загрузить активный SVG.
{
  const spoofedForm = new FormData();
  spoofedForm.append(
    'file',
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], {
      type: 'image/svg+xml',
    }),
    'image.png',
  );
  const spoofed = await app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: auth,
    payload: spoofedForm,
  });
  check(
    'SVG с расширением .png отклонён',
    spoofed.statusCode === 413 && spoofed.json<{ error?: string }>().error === 'file_rejected',
    `${spoofed.statusCode} ${spoofed.body.slice(0, 120)}`,
  );

  const wrongSignatureForm = new FormData();
  wrongSignatureForm.append(
    'file',
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], {
      type: 'application/pdf',
    }),
    'image.pdf',
  );
  const wrongSignature = await app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: auth,
    payload: wrongSignatureForm,
  });
  check(
    'активное содержимое с MIME/расширением PDF отклонено по сигнатуре',
    wrongSignature.statusCode === 413 && wrongSignature.json<{ error?: string }>().error === 'file_rejected',
    `${wrongSignature.statusCode} ${wrongSignature.body.slice(0, 120)}`,
  );
}

// ── 2. файл физически лежит в каталоге пользователя ───────────────────────────
const dir = path.join(WORK_DIR, 'db', 'data', 'files', userId);
check('каталог db/data/files/<userId> создан', fs.existsSync(dir), dir);
check('<fileId>.bin на диске', fs.existsSync(path.join(dir, `${fileRef.fileId}.bin`)));
check('<fileId>.meta.json на диске', fs.existsSync(path.join(dir, `${fileRef.fileId}.meta.json`)));

// ── 3. скачивание ──────────────────────────────────────────────────────────────
const downloaded = await app.inject({
  method: 'GET',
  url: `/api/files/${fileRef.fileId}`,
  headers: auth,
});

check('GET /api/files/:fileId → 200', downloaded.statusCode === 200, String(downloaded.statusCode));
check('содержимое совпадает', downloaded.rawPayload.equals(CONTENT));

const meta = await app.inject({ method: 'GET', url: `/api/files/${fileRef.fileId}`, headers: auth });
check('GET /api/files/:fileId/meta → 200', meta.statusCode === 200, String(meta.statusCode));

const range = await app.inject({
  method: 'GET',
  url: `/api/files/${fileRef.fileId}`,
  headers: { ...auth, range: 'bytes=0-3' },
});
check('Range поддерживается (206)', range.statusCode === 206, String(range.statusCode));

// ── 3b. share-ссылка для открытия в Safari ───────────────────────────────────
const shareRes = await app.inject({
  method: 'POST',
  url: `/api/files/${fileRef.fileId}/share`,
  headers: auth,
});
check('POST /:fileId/share → 200', shareRes.statusCode === 200, `${shareRes.statusCode} ${shareRes.body.slice(0, 120)}`);

const sharePath = shareRes.json<{ path?: string }>().path;
check(
  'share отдаёт путь /api/files/share/...',
  typeof sharePath === 'string' && sharePath.startsWith('/api/files/share/'),
  String(sharePath),
);

if (typeof sharePath === 'string') {
  // Без заголовка X-PWA-Token: авторизация — сам одноразовый токен в пути.
  const shared = await app.inject({ method: 'GET', url: sharePath });
  check('GET share без токена → 200', shared.statusCode === 200, String(shared.statusCode));
  check(
    'share отдаётся inline (нативный просмотр Safari)',
    String(shared.headers['content-disposition'] ?? '').startsWith('inline'),
    String(shared.headers['content-disposition']),
  );
  check('share сохраняет Content-Type', shared.headers['content-type'] === 'image/jpeg', String(shared.headers['content-type']));
  check('share содержимое совпадает', shared.rawPayload.equals(CONTENT));
}

const shareGone = await app.inject({
  method: 'GET',
  url: '/api/files/share/00000000-0000-0000-0000-000000000000',
});
check('мёртвая share-ссылка → 410', shareGone.statusCode === 410, String(shareGone.statusCode));

// ── 3c. share-ссылка на скачивание (Android: PDF в TWA не рисуется) ──────────
{
  const downloadRes = await app.inject({
    method: 'POST',
    url: `/api/files/${fileRef.fileId}/share`,
    headers: auth,
    payload: { download: true },
  });
  check('POST /:fileId/share с download → 200', downloadRes.statusCode === 200, String(downloadRes.statusCode));

  const downloadPath = downloadRes.json<{ path?: string; disposition?: string }>().path;
  check('share возвращает disposition=attachment', downloadRes.json<{ disposition?: string }>().disposition === 'attachment');

  if (typeof downloadPath === 'string') {
    const file = await app.inject({ method: 'GET', url: downloadPath });
    check('download-share без токена → 200', file.statusCode === 200, String(file.statusCode));
    check(
      'download-share отдаётся attachment',
      String(file.headers['content-disposition'] ?? '').startsWith('attachment'),
      String(file.headers['content-disposition']),
    );
    check('download-share содержимое совпадает', file.rawPayload.equals(CONTENT));
  }
}

// ── 4. привязка к записи ДЗ ───────────────────────────────────────────────────
userStore.patch(userId, { groupName: 'ИЭ-11-26' });
homeworkStore.save({
  groupName: 'ИЭ-11-26',
  discipline: 'Математика',
  kind: 'practice',
  targetDate: '2026.10.20',
  text: 'фото задания',
  files: [fileRef as never],
  authorId: userId,
  authorName: 'Тест',
  createdAt: new Date().toISOString(),
} as never);

const list = await app.inject({ method: 'GET', url: '/api/homework', headers: auth });
check('GET /api/homework → 200', list.statusCode === 200, String(list.statusCode));

const items = list.json<{ items?: { id: string; files?: { fileId: string; originalName: string }[] }[] }>().items ?? [];
const attached = items[0]?.files ?? [];
check('у записи есть файл', attached.length === 1, JSON.stringify(attached));
check('fileId совпадает', attached[0]?.fileId === fileRef.fileId);
check('originalName не потерян', attached[0]?.originalName === 'photo.jpg', attached[0]?.originalName);

// Файл из списка должен открываться тем же маршрутом, что и загруженный напрямую.
const fromRecord = attached[0]
  ? await app.inject({ method: 'GET', url: `/api/files/${attached[0].fileId}`, headers: auth })
  : null;
check('файл из записи скачивается', fromRecord?.statusCode === 200, String(fromRecord?.statusCode));

// ── 5. БЕЗ сессии БАРС ────────────────────────────────────────────────────────
userStore.clearAuth(userId);

const afterExpiry = await app.inject({
  method: 'GET',
  url: `/api/files/${fileRef.fileId}`,
  headers: auth,
});

check(
  'файл читается без входа в БАРС (не 401)',
  afterExpiry.statusCode === 200,
  `${afterExpiry.statusCode} ${afterExpiry.body.slice(0, 120)}`,
);

const metaAfterExpiry = await app.inject({
  method: 'GET',
  url: `/api/files/${fileRef.fileId}`,
  headers: auth,
});
check('meta читается без входа в БАРС', metaAfterExpiry.statusCode === 200, String(metaAfterExpiry.statusCode));

// ── 6. чужой файл недоступен ──────────────────────────────────────────────────
const stranger = userStore.create({ barsLoginHash: computeBarsLoginHash('st000043') });
const { token: otherToken } = issuePwaToken(stranger.userId);
userStore.addToken(stranger.userId, hashToken(otherToken), new Date(Date.now() + 86_400_000));

const foreign = await app.inject({
  method: 'GET',
  url: `/api/files/${fileRef.fileId}`,
  headers: { 'x-pwa-token': otherToken },
});
check('чужой файл → 404, не 200', foreign.statusCode === 404, String(foreign.statusCode));

// ── 7. Превью изображений ─────────────────────────────────────────────────────
// Загрузка идёт через requireBars, а креды сняты в шаге 5, поэтому возвращаем
// их: проверка превью не должна зависеть от порядка шагов.
userStore.patch(userId, {
  barsAuth: {
    encryptedLogin: 'x', encryptedPass: 'x', iv: 'x', tag: 'x',
    ivPass: 'x', tagPass: 'x', cookiesJson: '{}',
    savedAt: new Date().toISOString(),
  },
  // clearAuth снимает и профиль, а requireBars требует оба поля.
  studentProfile: { fullName: 'Тестов Тест', groupName: 'ИЭ-11-26' },
});

// Настоящий PNG, а не просто байты: sharp проверяет содержимое, и подставные
// «картинки» из букв он справедливо отвергает.
const realPng = await sharp({
  create: { width: 2400, height: 1800, channels: 3, background: { r: 30, g: 90, b: 200 } },
}).png().toBuffer();

const imageForm = new FormData();
imageForm.append('file', new Blob([realPng], { type: 'image/png' }), 'shot.png');
const imageUpload = await app.inject({
  method: 'POST',
  url: '/api/files/upload',
  headers: auth,
  payload: imageForm,
});
const imageId = imageUpload.json<{ file?: { fileId: string } }>().file?.fileId;
check('изображение загружено', typeof imageId === 'string', imageUpload.body.slice(0, 150));

if (imageId) {
  const first = await app.inject({ method: 'GET', url: `/api/files/${imageId}/preview?w=800`, headers: auth });
  check('GET /preview → 200', first.statusCode === 200, `${first.statusCode} ${first.body.slice(0, 120)}`);
  check('Content-Type image/jpeg', first.headers['content-type'] === 'image/jpeg', String(first.headers['content-type']));

  const second = await app.inject({ method: 'GET', url: `/api/files/${imageId}/preview?w=800`, headers: auth });
  check('повторный запрос отдаёт готовый файл (X-Preview-Cache: hit)', second.headers['x-preview-cache'] === 'hit', String(second.headers['x-preview-cache']));

  const clamped = await app.inject({ method: 'GET', url: `/api/files/${imageId}/preview?w=999999`, headers: auth });
  check('ширина нормализуется, запрос не падает', clamped.statusCode === 200, String(clamped.statusCode));

  const garbage = await app.inject({ method: 'GET', url: `/api/files/${imageId}/preview?w=мусор`, headers: auth });
  check('мусор в параметре ширины не ломает маршрут', garbage.statusCode === 200, String(garbage.statusCode));

  // Настоящий минимальный PDF: у него нет превью, и клиент должен получить
  // 415, а не битую картинку.
  const pdfForm = new FormData();
  pdfForm.append(
    'file',
    new Blob([Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1')], {
      type: 'application/pdf',
    }),
    'doc.pdf',
  );
  const pdfUpload = await app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: auth,
    payload: pdfForm,
  });
  const pdfId = pdfUpload.json<{ file?: { fileId: string } }>().file?.fileId;

  if (pdfId) {
    const pdfPreview = await app.inject({
      method: 'GET',
      url: `/api/files/${pdfId}/preview`,
      headers: auth,
    });
    check('превью PDF → 415 (не изображение)', pdfPreview.statusCode === 415, String(pdfPreview.statusCode));
  }

  const missing = await app.inject({
    method: 'GET',
    url: '/api/files/00000000-0000-0000-0000-000000000000/preview',
    headers: auth,
  });
  check('превью несуществующего файла → 404', missing.statusCode === 404, String(missing.statusCode));
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Файлы: ${checks - failures} ok, ${failures} ошибок\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);
