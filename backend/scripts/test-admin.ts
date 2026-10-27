/**
 * Админка PWA: доступ, пользователи, объявления, рассылка, статистика, аудит.
 *
 * Сеть не используется: рассылка идёт только в ленту (push/TG не настроены),
 * статистика проверяется на фикстуре HTML.
 *
 * Запуск: npm run test:admin
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-admin-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data', 'reports'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'd'.repeat(64);
process.env.ADMIN_BARS_LOGINS = 'root-admin';

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { announcementStore } = await import('../../db/storage/announcementStore.ts');
const { pwaAdminsStore } = await import('../../db/storage/pwaAdminsStore.ts');
const { adminAuditStore } = await import('../../db/storage/adminAuditStore.ts');
const { parseHtml, summarize, saveDailyStats, readDailyStats } = await import(
  '../services/admin/statsHistory.ts'
);
const { isBackgroundRequest, recordActivity, getStats } = await import('../server/devStats.ts');

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

function createUser(login: string, init: Record<string, unknown> = {}) {
  const user = userStore.create({ barsLoginHash: computeBarsLoginHash(login), firstName: login });
  userStore.patchByUserId(user.userId, {
    studentProfile: { fullName: `Студент ${login}` },
    ...init,
  });
  const { token } = issuePwaToken(user.userId);
  userStore.addToken(user.userId, hashToken(token), new Date(Date.now() + 86_400_000));
  return { user: userStore.getByUserId(user.userId)!, token, auth: { 'x-pwa-token': token } };
}

async function waitJob(id: string, auth: Record<string, string>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/admin/jobs/${id}`, headers: auth });
    const job = response.json<{ status: string; done: number; total: number; progress: Record<string, number> }>();
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

console.log('\n=== Админка PWA ===\n');

const root = createUser('root-admin');
const plain = createUser('plain-user');
const target = createUser('target-user');
const guest = createUser('guest-user', { isGuest: true });

// ── Доступ ────────────────────────────────────────────────────────────────────
console.log('— Доступ —');

const anonymous = await app.inject({ method: 'GET', url: '/api/admin/users' });
check('без токена → 401', anonymous.statusCode === 401, String(anonymous.statusCode));

const denied = await app.inject({ method: 'GET', url: '/api/admin/users', headers: plain.auth });
check('обычный пользователь → 403', denied.statusCode === 403, String(denied.statusCode));

const envAdmin = await app.inject({ method: 'GET', url: '/api/admin/users', headers: root.auth });
check('env-логин БАРС → 200', envAdmin.statusCode === 200, String(envAdmin.statusCode));

// ── Пользователи ──────────────────────────────────────────────────────────────
console.log('— Пользователи —');

const list = await app.inject({
  method: 'GET',
  url: '/api/admin/users?query=target',
  headers: root.auth,
});
check('поиск по имени работает', list.statusCode === 200 && list.json<{ users: unknown[] }>().users.length === 1);

const idle = createUser('idle-user');

const idleList = await app.inject({
  method: 'GET',
  url: '/api/admin/users?query=idle',
  headers: root.auth,
});
const idleRow = idleList.json<{ users: Array<{ lastSeenAt: number }> }>().users[0];
check('updatedAt не считается активностью', idleRow?.lastSeenAt === 0, String(idleRow?.lastSeenAt));

recordActivity(idle.user.userId, '/api/bars/grades');
const idleAfter = await app.inject({
  method: 'GET',
  url: '/api/admin/users?query=idle',
  headers: root.auth,
});
const idleAfterRow = idleAfter.json<{ users: Array<{ lastSeenAt: number }> }>().users[0];
check(
  'реальная активность видна',
  (idleAfterRow?.lastSeenAt ?? 0) > Date.now() - 5_000,
  String(idleAfterRow?.lastSeenAt),
);

const guestList = await app.inject({
  method: 'GET',
  url: '/api/admin/users?query=guest',
  headers: root.auth,
});
check(
  'гость виден в списке',
  guestList.json<{ users: Array<{ isGuest: boolean }> }>().users.some((user) => user.isGuest),
);
check('гость помечен в ответе', guestList.json<{ users: Array<{ id: string }> }>().users.some((user) => user.id === guest.user.userId));

const card = await app.inject({
  method: 'GET',
  url: `/api/admin/users/${target.user.userId}`,
  headers: root.auth,
});
check('карточка пользователя', card.statusCode === 200);
check('в карточке нет секретов', !JSON.stringify(card.json()).includes('encryptedPass'));

const reset = await app.inject({
  method: 'POST',
  url: `/api/admin/users/${target.user.userId}/reset-sessions`,
  headers: root.auth,
});
check('сброс сессий', reset.statusCode === 200);

const deleteBad = await app.inject({
  method: 'POST',
  url: `/api/admin/users/${target.user.userId}/delete`,
  headers: root.auth,
  payload: { confirmation: 'удалить' },
});
check('удаление без слова → 400', deleteBad.statusCode === 400, String(deleteBad.statusCode));

// ── Объявления ────────────────────────────────────────────────────────────────
console.log('— Объявления —');

const created = await app.inject({
  method: 'POST',
  url: '/api/admin/announcements',
  headers: root.auth,
  payload: { text: 'Тестовое объявление' },
});
check('объявление создано', created.statusCode === 200);

const announcementId = created.json<{ item: { id: string } }>().item.id;
check(
  'объявление видно пользователю',
  announcementStore.listForUser(plain.user.userId).some((item) => item.id === announcementId),
);

const personal = await app.inject({
  method: 'POST',
  url: '/api/admin/announcements',
  headers: root.auth,
  payload: { text: 'Личное', userId: target.user.userId },
});
const personalId = personal.json<{ item: { id: string } }>().item.id;
check(
  'личное объявление видит адресат',
  announcementStore.listForUser(target.user.userId).some((item) => item.id === personalId),
);
check(
  'личное объявление не видит другой',
  !announcementStore.listForUser(plain.user.userId).some((item) => item.id === personalId),
);

const removedAnnouncement = await app.inject({
  method: 'DELETE',
  url: `/api/admin/announcements/${announcementId}`,
  headers: root.auth,
});
check('объявление удалено', removedAnnouncement.statusCode === 200);

// ── Рассылка ──────────────────────────────────────────────────────────────────
console.log('— Рассылка —');

const broadcast = await app.inject({
  method: 'POST',
  url: '/api/admin/broadcast',
  headers: root.auth,
  payload: { text: 'Всем привет', url: 'https://example.test' },
});
check('рассылка запущена', broadcast.statusCode === 200, String(broadcast.statusCode));

const job = broadcast.statusCode === 200
  ? await waitJob(broadcast.json<{ jobId: string }>().jobId, root.auth)
  : null;
check('рассылка завершилась', job?.status === 'done', JSON.stringify(job));
check('в ленте появилось объявление', announcementStore.listAll().some((item) => item.text === 'Всем привет'));
check('прогресс посчитан', (job?.progress.feed ?? 0) >= 1);

const personalBroadcast = await app.inject({
  method: 'POST',
  url: '/api/admin/broadcast',
  headers: root.auth,
  payload: { text: 'Только тебе', userId: target.user.userId },
});
check('личная рассылка запущена', personalBroadcast.statusCode === 200);
if (personalBroadcast.statusCode === 200) {
  await waitJob(personalBroadcast.json<{ jobId: string }>().jobId, root.auth);
}
check(
  'личная рассылка адресована',
  announcementStore.listAll().some(
    (item) => item.text === 'Только тебе' && item.targetUserId === target.user.userId,
  ),
);

// ── Регистрация и обслуживание ────────────────────────────────────────────────
console.log('— Регистрация и обслуживание —');

const regClosed = await app.inject({
  method: 'POST',
  url: '/api/admin/registration',
  headers: root.auth,
  payload: { open: false },
});
check('регистрация закрыта', regClosed.json<{ open: boolean }>().open === false);

const maintenance = await app.inject({ method: 'POST', url: '/api/admin/maintenance', headers: root.auth });
check('обслуживание выполнилось', maintenance.statusCode === 200);
check(
  'результат уборки содержит счётчики',
  typeof maintenance.json<{ result: { reports: number } }>().result.reports === 'number',
);

// ── Админы ────────────────────────────────────────────────────────────────────
console.log('— Админы —');

const addAdmin = await app.inject({
  method: 'POST',
  url: '/api/admin/admins',
  headers: root.auth,
  payload: { userId: plain.user.userId },
});
check('назначение админа', addAdmin.statusCode === 200, String(addAdmin.statusCode));

const nowAdmin = await app.inject({ method: 'GET', url: '/api/admin/users', headers: plain.auth });
check('назначенный получил доступ', nowAdmin.statusCode === 200);

const adminsList = await app.inject({ method: 'GET', url: '/api/admin/admins', headers: root.auth });
check(
  'назначенный в списке',
  adminsList.json<{ assigned: Array<{ userId: string }> }>().assigned.some(
    (item) => item.userId === plain.user.userId,
  ),
);

const removeAdmin = await app.inject({
  method: 'DELETE',
  url: `/api/admin/admins/${plain.user.userId}`,
  headers: root.auth,
});
check('снятие админа', removeAdmin.statusCode === 200);
check('права сняты', !pwaAdminsStore.has(plain.user.userId));

// ── Статистика ────────────────────────────────────────────────────────────────
console.log('— Статистика —');

const html = `<!doctype html><html><body>
  <h2>Сейчас</h2>
  <div class="card"><div class="k">Активных сессий БАРС</div><div class="v">3</div></div>
  <div class="card"><div class="k">Онлайн (±5 мин)</div><div class="v">2</div></div>
  <h2>За 24 часа</h2>
  <div class="card"><div class="k">Запросов</div><div class="v">100</div></div>
  <div class="card"><div class="k">Заходов в приложение</div><div class="v">10</div></div>
  <div class="card"><div class="k">Максимум онлайна</div><div class="v">5</div></div>
  <div class="card"><div class="k">Новых сессий БАРС</div><div class="v">4</div></div>
  <div class="card"><div class="k">🍏 iOS</div><div class="v">1</div></div>
  <div class="card"><div class="k">🤖 Android</div><div class="v">2</div></div>
  <div class="card"><div class="k">🌐 Web</div><div class="v">0</div></div>
  <div class="card"><div class="k">❓ Неизвестно</div><div class="v">0</div></div>
  <div class="chart"><i style="height:50%" title="10 — 50"></i><i style="height:100%" title="11 — 50"></i></div>
  <div class="card"><div class="k">ДЗ создано / удалено</div><div class="v">2 / 1</div><div class="hint">всего сейчас: 7</div></div>
  <div class="card"><div class="k">Важное создано / удалено</div><div class="v">0 / 0</div><div class="hint">всего сейчас: 1</div></div>
  <h2>Файлы · 4 шт, 1,2 МБ</h2>
  <h2>Сессии БАРС · 3</h2>
</body></html>`;

const parsed = parseHtml(html, '2026-10-20');
check('HTML: запросы', parsed?.requests === 100, String(parsed?.requests));
check('HTML: онлайн', parsed?.currentOnline === 2);
check('HTML: ДЗ', parsed?.homework.created === 2 && parsed?.homework.total === 7);
check('HTML: часы', parsed?.hours?.[1]?.value === 50);
check('HTML: файлы', parsed?.files.totalFiles === 4 && parsed?.files.totalBytes > 0);

const summary = summarize([parsed!, { ...parsed!, date: '2026-10-21', requests: 50, visits: 5 }]);
check('сумма запросов', summary.totals.requests === 150);
check('последний день', summary.latest?.date === '2026-10-21');

saveDailyStats(
  {
    generatedAt: Date.now(),
    windowStart: Date.now() - 86_400_000,
    windowEnd: Date.now(),
    moscowNow: { date: '20.10.2026', time: '12:00' },
    current: { barsSessions: 1, online: 1 },
    window: {
      requests: 10,
      visits: 2,
      maxOnline: 1,
      newBarsSessions: 1,
      homework: { created: 0, deleted: 0, total: 0 },
      important: { created: 0, deleted: 0, total: 0 },
    },
    requestsByHour: [],
    platforms: { ios: 1, android: 0, web: 0, unknown: 0 },
    sessions: [],
    files: { totalFiles: 0, totalBytes: 0, byUser: [] },
  } as never,
  '2026-10-20',
);
check('JSON-срез читается', readDailyStats('2026-10-20')?.requests === 10);

const stats = await app.inject({
  method: 'GET',
  url: '/api/admin/stats?period=today',
  headers: root.auth,
});
check('живая статистика за сегодня', stats.statusCode === 200 && stats.json<{ days: unknown[] }>().days.length === 1);

const badDate = await app.inject({
  method: 'GET',
  url: '/api/admin/stats?period=date&date=2020-01-01',
  headers: root.auth,
});
check('чужая дата → 400', badDate.statusCode === 400, String(badDate.statusCode));

// ── Диагностика и аудит ───────────────────────────────────────────────────────
console.log('— Диагностика и аудит —');

const diagnostics = await app.inject({ method: 'GET', url: '/api/admin/diagnostics', headers: root.auth });
check('диагностика', diagnostics.statusCode === 200);
check('диагностика содержит нотификатор', typeof diagnostics.json<{ notifier: unknown }>().notifier === 'object');

const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: root.auth });
check('аудит пишется', audit.json<{ items: unknown[] }>().items.length > 0);
check('аудит содержит рассылку', adminAuditStore.list().some((entry) => entry.action === 'broadcast_all'));

// ── Активность ────────────────────────────────────────────────────────────────
console.log('— Фоновая активность —');

check('админка не считается активностью', isBackgroundRequest('/api/admin/stats'));
check('прогресс задач не считается активностью', isBackgroundRequest('/api/admin/jobs/abc'));
check('опрос уведомлений не считается активностью', isBackgroundRequest('/api/notifications/next'));
check('счётчик уведомлений не считается активностью', isBackgroundRequest('/api/notifications/unread-count'));
check('синхронизация push не считается активностью', isBackgroundRequest('/api/push/subscribe'));
check('bootstrap — это заход', !isBackgroundRequest('/api/bootstrap'));
check('оценки — это активность', !isBackgroundRequest('/api/bars/grades'));

{
  const before = getStats().window;
  recordActivity('stats-test-user', '/api/admin/stats');
  recordActivity('stats-test-user', '/api/notifications/next');
  recordActivity('stats-test-user', '/api/push/subscribe');
  const after = getStats().window;

  check('фоновые запросы не увеличили «Запросы»', after.requests === before.requests);
  check('фоновые запросы не увеличили «Заходы»', after.visits === before.visits);

  recordActivity('stats-test-user', '/api/bootstrap');
  const withBootstrap = getStats().window;
  check('bootstrap увеличил запросы', withBootstrap.requests === before.requests + 1);
  check('bootstrap увеличил заходы', withBootstrap.visits === before.visits + 1);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалов: ${failures}\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);
