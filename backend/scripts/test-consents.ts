/**
 * Проверка механики согласий на живом Fastify.
 *
 * Работает в отдельном временном каталоге: рабочая база с настоящими кредами
 * не читается и не пишется. Сеть не используется — проверяются только
 * маршруты, которые не ходят в БАРС.
 *
 * Запуск: npm run test:consents
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-consents-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'e'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'f'.repeat(64);

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { consentStore } = await import('../../db/storage/consentStore.ts');
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

function makeUser(login: string, patch: Record<string, unknown> = {}): { userId: string; token: string } {
  const created = userStore.create({ barsLoginHash: computeBarsLoginHash(login) });
  const user = userStore.patch(created.userId, patch) ?? created;
  const { token } = issuePwaToken(user.userId);
  userStore.addToken(user.userId, hashToken(token), new Date(Date.now() + 86_400_000));
  return { userId: user.userId, token };
}

console.log('\n=== Согласия: документы, гейт и приём ===\n');

const CORE = ['processing', 'dissemination', 'terms', 'age'];

// ── документы доступны до входа ──────────────────────────────────────────────
{
  const response = await app.inject({ method: 'GET', url: '/api/legal/documents' });
  const body = response.json<{
    documents?: Array<{ id: string; version: string }>;
    required?: string[];
  }>();

  check('GET /api/legal/documents без токена → 200', response.statusCode === 200);
  check(
    'в списке 6 документов',
    Array.isArray(body.documents) && body.documents.length === 6,
    String(body.documents?.length),
  );
  check(
    'обязательные: processing, dissemination, terms, age',
    JSON.stringify(body.required) === JSON.stringify(CORE),
    JSON.stringify(body.required),
  );
}

// ── новый пользователь без согласий ──────────────────────────────────────────
const plain = makeUser('consent-plain');

{
  const status = await app.inject({
    method: 'GET',
    url: '/api/legal/status',
    headers: auth(plain.token),
  });
  const body = status.json<{ consentRequired?: boolean; missing?: string[] }>();

  check('GET /api/legal/status → 200', status.statusCode === 200);
  check('без согласий consentRequired=true', body.consentRequired === true);
  check(
    'missing содержит четыре обязательных документа',
    Array.isArray(body.missing) && CORE.every((id) => body.missing?.includes(id)),
    JSON.stringify(body.missing),
  );

  const bootstrap = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: auth(plain.token),
  });
  const boot = bootstrap.json<{ legal?: { consentRequired?: boolean } }>();
  check('bootstrap отдаёт legal.consentRequired', boot.legal?.consentRequired === true);

  const grades = await app.inject({
    method: 'GET',
    url: '/api/bars/grades',
    headers: auth(plain.token),
  });
  check('защищённый маршрут без согласий → 403', grades.statusCode === 403, String(grades.statusCode));
  check(
    'машинное имя consent_required',
    grades.json<{ error?: string }>().error === 'consent_required',
  );
}

// ── приём согласий ───────────────────────────────────────────────────────────
{
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/consents',
    headers: auth(plain.token),
    payload: { types: CORE },
  });
  const body = accepted.json<{ consentRequired?: boolean; accepted?: unknown[] }>();

  check('POST /api/consents → 200', accepted.statusCode === 200);
  check('после приёма consentRequired=false', body.consentRequired === false);
  check('в журнале четыре записи', consentStore.listForUser(plain.userId).length === 4);

  const again = await app.inject({
    method: 'GET',
    url: '/api/legal/status',
    headers: auth(plain.token),
  });
  check(
    'повторный status: согласия действуют',
    again.json<{ consentRequired?: boolean }>().consentRequired === false,
  );
}

// ── push: документ 03 нужен только при наличии подписки ──────────────────────
{
  const pushUser = makeUser('consent-push', {
    pushSubscriptions: [{ endpoint: 'https://push.example', keys: { p256dh: 'a', auth: 'b' } }],
  });

  const status = await app.inject({
    method: 'GET',
    url: '/api/legal/status',
    headers: auth(pushUser.token),
  });
  check(
    'с push-подпиской требуется документ push',
    status.json<{ missing?: string[] }>().missing?.includes('push') === true,
  );

  const subscribe = await app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    headers: auth(pushUser.token),
    payload: { endpoint: 'https://push.example/2', keys: { p256dh: 'a', auth: 'b' } },
  });
  check('подписка без согласия push → 403', subscribe.statusCode === 403, String(subscribe.statusCode));
}

// ── гость: документ guest обязателен ─────────────────────────────────────────
{
  const guest = makeUser('consent-guest', { isGuest: true, groupName: 'Тест', groupId: 1 });

  const status = await app.inject({
    method: 'GET',
    url: '/api/legal/status',
    headers: auth(guest.token),
  });
  check(
    'гостю требуется документ guest',
    status.json<{ missing?: string[] }>().missing?.includes('guest') === true,
  );
}

// ── вход без согласий не доходит до БАРС ─────────────────────────────────────
{
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'no-consent-login', password: 'whatever' },
  });

  check('вход без согласий → 400', response.statusCode === 400, String(response.statusCode));
  check(
    'код consent_required',
    response.json<{ error?: string }>().error === 'consent_required',
  );
}

// ── уборка ───────────────────────────────────────────────────────────────────
userStore.remove(plain.userId);

await app.close();

console.log('\n====================================================');
console.log(`ИТОГО: ${failures === 0 ? '✅' : '❌'} ${checks - failures} / ${checks}`);
console.log('====================================================\n');

process.exit(failures === 0 ? 0 : 1);
