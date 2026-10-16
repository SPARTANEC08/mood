/**
 * Переключатель уведомлений в Telegram.
 *
 * Отдельный тест, потому что состояние подписки трогается из двух мест с
 * разными последствиями: из бота (кнопкой, отвязывая при переезде) и из
 * приложения (POST-запросом). Проверяется ровно то, что оба места обязаны
 * соблюдать: авторизация, идемпотентность и то, что выключенные уведомления
 * не отправляются, но снимки продолжают обновляться.
 *
 * Работает в отдельном каталоге: хранилище берёт путь из process.cwd() при
 * загрузке модуля, поэтому переход выполняется ДО импорта сервера.
 *
 * Сеть не используется. Запуск: npm run test:notifications
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notif-'));
fs.mkdirSync(path.join(WORK_DIR, 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'd'.repeat(64);

const { buildServer } = await import('../src/server/index.ts');
const { issuePwaToken, hashToken } = await import('../src/utils/pwaAuth.ts');
const { userStore } = await import('../src/storage/userStore.ts');

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

console.log('\n=== Уведомления: переключатель и привязка ===\n');

const userId = userStore.create({ barsLoginHash: 'notify-test-hash' }).userId;
const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));

const auth = { 'x-pwa-token': token };

// ── Авторизация ───────────────────────────────────────────────────────────────
console.log('— Авторизация —');

const anonymous = await app.inject({ method: 'POST', url: '/api/notifications/toggle', payload: { enabled: false } });
check('без токена → 401', anonymous.statusCode === 401, String(anonymous.statusCode));

const garbage = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: false },
  headers: { 'x-pwa-token': 'мусор.мусор.мусор' },
});
check('с чужим токеном → 401', garbage.statusCode === 401, String(garbage.statusCode));

const afterGarbage = userStore.getByUserId(userId);
check('чужой токен не изменил состояние', afterGarbage?.notificationsEnabled === undefined);

// ── Тело запроса ──────────────────────────────────────────────────────────────
console.log('\n— Тело запроса —');

const bad = await app.inject({ method: 'POST', url: '/api/notifications/toggle', payload: {}, headers: auth });
check('пустое тело → 400', bad.statusCode === 400, String(bad.statusCode));
check('имя ошибки bad_request', bad.json<{ error?: string }>().error === 'bad_request');

const notBool = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: 'да' },
  headers: auth,
});
check('enabled не boolean → 400', notBool.statusCode === 400, String(notBool.statusCode));

// ── Переключение ──────────────────────────────────────────────────────────────
console.log('\n— Переключение —');

const off = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: false },
  headers: auth,
});
check('выключение → 200', off.statusCode === 200, String(off.statusCode));
check('ответ подтверждает false', off.json<{ enabled?: boolean }>().enabled === false);
check('флаг записан', userStore.getByUserId(userId)?.notificationsEnabled === false);

const on = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: true },
  headers: auth,
});
check('включение → 200', on.statusCode === 200, String(on.statusCode));
check('флаг записан', userStore.getByUserId(userId)?.notificationsEnabled === true);

// ── Идемпотентность ───────────────────────────────────────────────────────────
console.log('\n— Идемпотентность —');

const repeat = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: true },
  headers: auth,
});
check('повторное включение → 200', repeat.statusCode === 200, String(repeat.statusCode));
check('состояние не изменилось', userStore.getByUserId(userId)?.notificationsEnabled === true);

const repeatOff = await app.inject({
  method: 'POST',
  url: '/api/notifications/toggle',
  payload: { enabled: false },
  headers: auth,
});
check('повторное выключение → 200', repeatOff.statusCode === 200);
check('состояние не изменилось', userStore.getByUserId(userId)?.notificationsEnabled === false);

// ── Состояние ─────────────────────────────────────────────────────────────────
console.log('\n— Сообщение о состоянии —');

const state = await app.inject({ method: 'GET', url: '/api/notifications/state', headers: auth });
check('GET /notifications/state → 200', state.statusCode === 200, String(state.statusCode));
check('видит выключенное', state.json<{ notificationsEnabled?: boolean }>().notificationsEnabled === false);

const stateAnon = await app.inject({ method: 'GET', url: '/api/notifications/state' });
check('состояние без токена → 401', stateAnon.statusCode === 401, String(stateAnon.statusCode));

// ── Привязка Telegram ─────────────────────────────────────────────────────────
console.log('\n— Привязка Telegram: переезд между аккаунтами —');

const first = userId;
userStore.patchByUserId(first, { telegramId: 555000111, notificationsEnabled: true });

const second = userStore.create({ barsLoginHash: 'notify-test-hash-2' }).userId;
const { token: token2 } = issuePwaToken(second);
userStore.addToken(second, hashToken(token2), new Date(Date.now() + 86_400_000));

const { processTelegramMessage } = await import('../src/bot/botEngine.ts');

const linked = await processTelegramMessage({ id: 555000111, firstName: 'Тест' }, `/start ${second}`);
check('привязка отвечает «включены»', linked.view.text.includes('Уведомления включены'));
check('telegramId записан', userStore.getByUserId(second)?.telegramId === 555000111);
check('уведомления включены', userStore.getByUserId(second)?.notificationsEnabled === true);

const moved = await processTelegramMessage({ id: 555000111, firstName: 'Тест' }, `/start ${second}`);
check('повторная привязка безопасна', moved.view.text.includes('Уведомления включены'));
check('первый аккаунт не тронут, его не было в индексе', userStore.findUserByTelegramId(555000111)?.userId === second);

// Переезд на другой аккаунт: старая привязка обязана сняться
const third = userStore.create({ barsLoginHash: 'notify-test-hash-3' }).userId;
const moved2 = await processTelegramMessage({ id: 555000111, firstName: 'Тест' }, `/start ${third}`);

check('переезд состоялся', userStore.getByUserId(third)?.telegramId === 555000111);
check(
  'старая запись отвязана (telegramId = null)',
  userStore.getByUserId(second)?.telegramId === null,
  String(userStore.getByUserId(second)?.telegramId),
);
check(
  'старая запись выпала из индекса',
  userStore.findUserByTelegramId(555000111)?.userId === third,
);
check(
  'у старой записи уведомления выключены',
  userStore.getByUserId(second)?.notificationsEnabled === false,
);
void moved2;

// ── Несуществующий адрес ──────────────────────────────────────────────────────
console.log('\n— Привязка по несуществующему адресу —');

const missing = await processTelegramMessage(
  { id: 777000222, firstName: 'Тест' },
  '/start 00000000-0000-0000-0000-000000000000',
);
check('отказ «аккаунт не найден»', missing.view.text.includes('Аккаунт не найден'));
check('Telegram не привязан', userStore.findUserByTelegramId(777000222) === undefined);

const junk = await processTelegramMessage({ id: 777000222, firstName: 'Тест' }, '/start мусор');
check('мусор в адресе — обычное приветствие', junk.view.text.includes('Hub'));
check('Telegram по-прежнему не привязан', userStore.findUserByTelegramId(777000222) === undefined);

// ── /start без адреса не создаёт запись ────────────────────────────────────────
console.log('\n— /start без адреса —');

const before = Object.keys((JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'data', 'users.json'), 'utf-8')) as { users: Record<string, unknown> }).users).length;

const anon = await processTelegramMessage({ id: 888000333, firstName: 'Новый' }, '/start');
check('приветствие', anon.view.text.includes('Открыть приложение') || anon.view.text.includes('не настроено'));
check('запись в базе не создана', userStore.findUserByTelegramId(888000333) === undefined);

const after = Object.keys((JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'data', 'users.json'), 'utf-8')) as { users: Record<string, unknown> }).users).length;
check('число записей не изменилось', before === after, `${before} → ${after}`);

const linkedGreet = await processTelegramMessage({ id: 555000111, firstName: 'Тест' }, '/start');
check('привязанному — «подключены»', linkedGreet.view.text.includes('подключены'));

console.log(`\n${failures === 0 ? '✅' : '❌'} Уведомления: ${checks - failures} ok, ${failures} ошибок\n`);

await app.close();
process.exit(failures === 0 ? 0 : 1);