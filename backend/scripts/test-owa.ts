/**
 * Тесты OWA-клиента и маршрута /api/mail на локальном мок-сервере.
 *
 * Сеть МЭИ не нужна: сервер поднимается на 127.0.0.1 и изображает OWA —
 * форму CookieAuth.dll?Logon, выдачу session-cookie/canary, service.svc и
 * страницы отказов. Так проверяются ровно те сценарии, которые на живом
 * сервере воспроизводить долго и опасно (2FA, сломанная форма, протухшая
 * сессия).
 *
 * Что покрыто:
 *  - успешный вход;
 *  - 401 → перелогин → успех, причём canary в повторе СВЕЖИЙ (главный баг);
 *  - 401 → перелогин → снова 401 (session_expired_after_relogin);
 *  - no_session_cookie, returned_login_page, broken_form, invalid_credentials,
 *    two_factor_required;
 *  - /api/mail отдаёт 409 + reason и не трогает barsAuth/PWA-токены;
 *  - 503 для TMG не изменился.
 *
 * Запуск: npm run test:owa
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { CookieJar } from 'tough-cookie';

import {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  type MailAuthReason,
} from '../services/mail/mailErrors.ts';
import { OwaMailClient } from '../services/mail/owaMailClient.ts';

// Хранилище берёт путь из process.cwd() при загрузке модуля — тест уходит в
// временный каталог до импорта сервера и не читает рабочую базу с кредами.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-owa-test-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.NODE_ENV ??= 'test';
process.env.PWA_AUTH_SECRET = 'a'.repeat(64);
process.env.ENCRYPTION_SECRET_KEY = 'b'.repeat(64);

type Scenario =
  | 'ok'
  | 'invalid_credentials'
  | 'no_session_cookie'
  | 'returned_login_page'
  | 'broken_form'
  | 'two_factor_required'
  | 'expired_after_relogin'
  | 'tmg';

const mock = {
  scenario: 'ok' as Scenario,
  logins: 0,
  canarySeq: 0,
  currentCanary: '',
  serviceCanaries: [] as Array<string | undefined>,
  serviceCalls: 0,
};

function resetMock(scenario: Scenario): void {
  mock.scenario = scenario;
  mock.logins = 0;
  mock.canarySeq = 0;
  mock.currentCanary = '';
  mock.serviceCanaries = [];
  mock.serviceCalls = 0;
}

function loginHtml(): string {
  return `<!doctype html><html><body>
    <h1>Вход в почту</h1>
    <form action="/CookieAuth.dll?Logon" method="post">
      <input type="hidden" name="curl" value="https://mail.mpei.ru/owa">
      <input type="hidden" name="flags" value="0">
      <input type="hidden" name="forcedownlevel" value="0">
      <input type="hidden" name="formdir" value="ltr">
      <input type="hidden" name="isUtf8" value="1">
      <input type="hidden" name="chpwd" value="0">
      <input type="hidden" name="chkBsc" value="0">
      <label>Логин <input type="text" name="username"></label>
      <label>Пароль <input type="password" name="password"></label>
      <input type="submit" value="Войти">
    </form>
  </body></html>`;
}

function dashboardHtml(): string {
  return '<!doctype html><html><body><div id="dash">OWA dashboard</div></body></html>';
}

function twoFactorHtml(): string {
  return `<!doctype html><html><body>
    <h1>Введите код подтверждения</h1>
    <form action="/owa/verify" method="post">
      <input type="text" name="otp" autocomplete="one-time-code">
    </form>
  </body></html>`;
}

const getFolderJson = JSON.stringify({
  Body: {
    ResponseMessages: {
      Items: [
        {
          __type: 'FolderInfoResponseMessage:#Exchange',
          ResponseClass: 'Success',
          ResponseCode: 'NoError',
          Folders: [{ TotalCount: 7, UnreadCount: 3 }],
        },
      ],
    },
  },
});

/**
 * Реальная форма FindItem: письма лежат в
 * `Body.ResponseMessages.Items[0].RootFolder.Items`, а не в `ResponseMessages.Items`.
 * Раньше парсер брал внешний массив и подставлял «пустые» карточки — этот тест
 * фиксирует, что теперь видны настоящие тема и отправитель.
 */
