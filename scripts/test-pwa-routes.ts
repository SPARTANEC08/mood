/**
 * Проверка живого API: маршруты, хук авторизации и отзыв токена.
 *
 * Отличается от test-pwa-auth.ts тем, что поднимает настоящий Fastify и ходит
 * в него по HTTP. Криптографию проверяет юнит-тест, а здесь важно другое —
 * что маршруты, хук onRequest, отзыв токена и CORS действительно соединены
 * правильно.
 *
 * Тест работает в отдельном каталоге: он создаёт временный data/ и переходит
 * в него ДО импорта модулей, потому что хранилище берёт путь из process.cwd().
 * Рабочая база не читается и не пишется — в ней настоящие креды студентов.
 *
 * Сеть не используется: успешный ответ BarsClient для проверки входа
 * подменяется в тесте. Проверяется, в частности, что Telegram-привязка не
 * блокирует PWA-вход.
 *
 * Запуск: npm run test:pwa-routes
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Каталог выбирается до импорта сервера: хранилище читает process.cwd() в
// момент загрузки модуля jsonStore, а не при первом обращении к данным.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pwa-routes-'));
fs.mkdirSync(path.join(WORK_DIR, 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'c'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'd'.repeat(64);

const { buildServer } = await import('../src/server/index.ts');
const { issuePwaToken, hashToken } = await import('../src/utils/pwaAuth.ts');
const { userStore } = await import('../src/storage/userStore.ts');
const { computeBarsLoginHash } = await import('../src/utils/barsLoginHash.ts');
const { BarsClient } = await import('../src/services/bars/barsClient.ts');

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

/** Заголовок авторизации с выданным токеном. */
function auth(token: string): Record<string, string> {
  return { 'x-pwa-token': token };
}

console.log('\n=== PWA API: маршруты и авторизация ===\n');

// ── тестовый пользователь ─────────────────────────────────────────────────────
// userId выдаётся хранилищем, токен — вручную: его хэш кладётся в запись, и
// только после этого хук пропускает запрос.
const created = userStore.create({ barsLoginHash: computeBarsLoginHash('st000001') });
const userId = created.userId;

const { token } = issuePwaToken(userId);
userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));

console.log('— Служебный маршрут —');
{
  const response = await app.inject({ method: 'GET', url: '/health' });
  check('GET /health без токена → 200', response.statusCode === 200, String(response.statusCode));
  check('health отвечает статусом ok', response.json<{ status?: string }>().status === 'ok');
}

console.log('\n— Отказ без авторизации —');
{
  const anonymous = await app.inject({ method: 'GET', url: '/api/bootstrap' });
  check('GET /api/bootstrap без токена → 401', anonymous.statusCode === 401, String(anonymous.statusCode));
  check(
    'машинное имя ошибки unauthorized',
    anonymous.json<{ error?: string }>().error === 'unauthorized',
  );

  const garbage = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: auth('мусор.мусор.мусор'),
  });
  check('мусор в заголовке → 401', garbage.statusCode === 401, String(garbage.statusCode));

  const unknown = await app.inject({ method: 'GET', url: '/api/несуществующий' });
  check(
    'несуществующий /api-маршрут тоже защищён хуком',
    unknown.statusCode === 401,
    String(unknown.statusCode),
  );
}

console.log('\n— Подпись есть, но токен не выдан пользователю —');
{
  // Ключевая проверка: одной подлинной подписи мало. Без записи хэша в
  // pwaTokens выпущенный где-то токен с любым userId работал бы 90 дней.
  const rogue = issuePwaToken(userId);
  const response = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: auth(rogue.token),
  });

  check('токен без записи в pwaTokens → 401', response.statusCode === 401, String(response.statusCode));
  check(
    'причина отказа — токен не числится за устройством',
    response.json<{ message?: string }>().message?.includes('устройстве') === true,
    JSON.stringify(response.json()),
  );

  const stranger = issuePwaToken('11111111-2222-4333-8444-555555555555');
  const strangerResponse = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: auth(stranger.token),
  });
  check('токен несуществующего пользователя → 401', strangerResponse.statusCode === 401);
}

