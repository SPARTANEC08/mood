/**
 * Темы оформления: API, лимиты, приватность автора, админка и удаление аккаунта.
 *
 * Сеть не используется — Fastify поднимается через inject, база живёт во
 * временном каталоге. Проверяем именно серверную часть: клиентская математика
 * цвета покрыта `test:accent`.
 *
 * Запуск: npm run test:themes
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-themes-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'e'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'f'.repeat(64);
process.env.ADMIN_BARS_LOGINS = 'root-admin';

const { buildServer } = await import('../server/index.ts');
const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');
const { userStore } = await import('../../db/storage/userStore.ts');
const { themeStore } = await import('../../db/storage/themeStore.ts');
const { deleteAccount } = await import('../services/account/deleteAccount.ts');

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

function section(title: string): void {
  console.log(`\n▶ ${title}`);
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

function themeBody(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    variants: {
      dark: { backgroundHue: 20, surfaceHue: 20, accentHue: 35 },
      light: { backgroundHue: 20, surfaceHue: 20, accentHue: 35 },
    },
    ...overrides,
  };
}

themeStore.reset();

console.log('\n=== Темы оформления ===\n');

const author = createUser('theme-author');
const other = createUser('theme-other');
const admin = createUser('root-admin');
const guest = createUser('theme-guest', { isGuest: true });

section('Доступ');
{
  const noToken = await app.inject({ method: 'GET', url: '/api/themes' });
  check('GET без токена → 401', noToken.statusCode === 401, String(noToken.statusCode));

  const guestList = await app.inject({ method: 'GET', url: '/api/themes', headers: guest.auth });
  check('гость не видит темы → 403', guestList.statusCode === 403, String(guestList.statusCode));

  const guestCreate = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: guest.auth,
    payload: themeBody('Гостевая'),
  });
  check('гость не публикует → 403', guestCreate.statusCode === 403, String(guestCreate.statusCode));
}

section('Публикация');
let firstThemeId = '';
{
  const created = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('Закат'),
  });

  check('POST → 200', created.statusCode === 200, String(created.statusCode));
  const body = created.json<{ theme: Record<string, unknown> }>();
  firstThemeId = String(body.theme?.id ?? '');

  check('id с префиксом thm_', firstThemeId.startsWith('thm_'), firstThemeId);
  check('mine=true для автора', body.theme?.mine === true);
  check('имя сохранено', body.theme?.name === 'Закат', String(body.theme?.name));
  check('два варианта сохранены', Boolean((body.theme.variants as Record<string, unknown>)?.dark && (body.theme.variants as Record<string, unknown>)?.light));
  check('автор не утёк в ответ', !('authorUserId' in body.theme) && !('author_user_id' in body.theme));
  check('user_id не утёк в ответ', !JSON.stringify(body).includes(author.user.userId));

  const listForOther = await app.inject({ method: 'GET', url: '/api/themes', headers: other.auth });
  const items = listForOther.json<{ items: Array<Record<string, unknown>> }>().items;
  const found = items.find((item) => item.id === firstThemeId);
  check('другая учётка видит тему', Boolean(found));
  check('mine=false для другой учётки', found?.mine === false);
  check('список не содержит автора', !JSON.stringify(items).includes(author.user.userId));
}

section('Валидация');
{
  const emptyName = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('   '),
  });
  check('пустое имя → 400', emptyName.statusCode === 400, String(emptyName.statusCode));

  const longName = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('x'.repeat(25)),
  });
  check('имя длиннее 24 → 400', longName.statusCode === 400, String(longName.statusCode));

  const noVariants = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: { name: 'Пустая', variants: {} },
  });
  check('ноль вариантов → 400', noVariants.statusCode === 400, String(noVariants.statusCode));

  for (const [label, variant] of [
    ['hue 360', { backgroundHue: 360, surfaceHue: 20, accentHue: 35 }],
    ['hue −1', { backgroundHue: -1, surfaceHue: 20, accentHue: 35 }],
    ['hue 1.5', { backgroundHue: 1.5, surfaceHue: 20, accentHue: 35 }],
    ['hue строкой', { backgroundHue: '20', surfaceHue: 20, accentHue: 35 }],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/themes',
      headers: author.auth,
      payload: { name: 'Плохая', variants: { dark: variant } },
    });
    check(`${label} → 400`, response.statusCode === 400, String(response.statusCode));
  }

  const control = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('Закат\nс переносом'),
  });
  check('перенос строки схлопывается', control.statusCode === 200, String(control.statusCode));
  check(
    'имя без переноса',
    control.json<{ theme: { name: string } }>().theme.name === 'Закат с переносом',
    control.json<{ theme: { name: string } }>().theme.name,
  );
}

section('Лимит публикаций');
{
  // У автора уже две темы: «Закат» и «Закат с переносом». Третья — граница.
  const third = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('Третья'),
  });
  check('третья тема проходит', third.statusCode === 200, String(third.statusCode));

  const fourth = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: author.auth,
    payload: themeBody('Четвёртая'),
  });
  check('четвёртая за сутки → 429', fourth.statusCode === 429, String(fourth.statusCode));
  const body = fourth.json<{ error?: string; retryAfterMs?: number }>();
  check('код theme_limit', body.error === 'theme_limit', String(body.error));
  check('retryAfterMs положительный', typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0);
}

section('Удаление своей темы');
{
  const foreign = await app.inject({
    method: 'DELETE',
    url: `/api/themes/${firstThemeId}`,
    headers: other.auth,
  });
  check('чужая тема → 403', foreign.statusCode === 403, String(foreign.statusCode));

  const own = await app.inject({
    method: 'DELETE',
    url: `/api/themes/${firstThemeId}`,
    headers: author.auth,
  });
  check('своя тема → 200', own.statusCode === 200, String(own.statusCode));

  const list = await app.inject({ method: 'GET', url: '/api/themes', headers: other.auth });
  const items = list.json<{ items: Array<{ id: string }> }>().items;
  check('удалённая тема исчезла', !items.some((item) => item.id === firstThemeId));

  const again = await app.inject({
    method: 'DELETE',
    url: `/api/themes/${firstThemeId}`,
    headers: author.auth,
  });
  check('повторное удаление → 404', again.statusCode === 404, String(again.statusCode));
}

section('Админка');
{
  const created = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: other.auth,
    payload: themeBody('Админская проверка'),
  });
  const id = created.json<{ theme: { id: string } }>().theme.id;

  const denied = await app.inject({ method: 'GET', url: '/api/admin/themes', headers: author.auth });
  check('обычный пользователь → 403', denied.statusCode === 403, String(denied.statusCode));

  const adminList = await app.inject({ method: 'GET', url: '/api/admin/themes', headers: admin.auth });
  check('админ видит список', adminList.statusCode === 200, String(adminList.statusCode));
  const adminItems = adminList.json<{ items: Array<Record<string, unknown>> }>().items;
  check('в админке есть тема', adminItems.some((item) => item.id === id));
  check('в админке нет автора', !JSON.stringify(adminItems).includes(other.user.userId));

  const hidden = await app.inject({
    method: 'POST',
    url: `/api/admin/themes/${id}/hide`,
    headers: admin.auth,
  });
  check('скрытие → 200', hidden.statusCode === 200, String(hidden.statusCode));

  const publicAfterHide = await app.inject({ method: 'GET', url: '/api/themes', headers: author.auth });
  const publicItems = publicAfterHide.json<{ items: Array<{ id: string }> }>().items;
  check('скрытая тема не в публичном списке', !publicItems.some((item) => item.id === id));

  const unhidden = await app.inject({
    method: 'POST',
    url: `/api/admin/themes/${id}/unhide`,
    headers: admin.auth,
  });
  check('возврат → 200', unhidden.statusCode === 200, String(unhidden.statusCode));

  const publicAfterUnhide = await app.inject({ method: 'GET', url: '/api/themes', headers: author.auth });
  check(
    'возвращённая тема снова видна',
    publicAfterUnhide.json<{ items: Array<{ id: string }> }>().items.some((item) => item.id === id),
  );

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/admin/themes/${id}`,
    headers: admin.auth,
  });
  check('удаление админом → 200', deleted.statusCode === 200, String(deleted.statusCode));

  const publicAfterDelete = await app.inject({ method: 'GET', url: '/api/themes', headers: author.auth });
  check(
    'удалённая админом тема исчезла',
    !publicAfterDelete.json<{ items: Array<{ id: string }> }>().items.some((item) => item.id === id),
  );
}

section('Удаление аккаунта');
{
  const doomed = createUser('theme-doomed');
  const created = await app.inject({
    method: 'POST',
    url: '/api/themes',
    headers: doomed.auth,
    payload: themeBody('Исчезнет с аккаунтом'),
  });
  const id = created.json<{ theme: { id: string } }>().theme.id;
  check('тема создана', Boolean(id));

  await deleteAccount(doomed.user);

  const list = await app.inject({ method: 'GET', url: '/api/themes', headers: author.auth });
  check(
    'тема удалённого аккаунта исчезла',
    !list.json<{ items: Array<{ id: string }> }>().items.some((item) => item.id === id),
  );
}

await app.close();

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failures === 0 ? '✅' : '❌'} ${checks - failures} ok, ${failures} ошибок`);
console.log('='.repeat(52));

process.exit(failures === 0 ? 0 : 1);
