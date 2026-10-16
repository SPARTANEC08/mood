/**
 * Проверка оформления и вкладок PWA в настоящем Chrome.
 *
 * Отдельно от debug-pwa.mjs: этот проходит по вкладкам и смотрит, что у каждой
 * есть содержимое, а не только заголовок. Так ловится «вкладка открывается, но
 * пустая» — на телефоне это выглядит как чёрный экран, хотя компонент на месте.
 *
 * Запуск: node --experimental-websocket scripts/debug-tabs.mjs [адрес]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? '?');
    }
  };

  return {
    send(method, params = {}) {
      const msgId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
    errors,
    close: () => ws.close(),
  };
}

const client = await connect();
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Page.navigate', { url: BASE });
await sleep(9000);

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

console.log('=== Тема и оформление ===');
console.log(await evaluate(`JSON.stringify({
  prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
  colorScheme: document.documentElement.style.colorScheme,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  rootColor: getComputedStyle(document.getElementById('root')).color,
  hasCssVars: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '(нет)',
  stylesheets: document.styleSheets.length,
  bodyHeight: document.body.scrollHeight,
}, null, 2)`));

console.log('\n=== Вкладки ===');
const tabNames = await evaluate(`
  JSON.stringify([...document.querySelectorAll('button, [role="tab"], nav button')]
    .map(b => b.textContent.trim())
    .filter(t => t && t.length < 20))
`);

const tabs = JSON.parse(tabNames);
for (const tab of tabs) {
  const clicked = await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button,[role="tab"]')]
        .find(x => x.textContent.trim() === ${JSON.stringify(tab)});
      if (!b) return 'нет';
      b.click();
      return 'ok';
    })()
  `);
  if (clicked !== 'ok') continue;

  await sleep(1800);
  const info = await evaluate(`
    JSON.stringify({
      height: document.body.scrollHeight,
      text: (document.getElementById('root')?.innerText ?? '').length,
      head: (document.getElementById('root')?.innerText ?? '').slice(0, 90).replace(/\\n/g, ' | '),
    })
  `);
  const d = JSON.parse(info);
  const verdict = d.text > 40 ? '✅' : '⚠️  пусто';
  console.log(`  ${verdict} «${tab}» — ${d.text} симв., ${d.height}px`);
  console.log(`      ${d.head}`);
}

console.log('\n=== Исключения ===');
console.log(client.errors.length ? [...new Set(client.errors)].join('\n') : '(нет)');

client.close();
process.exit(0);