console.log('\n— Доступ с токеном —');
{
  const good = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: auth(token),
  });
  check('валидный токен → 200', good.statusCode === 200, String(good.statusCode));
  check(
    'в bootstrap приходит тот же userId',
    good.json<{ profile?: { userId?: string } }>().profile?.userId === userId,
  );
  check(
    'персональный API-ответ варьируется по PWA-токену для SW/HTTP-кэша',
    String(good.headers.vary ?? '').toLowerCase().includes('x-pwa-token'),
    String(good.headers.vary),
  );

  const bearer = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: { 'x-pwa-token': `Bearer ${token}` },
  });
  check('префикс Bearer отбрасывается', bearer.statusCode === 200, String(bearer.statusCode));

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
  check('GET /api/auth/me → 200', me.statusCode === 200, String(me.statusCode));
  check('профиль содержит userId', me.json<{ userId?: string }>().userId === userId);
}

console.log('\n— Открытые маршруты входа —');
{
  // Вход и регистрация обязаны быть доступны без токена, иначе войти нельзя.
  // Пустое тело отсекается валидацией ДО похода в БАРС, поэтому сеть не нужна.
  for (const route of ['/api/auth/login', '/api/auth/register']) {
    const response = await app.inject({ method: 'POST', url: route, payload: {} });
    check(
      `POST ${route} без токена → 400, а не 401`,
      response.statusCode === 400,
      String(response.statusCode),
    );
    check(
      `POST ${route}: имя ошибки bad_request`,
      response.json<{ error?: string }>().error === 'bad_request',
    );
    check(
      `POST ${route}: токеновый ответ не кэшируется`,
      String(response.headers['cache-control'] ?? '').includes('no-store'),
    );
  }

  const twoFactor = await app.inject({ method: 'POST', url: '/api/auth/2fa', payload: {} });
  check('POST /api/auth/2fa без токена → 400', twoFactor.statusCode === 400, String(twoFactor.statusCode));

  // Неизвестный challengeId: попытка входа не найдена, сеть не задействована.
  const stale = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa',
    payload: { challengeId: 'несуществующий', code: '123456' },
  });
  check('несуществующий challengeId → 401 invalid_credentials', stale.statusCode === 401, String(stale.statusCode));
  check(
    'имя ошибки invalid_credentials',
    stale.json<{ error?: string }>().error === 'invalid_credentials',
    JSON.stringify(stale.json()),
  );
}

console.log('\n— Вход в аккаунт, привязанный к Telegram —');
{
  const linked = userStore.create({
    barsLoginHash: computeBarsLoginHash('linked-student'),
    telegramId: 777000222,
  });
  const originalLogin = BarsClient.prototype.login;

  BarsClient.prototype.login = async () => ({
    success: true,
    studentInfo: { studentName: 'Тестовый Студент', groupName: '' },
    finalUrl: '/bars_web/ST_Study/Main/Main',
    sessionData: {
      finalUrl: '/bars_web/ST_Study/Main/Main',
      cookies: null,
      savedAt: new Date().toISOString(),
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'linked-student', password: 'test-password' },
    });
    const body = response.json<{ userId?: string; token?: string }>();

    check('привязка Telegram не блокирует вход в PWA → 200', response.statusCode === 200, String(response.statusCode));
    check('PWA получает тот же userId', body.userId === linked.userId);
    check('Telegram-привязка сохраняется', userStore.getByUserId(linked.userId)?.telegramId === 777000222);
  } finally {
    BarsClient.prototype.login = originalLogin;
  }
}

