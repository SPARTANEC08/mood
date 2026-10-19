/**
 * Тесты краевых случаев OWA-клиента.
 *
 * Дополняют test:owa теми ветками, которые легко сломать незаметно:
 *  - мусорные cookies не должны считаться живой сессией (иначе вход пропускается
 *    и первый запрос ловит 401 — пользователь видит «отказ входа» при верном пароле);
 *  - JSON с Body.ErrorCode — это ошибка, а не «0 писем»;
 *  - письма лежат в RootFolder.Items, а не в обёртке ResponseMessages.Items;
 *  - 449 (Retry With) — один повтор с canary из ответа.
 *
 * Запуск: npm run test:owa-edges
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CookieJar } from 'tough-cookie';

import { OwaMailClient } from '../services/mail/owaMailClient.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

type Scenario = 'ok' | 'error_code';

const mock = { scenario: 'ok' as Scenario, logins: 0, canarySeq: 0, currentCanary: '', serviceCanaries: [] as string[] };

function loginPage(): string {
  return `<!doctype html><html><body><form action="/CookieAuth.dll?Logon" method="post">
    <input type="hidden" name="curl" value="x">
    <input type="hidden" name="flags" value="0">
    <input type="text" name="username"><input type="password" name="password">
  </form></body></html>`;
}

const getFolderOk = JSON.stringify({
  Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', ResponseCode: 'NoError', Folders: [{ TotalCount: 4, UnreadCount: 2 }] }] } },
});

const getFolderError = JSON.stringify({
  Body: { ErrorCode: 500, ExceptionName: 'FaultException', FaultMessage: 'boom' },
});

const findItemOk = JSON.stringify({
  Body: {
    ResponseMessages: {
      Items: [
        {
          ResponseClass: 'Success',
          ResponseCode: 'NoError',
          RootFolder: {
            Items: [
              {
                Subject: 'Тема письма',
                DateTimeReceived: '2026-10-18T10:00:00.000Z',
                From: { Mailbox: { Name: 'Деканат' } },
                HasAttachments: true,
                IsRead: false,
              },
            ],
          },
        },
      ],
    },
  },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const cookie = req.headers.cookie ?? '';

  if (req.method === 'GET' && url.pathname === '/owa/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cookie.includes('sessionid=') ? '<html><body>dash</body></html>' : loginPage());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/CookieAuth.dll') {
    req.resume();
    mock.logins += 1;
    mock.canarySeq += 1;
    mock.currentCanary = `canary-${mock.canarySeq}`;
    res.writeHead(302, {
      Location: '/owa/',
      'Set-Cookie': [`sessionid=s${mock.canarySeq}; Path=/owa`, `X-OWA-CANARY=${mock.currentCanary}; Path=/owa`],
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/owa/service.svc') {
    req.resume();
    const canary = req.headers['x-owa-canary'];
    mock.serviceCanaries.push(typeof canary === 'string' ? canary : '');
    const action = url.searchParams.get('action');

    if (canary !== mock.currentCanary) {
      // OWA 2010 на 449 сама выдаёт canary — как и требует клиент, который
      // повторяет запрос уже с ним. Пустой canary был бы невалидным моком.
      if (!mock.currentCanary) {
        mock.canarySeq += 1;
        mock.currentCanary = `canary-${mock.canarySeq}`;
      }
      res.writeHead(449, { 'Content-Type': 'text/html', 'Set-Cookie': [`X-OWA-CANARY=${mock.currentCanary}; Path=/owa`] });
      res.end('The custom error module does not recognize this error.');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (mock.scenario === 'error_code') {
      res.end(getFolderError);
      return;
    }
    res.end(action === 'GetFolder' ? getFolderOk : findItemOk);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log('====================================================');
  console.log('   ТЕСТЫ OWA: КРАЕВЫЕ СЛУЧАИ');
  console.log('====================================================');

  section('Мусорные cookies не считаются живой сессией');
  {
    mock.scenario = 'ok';
    mock.logins = 0;
    mock.canarySeq = 0;
    mock.currentCanary = '';
    mock.serviceCanaries = [];

    const jar = new CookieJar();
    await jar.setCookie('junk=1; Path=/', origin);
    const client = new OwaMailClient(
      { user: 'st000001', pass: 'secret' },
      { baseUrl: origin, cookiesJson: JSON.stringify(jar.serializeSync()) },
    );

    const status = await client.getInboxStatus();
    check('вход выполнен, несмотря на мусорную cookie', mock.logins === 1, String(mock.logins));
    check('данные получены', status.total === 4 && status.unread === 2, JSON.stringify(status));
  }

  section('JSON с Body.ErrorCode — это ошибка, а не «0 писем»');
  {
    mock.scenario = 'error_code';
    mock.logins = 0;
    mock.canarySeq = 0;
    mock.currentCanary = '';
    mock.serviceCanaries = [];

    const client = new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin });
    try {
      const status = await client.getInboxStatus();
      check('ошибка всплыла, а не превратилась в 0 писем', false, JSON.stringify(status));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      check('ошибка всплыла явно', message.includes('OWA service.svc'), message);
    }
  }

  section('Письма читаются из RootFolder.Items');
  {
    mock.scenario = 'ok';
    mock.logins = 0;
    mock.canarySeq = 0;
    mock.currentCanary = '';
    mock.serviceCanaries = [];

    const client = new OwaMailClient({ user: 'st000001', pass: 'secret' }, { baseUrl: origin });
    const briefs = await client.fetchMessageBriefs({ limit: 10, onlyUnread: false });
    check('одно письмо, не обёртка', briefs.length === 1, String(briefs.length));
    check('тема разобрана', briefs[0]?.subject === 'Тема письма', String(briefs[0]?.subject));
    check('отправитель разобран', briefs[0]?.from === 'Деканат', String(briefs[0]?.from));
    check('вложение отмечено', briefs[0]?.hasAttachments === true);
  }

  section('449 → повтор со свежим canary');
  {
    mock.scenario = 'ok';
    mock.logins = 0;
    mock.canarySeq = 0;
    mock.currentCanary = '';
    mock.serviceCanaries = [];

    // Сессия есть, canary нет — ровно случай OWA 2010: первый служебный запрос
    // получает 449, сервер отдаёт canary в ответе, повтор идёт уже с ним.
    const jar = new CookieJar();
    await jar.setCookie('sessionid=stale; Path=/owa', origin);
    const client = new OwaMailClient(
      { user: 'st000001', pass: 'secret' },
      { baseUrl: origin, cookiesJson: JSON.stringify(jar.serializeSync()) },
    );

    const status = await client.getInboxStatus();

    check('после повтора данные получены', status.total === 4, JSON.stringify(status));
    check('первый запрос ушёл без canary', mock.serviceCanaries[0] === '', JSON.stringify(mock.serviceCanaries));
    check('повтор ушёл со свежим canary', mock.serviceCanaries[1] === mock.currentCanary, JSON.stringify(mock.serviceCanaries));
    check('ровно два запроса', mock.serviceCanaries.length === 2, String(mock.serviceCanaries.length));
    // Перелогин не нужен: сессия жива, не хватало только canary — он пришёл в 449.
    check('перелогина не было', mock.logins === 0, String(mock.logins));
  }
}

await main()
  .catch((err: unknown) => {
    failed += 1;
    console.error('\n❌ Тест упал:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  })
  .finally(() => {
    server.close();
    console.log(`\n${'='.repeat(52)}`);
    console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
    console.log('='.repeat(52));
    process.exit(failed === 0 ? 0 : 1);
  });