const findItemJson = JSON.stringify({
  Body: {
    ResponseMessages: {
      Items: [
        {
          __type: 'FindItemResponseMessage:#Exchange',
          ResponseClass: 'Success',
          ResponseCode: 'NoError',
          RootFolder: {
            Items: [
              {
                __type: 'Message:#Exchange',
                Subject: 'Новое письмо',
                DateTimeReceived: '2026-10-17T10:00:00.000Z',
                From: { Mailbox: { Name: 'СДО Прометей', EmailAddress: 'sdo@mpei.ru' } },
                HasAttachments: false,
                IsRead: false,
              },
            ],
          },
        },
      ],
    },
  },
});

function sendJson(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function setCookies(loginCanary: string): string[] {
  return [
    `sessionid=session-${loginCanary}; Path=/owa; HttpOnly`,
    `X-OWA-CANARY=${loginCanary}; Path=/owa`,
  ];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const cookieHeader = req.headers.cookie ?? '';

  if (req.method === 'GET' && url.pathname === '/owa/') {
    if (mock.scenario === 'tmg') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Network Access Message</h1></body></html>');
      return;
    }
    if (mock.scenario === 'broken_form') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Сервис временно недоступен</p></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cookieHeader.includes('sessionid=') ? dashboardHtml() : loginHtml());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/CookieAuth.dll') {
    // Тело формы не разбираем: клиент проверяет контракт ответа, а не наши
    // представления о полях. Важно лишь то, что он их отправил.
    req.resume();

    if (mock.scenario === 'invalid_credentials') {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<html><body>Unauthorized</body></html>');
      return;
    }
    if (mock.scenario === 'no_session_cookie') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Welcome</body></html>');
      return;
    }
    if (mock.scenario === 'returned_login_page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginHtml());
      return;
    }
    if (mock.scenario === 'two_factor_required') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(twoFactorHtml());
      return;
    }

    mock.logins += 1;
    mock.canarySeq += 1;
    mock.currentCanary = `canary-${mock.canarySeq}`;
    res.writeHead(302, {
      Location: '/owa/',
      'Set-Cookie': setCookies(mock.currentCanary),
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/owa/service.svc') {
    req.resume();
    const canary = req.headers['x-owa-canary'];
    mock.serviceCanaries.push(typeof canary === 'string' ? canary : undefined);
    mock.serviceCalls += 1;

    const action = url.searchParams.get('action');

    // Протухшая/поддельная сессия: OWA отвечает 401, клиент должен один раз
    // перелогиниться и повторить с новым canary.
    if (mock.scenario === 'expired_after_relogin' || canary !== mock.currentCanary) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<html><body>Session expired</body></html>');
      return;
    }

    sendJson(res, action === 'GetFolder' ? getFolderJson : findItemJson);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

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

async function expectAuthReason(
  label: string,
  run: () => Promise<unknown>,
  reason: MailAuthReason,
): Promise<void> {
  try {
    await run();
    check(`${label} → MailAuthError`, false, 'ошибки не было');
  } catch (err: unknown) {
    const isAuth = err instanceof MailAuthError;
    check(`${label} → MailAuthError`, isAuth, err instanceof Error ? err.name : String(err));
    check(
      `${label} → reason ${reason}`,
      isAuth && err.reason === reason,
      isAuth ? err.reason : '—',
    );
  }
}

/** Просроченная сессия: cookies есть, но canary уже недействителен. */
async function staleCookies(origin: string): Promise<string> {
  const jar = new CookieJar();
  await jar.setCookie('sessionid=stale; Path=/owa', origin);
  await jar.setCookie('X-OWA-CANARY=canary-stale; Path=/owa', origin);
  return JSON.stringify(jar.serializeSync());
}

async function run(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OWA_BASE_URL = origin;

  console.log('====================================================');
  console.log('   ТЕСТЫ OWA: КЛИЕНТ И /api/mail (МОК-СЕРВЕР)');
  console.log('====================================================');

  console.log('\n▶ OWA-клиент: вход и GetFolder');
  {
    resetMock('ok');
    const client = new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin });
    const status = await client.getInboxStatus();
    check('успешный вход и GetFolder', status.total === 7 && status.unread === 3, JSON.stringify(status));
    check('session-cookie сохранён', client.serializeCookies().includes('sessionid'));
    check('canary отправлен в service.svc', mock.serviceCanaries[0] === 'canary-1');

    const briefs = await client.fetchMessageBriefs({ limit: 10, onlyUnread: false });
    check('FindItem вернул письмо, а не обёртку', briefs.length === 1, String(briefs.length));
    check('тема письма разобрана', briefs[0]?.subject === 'Новое письмо', String(briefs[0]?.subject));
    check('отправитель разобран', briefs[0]?.from === 'СДО Прометей', String(briefs[0]?.from));
    check('IsRead → isSeen', briefs[0]?.isSeen === false);
  }

  console.log('\n▶ OWA-клиент: 401 → перелогин → успех');
  {
    resetMock('ok');
    const cookiesJson = await staleCookies(origin);
    const client = new OwaMailClient(
      { user: 'st000001', pass: 'secret' },
      { baseUrl: origin, cookiesJson },
    );
    const status = await client.getInboxStatus();

    check('после перелогина данные получены', status.total === 7, JSON.stringify(status));
    check('был ровно один перелогин', mock.logins === 1, String(mock.logins));
    check(
      'первый запрос ушёл со старым canary',
      mock.serviceCanaries[0] === 'canary-stale',
      String(mock.serviceCanaries[0]),
    );
    check(
      'повтор ушёл со СВЕЖИМ canary',
      mock.serviceCanaries[1] === mock.currentCanary,
      `${String(mock.serviceCanaries[1])} !== ${mock.currentCanary}`,
    );
    check('было ровно два запроса service.svc', mock.serviceCalls === 2, String(mock.serviceCalls));
  }

  console.log('\n▶ OWA-клиент: подтипы MailAuthError');
  {
    resetMock('invalid_credentials');
    await expectAuthReason(
      '401 при входе',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'invalid_credentials',
    );
  }
  {
    resetMock('no_session_cookie');
    await expectAuthReason(
      'нет session-cookie',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'no_session_cookie',
    );
  }
  {
    resetMock('returned_login_page');
    await expectAuthReason(
      'снова страница входа',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'returned_login_page',
    );
  }
  {
    resetMock('broken_form');
    await expectAuthReason(
      'нет формы входа',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'broken_form',
    );
  }
  {
    resetMock('two_factor_required');
    await expectAuthReason(
      'страница 2FA',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'two_factor_required',
    );
  }
  {
    resetMock('expired_after_relogin');
    await expectAuthReason(
      '401 после перелогина',
      () => new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin }).getInboxStatus(),
      'session_expired_after_relogin',
    );
    // Свежая сессия: вход + один перелогин = ровно два POST логина.
    check('вход и ровно один перелогин', mock.logins === 2, String(mock.logins));
    check('service.svc вызван дважды', mock.serviceCalls === 2, String(mock.serviceCalls));
  }

  // ── маршрут /api/mail ──────────────────────────────────────────────────────
  console.log('\n▶ /api/mail: 409 + reason вместо 401');
  const { buildServer } = await import('../server/index.ts');
  const { userStore } = await import('../../db/storage/userStore.ts');
  const { issuePwaToken, hashToken } = await import('../utils/pwaAuth.ts');
  const { computeBarsLoginHash } = await import('../utils/barsLoginHash.ts');
  const { encrypt } = await import('../utils/crypto.ts');
  const { clearMailPreview } = await import('../services/mail/mailPreviewCache.ts');
  const { forgetOwaClient } = await import('../services/mail/owaClientRegistry.ts');

  const app = await buildServer();
  await app.ready();

  const created = userStore.create({ barsLoginHash: computeBarsLoginHash('owa-test') });
  const userId = created.userId;
  const loginPayload = encrypt('st000001');
  const passPayload = encrypt('secret');
  userStore.patch(userId, {
    barsAuth: {
      encryptedLogin: loginPayload.encryptedData,
      encryptedPass: passPayload.encryptedData,
      iv: loginPayload.iv,
      tag: loginPayload.tag,
      ivPass: passPayload.iv,
      tagPass: passPayload.tag,
      cookiesJson: '',
      savedAt: new Date().toISOString(),
    },
    studentProfile: { fullName: 'Тестовый Студент' },
  });

  const token = issuePwaToken(userId).token;
  userStore.addToken(userId, hashToken(token), new Date(Date.now() + 86_400_000));

  const headers = { 'x-pwa-token': token };

  async function resetUserState(scenario: Scenario): Promise<void> {
    resetMock(scenario);
    clearMailPreview(userId);
    forgetOwaClient(userId);
    userStore.clearOwaAuth(userId);
  }

  {
    await resetUserState('ok');
    const res = await app.inject({ method: 'GET', url: '/api/mail', headers });
    check('успешный сценарий → 200', res.statusCode === 200, String(res.statusCode));
    const body = res.json<{ total: number; unseen: number }>();
    check('превью содержит счётчики', body.total === 7 && body.unseen === 3, JSON.stringify(body));
    check('owaAuth сохранён после успеха', userStore.getByUserId(userId)?.owaAuth !== undefined);
  }

  const scenarios: Array<[Scenario, MailAuthReason]> = [
    ['invalid_credentials', 'invalid_credentials'],
    ['no_session_cookie', 'no_session_cookie'],
    ['returned_login_page', 'returned_login_page'],
    ['broken_form', 'broken_form'],
    ['two_factor_required', 'two_factor_required'],
    ['expired_after_relogin', 'session_expired_after_relogin'],
  ];

  for (const [scenario, reason] of scenarios) {
    await resetUserState(scenario);
    const res = await app.inject({ method: 'GET', url: '/api/mail', headers });
    const body = res.json<{ error?: string; reason?: string; message?: string }>();

    check(`${reason} → 409`, res.statusCode === 409, String(res.statusCode));
    check(`${reason} → не 401`, res.statusCode !== 401, String(res.statusCode));
    check(
      `${reason} → error=mail_reauth_required`,
      body.error === 'mail_reauth_required',
      String(body.error),
    );
    check(`${reason} → reason в теле`, body.reason === reason, String(body.reason));
    check(
      `${reason} → человеческий текст`,
      body.message === MAIL_AUTH_MESSAGES[reason],
      String(body.message),
    );

    const stored = userStore.getByUserId(userId);
    check(`${reason} → owaAuth сброшен`, stored?.owaAuth === undefined);
    check(`${reason} → barsAuth не тронут`, stored?.barsAuth !== undefined);
    check(
      `${reason} → PWA-токены не тронуты`,
      (stored?.pwaTokens?.length ?? 0) > 0,
      String(stored?.pwaTokens?.length),
    );
  }

  {
    await resetUserState('tmg');
    const res = await app.inject({ method: 'GET', url: '/api/mail', headers });
    check('TMG 403 → 503 (контракт не изменился)', res.statusCode === 503, String(res.statusCode));
  }

  await app.close();
}

await run()
  .catch((err: unknown) => {
    failures += 1;
    console.error('\n❌ Тест упал:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  })
  .finally(() => {
    server.close();
    console.log(`\nПроверок: ${checks}, провалов: ${failures}`);
    if (failures > 0) process.exit(1);
  });