console.log('\n— Требование входа в БАРС —');
{
  // Пользователь есть, сессия есть, а кредов БАРС нет: разделы БАРС и почта
  // обязаны сказать об этом отдельной ошибкой, а не падать в 500.
  const response = await app.inject({ method: 'GET', url: '/api/bars/grades', headers: auth(token) });
  check('GET /api/bars/grades без входа в БАРС → 401', response.statusCode === 401, String(response.statusCode));
  check(
    'имя ошибки bars_login_required',
    response.json<{ error?: string }>().error === 'bars_login_required',
    JSON.stringify(response.json()),
  );
  check(
    'клиенту сказано, что нужно войти',
    response.json<{ needBarsLogin?: boolean }>().needBarsLogin === true,
  );

  // Файлы — исключение из правила «раздел БАРС требует входа в БАРС».
  //
  // Файл лежит в data/files/<userId>/ и адресуется по userId из токена, поэтому
  // сессия БАРС для его чтения не нужна. С requireBars фотографии вложений
  // переставали грузиться целиком, как только сессия истекала, — при том что
  // сами файлы оставались на месте и были доступны.
  //
  // Проверяется не «200», а «не 401»: токен рабочий, а файла с таким id нет,
  // поэтому ответ — 404 из поиска по каталогу. Именно 404 доказывает, что
  // авторизация прошла и запрос дошёл до поиска файла.
  const files = await app.inject({ method: 'GET', url: '/api/files/любой', headers: auth(token) });
  check(
    'GET /api/files/:fileId без входа в БАРС проходит авторизацию (404, не 401)',
    files.statusCode === 404 && files.json<{ error?: string }>().error === 'not_found',
    `${files.statusCode} ${files.json<{ error?: string }>().error ?? ''}`,
  );

  const filesMeta = await app.inject({
    method: 'GET',
    url: '/api/files/любой/meta',
    headers: auth(token),
  });
  check(
    'GET /api/files/:fileId/meta без входа в БАРС → 404, не 401',
    filesMeta.statusCode === 404,
    String(filesMeta.statusCode),
  );
}

