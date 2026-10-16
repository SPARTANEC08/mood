/**
 * Отладка PWA в настоящем Chrome через CDP.
 *
 * Зачем: ошибку рендера не видно ни в логах сервера (запросы успешны), ни в
 * терминале vite. Видно её только из консоли браузера — а именно там падает
 * React, когда приложение уходит в чёрный экран.
 *
 * Что делает: открывает страницу, жмёт dev-кнопку входа, ждёт данных и
 * печатает всё, что браузер писал в консоль, плюс итоговое состояние DOM.
 *
 * Запуск: node scripts/debug-pwa.mjs [адрес]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const CDP = 'http://127.0.0.1:9222';

/** Минимальный клиент CDP поверх встроенного fetch и WebSocket Node 22+. */
async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('В Chrome нет ни одной вкладки');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }

    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };

  return {
    send(method, params = {}) {
      const msgId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = await connect();
await client.send('Runtime.enable');
await client.send('Log.enable');
await client.send('Page.enable');
await client.send('Network.enable');

console.log(`[debug] Открываю ${BASE}`);

const logs = [];
client.on('Runtime.consoleAPICalled', (p) => {
  const text = (p.args ?? [])
    .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
    .join(' ');
  logs.push(`[${p.type}] ${text}`);
});
client.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails;
  logs.push(`[ИСКЛЮЧЕНИЕ] ${d.exception?.description ?? d.text}`);
});
client.on('Log.entryAdded', (p) => logs.push(`[${p.entry.level}] ${p.entry.text}`));
client.on('Network.loadingFailed', (p) => {
  if (!p.errorText.includes('ERR_ABORTED')) logs.push(`[СЕТЬ] ${p.errorText}`);
});

await client.send('Page.navigate', { url: BASE });
await sleep(4000);

// Dev-кнопка появляется только в dev-сборке и только при заданном ID.
const clicked = await client.send('Runtime.evaluate', {
  expression: `
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.includes('[DEV]'));
      if (!btn) return 'нет кнопки';
      btn.click();
      return 'нажата';
    })()
  `,
  returnByValue: true,
});
console.log(`[debug] Dev-кнопка: ${clicked.result.value}`);

// После входа страница перезагружается — ждём её и данные.
await sleep(9000);

const state = await client.send('Runtime.evaluate', {
  expression: `
    JSON.stringify({
      url: location.href,
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      text: (document.getElementById('root')?.innerText ?? '').slice(0, 400),
      skeletons: document.querySelectorAll('[class*="animate-pulse"]').length,
      hasToken: !!localStorage.getItem('hub_pwa_token'),
      bodyHeight: document.body.scrollHeight,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    })
  `,
  returnByValue: true,
});

console.log('\n=== СОСТОЯНИЕ СТРАНИЦЫ ===');
console.log(JSON.stringify(JSON.parse(state.result.value), null, 2));

console.log('\n=== КОНСОЛЬ БРАУЗЕРА ===');
if (logs.length === 0) console.log('(пусто)');
for (const line of logs.slice(0, 40)) console.log(line);

client.close();
process.exit(0);