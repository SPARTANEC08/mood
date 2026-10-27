/**
 * Web Push: подписки, payload и снимок при двух каналах.
 *
 * Сеть не используется: web-push не вызывается, отправка проверяется на чистой
 * логике (payload, мёртвые подписки, решение о сдвиге снимка). Маршруты
 * проверяются через inject, как в соседних тестах.
 *
 * Запуск: npm run test:push
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-push-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'e'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'f'.repeat(64);
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { buildPushPayload, pushUrlFor, isDeadSubscription } = await import(
  '../services/notifications/webPush.ts'
);
const { snapshotAfterDelivery } = await import(
  '../services/notifications/notifier/run.ts'
);
const { isBaselineSnapshot } = await import('../../db/storage/snapshotStore.ts');

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

function subscription(index: number, keys = { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) }) {
  return { endpoint: `https://push.example.com/sub/${index}`, keys };
}

console.log('\n=== Web Push: подписки и payload ===\n');

const userId = userStore.create({ barsLoginHash: 'push-test-hash' }).userId;
const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));
const auth = { 'x-pwa-token': token };

// ── Авторизация ───────────────────────────────────────────────────────────────
console.log('— Авторизация —');

const anonymous = await app.inject({ method: 'GET', url: '/api/push/key' });
check('ключ без токена → 401', anonymous.statusCode === 401, String(anonymous.statusCode));

const anonymousSubscribe = await app.inject({
  method: 'POST',
  url: '/api/push/subscribe',
  payload: subscription(1),
});
check('подписка без токена → 401', anonymousSubscribe.statusCode === 401, String(anonymousSubscribe.statusCode));

// ── Ключ ──────────────────────────────────────────────────────────────────────
console.log('— VAPID —');

const key = await app.inject({ method: 'GET', url: '/api/push/key', headers: auth });
check('ключ отдаётся', key.statusCode === 200, String(key.statusCode));
check('без ключей на сервере — пустая строка', key.json<{ publicKey: string }>().publicKey === '');

// ── Подписка ──────────────────────────────────────────────────────────────────
console.log('— Подписка —');

const invalid = await app.inject({
  method: 'POST',
  url: '/api/push/subscribe',
  headers: auth,
  payload: { endpoint: 'not-a-url', keys: {} },
});
check('мусор → 400', invalid.statusCode === 400, String(invalid.statusCode));

const insecure = await app.inject({
  method: 'POST',
  url: '/api/push/subscribe',
  headers: auth,
  payload: { ...subscription(2), endpoint: 'http://push.example.com/sub/2' },
});
check('http endpoint → 400', insecure.statusCode === 400, String(insecure.statusCode));

const first = await app.inject({
  method: 'POST',
  url: '/api/push/subscribe',
  headers: auth,
  payload: subscription(1),
});
check('подписка сохранена', first.statusCode === 200, String(first.statusCode));
check('одно устройство', first.json<{ devices: number }>().devices === 1);

const repeat = await app.inject({
  method: 'POST',
  url: '/api/push/subscribe',
  headers: auth,
  payload: subscription(1, { p256dh: 'q'.repeat(40), auth: 'b'.repeat(16) }),
});
check('повтор с тем же endpoint не плодит запись', repeat.json<{ devices: number }>().devices === 1);

const stored = userStore.getByUserId(userId);
check('ключи обновились', stored?.pushSubscriptions?.[0]?.keys.p256dh === 'q'.repeat(40));
check('createdAt сохранился', typeof stored?.pushSubscriptions?.[0]?.createdAt === 'string');

for (let index = 2; index <= 12; index += 1) {
  await app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    headers: auth,
    payload: subscription(index),
  });
}

const capped = userStore.getByUserId(userId);
check('не больше 10 устройств', capped?.pushSubscriptions?.length === 10, String(capped?.pushSubscriptions?.length));

const state = await app.inject({ method: 'GET', url: '/api/push/state', headers: auth });
check('state: push включён', state.json<{ pushEnabled: boolean }>().pushEnabled === true);
check('state: 10 устройств', state.json<{ devices: number }>().devices === 10);

// ── Отписка ───────────────────────────────────────────────────────────────────
console.log('— Отписка —');

const removed = await app.inject({
  method: 'POST',
  url: '/api/push/unsubscribe',
  headers: auth,
  payload: { endpoint: subscription(12).endpoint },
});
check('устройство удалено', removed.json<{ devices: number }>().devices === 9);

const empty = await app.inject({
  method: 'POST',
  url: '/api/push/unsubscribe',
  headers: auth,
  payload: {},
});
check('пустой endpoint → 400', empty.statusCode === 400, String(empty.statusCode));

// ── Флаги каналов ─────────────────────────────────────────────────────────────
console.log('— Каналы —');

const off = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  headers: auth,
  payload: { channel: 'push', enabled: false },
});
check('push выключен', off.json<{ pushEnabled: boolean }>().pushEnabled === false);

// ── Payload ───────────────────────────────────────────────────────────────────
console.log('— Payload —');

const payload = JSON.parse(buildPushPayload({ kind: 'grade', label: 'Новые оценки' })) as Record<string, unknown>;
check('body — общий текст', payload.body === 'Новые оценки');
check('kind передаётся', payload.kind === 'grade');
check('ссылка на успеваемость', payload.url === '/?tab=grades');
check('деталей нет', !('details' in payload) && !('title' in payload && String(payload.title).includes('Оценка')));
check('письмо ведёт в кабинет', pushUrlFor('mail') === '/?tab=profile');
check('приказ ведёт в кабинет', pushUrlFor('order') === '/?tab=profile');
check('стипендия ведёт в кабинет', pushUrlFor('scholarship') === '/?tab=profile');

// ── Мёртвые подписки ──────────────────────────────────────────────────────────
console.log('— Ошибки push-сервиса —');

check('410 — подписка мертва', isDeadSubscription(410));
check('404 — подписка мертва', isDeadSubscription(404));
check('500 — не мертва', !isDeadSubscription(500));
check('без кода — не мертва', !isDeadSubscription(undefined));

// ── Снимок при двух каналах ───────────────────────────────────────────────────
console.log('— Снимок —');

const prev = { gradesHash: {}, lastSeenMailUid: 1, ordersCount: 0, scholarshipStatus: 'нет', lastCheckedAt: '2026-01-01T00:00:00.000Z' };
const next = { ...prev, lastCheckedAt: '2026-01-02T00:00:00.000Z' };

check('push не нужен → снимок новый', snapshotAfterDelivery(prev, next, false, false) === next);
check('push упал → снимок прежний', snapshotAfterDelivery(prev, next, true, false) === prev);
check('push дошёл → снимок новый', snapshotAfterDelivery(prev, next, true, true) === next);
check('нет предыдущего снимка → новый', snapshotAfterDelivery(undefined, next, true, false) === next);
check('базовый снимок не двигается', isBaselineSnapshot(undefined));

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалов: ${failures}\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);