console.log('\n— Изоляция групп: чужой id в PATCH/DELETE —');
{
  // Роут-уровень, а не только хранилище: проверяется явная проверка прав в
  // обработчиках. Чужой id обязан дать 404, а запись — остаться нетронутой.
  const { homeworkStore } = await import('../src/storage/homeworkStore.ts');
  const { importantStore } = await import('../src/storage/importantStore.ts');

  const barsAuth = {
    encryptedLogin: 'x', encryptedPass: 'x', iv: 'x', tag: 'x',
    ivPass: 'x', tagPass: 'x', cookiesJson: '{}', savedAt: new Date().toISOString(),
  };

  const makeGroupUser = (login: string, groupName: string, fullName: string): string => {
    const user = userStore.create({ barsLoginHash: computeBarsLoginHash(login) });
    userStore.patch(user.userId, {
      groupName,
      barsAuth,
      studentProfile: { fullName, groupName },
    });
    const { token: userToken } = issuePwaToken(user.userId);
    userStore.addToken(user.userId, hashToken(userToken), new Date(Date.now() + 86_400_000));
    return userToken;
  };

  const alphaToken = makeGroupUser('iso-alpha', 'ИЭ-11-26', 'Альфа Студент');
  const betaToken = makeGroupUser('iso-beta', 'ИЖ-42-26', 'Бета Студент');
  const betaUserId = userStore.getByBarsLoginHash(computeBarsLoginHash('iso-beta'))!.userId;

  const betaHwId = 'hw_iso_beta_0000000000000000000001';
  const betaImpId = 'imp_iso_beta_000000000000000000001';

  homeworkStore.save({
    id: betaHwId, groupName: 'ИЖ-42-26', discipline: 'Физика', kind: 'lab',
    targetDate: '2026.10.20', text: 'BETA HW', files: [], authorId: betaUserId,
    createdAt: new Date().toISOString(),
  });
  importantStore.save({
    id: betaImpId, groupName: 'ИЖ-42-26', title: 'BETA', text: 'BETA', files: [],
    authorId: betaUserId, createdAt: new Date().toISOString(),
  });

  const patchHw = await app.inject({
    method: 'PATCH', url: `/api/homework/${betaHwId}`, headers: auth(alphaToken), payload: { text: 'взлом' },
  });
  check('PATCH чужого ДЗ → 404', patchHw.statusCode === 404, `${patchHw.statusCode} ${patchHw.body}`);
  check('чужое ДЗ не изменено', homeworkStore.get(betaHwId)?.text === 'BETA HW');

  const deleteHw = await app.inject({
    method: 'DELETE', url: `/api/homework/${betaHwId}`, headers: auth(alphaToken),
  });
  check('DELETE чужого ДЗ → 404', deleteHw.statusCode === 404, String(deleteHw.statusCode));
  check('чужое ДЗ осталось на месте', homeworkStore.get(betaHwId) !== undefined);

  const patchImp = await app.inject({
    method: 'PATCH', url: `/api/important/${betaImpId}`, headers: auth(alphaToken), payload: { text: 'взлом' },
  });
  check('PATCH чужого объявления → 404', patchImp.statusCode === 404, String(patchImp.statusCode));
  check('чужое объявление не изменено', importantStore.get(betaImpId)?.text === 'BETA');

  const deleteImp = await app.inject({
    method: 'DELETE', url: `/api/important/${betaImpId}`, headers: auth(alphaToken),
  });
  check('DELETE чужого объявления → 404', deleteImp.statusCode === 404, String(deleteImp.statusCode));
  check('чужое объявление осталось на месте', importantStore.get(betaImpId) !== undefined);

  const ownPatch = await app.inject({
    method: 'PATCH', url: `/api/important/${betaImpId}`, headers: auth(betaToken), payload: { text: 'своё' },
  });
  check('своя группа правит своё объявление → 200', ownPatch.statusCode === 200, String(ownPatch.statusCode));
  check('правка своей группы применилась', importantStore.get(betaImpId)?.text === 'своё');
}

console.log('\n— Отзыв токена —');
{
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(token) });
  check('POST /api/auth/logout → 200', logout.statusCode === 200, String(logout.statusCode));

  const after = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(token) });
  check('после выхода тот же токен → 401', after.statusCode === 401, String(after.statusCode));
  check(
    'хэш отозванного токена удалён из записи',
    userStore.getByUserId(userId)?.pwaTokens?.length === 0,
  );

  const logoutAgain = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(token) });
  check('повторный выход всё равно → 401 (токен уже отозван)', logoutAgain.statusCode === 401);
}

console.log('\n— CORS —');
{
  const stranger = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { origin: 'https://чужой-домен.example' },
  });
  check(
    'чужой origin без CORS-заголовка',
    stranger.headers['access-control-allow-origin'] === undefined,
  );

  const own = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { origin: 'http://localhost:5173' },
  });
  check('localhost:5173 разрешён', own.headers['access-control-allow-origin'] === 'http://localhost:5173');

  const opaque = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { origin: 'null' },
  });
  check('null origin не разрешён', opaque.headers['access-control-allow-origin'] === undefined);
}

console.log('\n— initData больше не участвует —');
{
  // Заголовок Telegram-подписи должен игнорироваться полностью: если бы он
  // ещё проверялся, приложение вне Telegram перестало бы работать.
  const legacy = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: { 'x-telegram-init-data': 'auth_date=1&hash=мусор' },
  });
  check('одна только initData → 401', legacy.statusCode === 401, String(legacy.statusCode));
  check(
    'initData не подставляет пользователя',
    legacy.json<{ error?: string }>().error === 'unauthorized',
  );
}

await app.close();
fs.rmSync(WORK_DIR, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✅' : '❌'} PWA API: ${checks - failures} ok, ${failures} ошибок\n`);
process.exit(failures === 0 ? 0 : 1);
