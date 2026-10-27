/**
 * Переключатель push-уведомлений.
 *
 * Telegram-канал удалён: проверяется только флаг pushEnabled и число устройств.
 * Сеть не используется.
 *
 * Запуск: npm run test:notifications
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-push-toggle-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'd'.repeat(64);

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { userStore } = await import('../../db/storage/userStore.ts');

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

console.log('\n=== Push: переключатель ===\n');

const userId = userStore.create({ barsLoginHash: 'push-toggle-hash' }).userId;
const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));
const auth = { 'x-pwa-token': token };

const anonymous = await app.inject({ method: 'POST', url: '/api/notifications/toggle', payload: { enabled: false } });
check('без токена → 401', anonymous.statusCode === 401, String(anonymous.statusCode));

const garbage = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: false },
  headers: { 'x-pwa-token': 'мусор.мусор.мусор' },
});
check('с чужим токеном → 401', garbage.statusCode === 401, String(garbage.statusCode));
check('чужой токен не изменил флаг', userStore.getByUserId(userId)?.pushEnabled === undefined);

const bad = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  headers: auth,
  payload: { enabled: 'да' },
});
check('невалидное тело → 400', bad.statusCode === 400, String(bad.statusCode));

const off = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  headers: auth,
  payload: { enabled: false },
});
check('push выключен', off.json<{ pushEnabled: boolean }>().pushEnabled === false);
check('флаг записан', userStore.getByUserId(userId)?.pushEnabled === false);

userStore.patchByUserId(userId, {
  pushSubscriptions: [
    {
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) },
      createdAt: new Date().toISOString(),
    },
  ],
});

const on = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  headers: auth,
  payload: { enabled: true },
});
check('push включён', on.json<{ pushEnabled: boolean }>().pushEnabled === true);
check('одно устройство', on.json<{ pushDevices: number }>().pushDevices === 1);

const state = await app.inject({ method: 'GET', url: '/api/notifications/state', headers: auth });
check('state: push включён', state.json<{ pushEnabled: boolean }>().pushEnabled === true);
check('state: одно устройство', state.json<{ pushDevices: number }>().pushDevices === 1);
check('в state нет Telegram', !('telegramId' in state.json()));

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалов: ${failures}\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);
