/**
 * Считает копии React и их identity в живом приложении.
 *
 * Причина, по которой он нужен: React держит диспетчер хуков в модульной
 * переменной укорачивания react-dom. Если в бандле окажется два разных
 * модуля React, framer-motion возьмёт диспетчер из своего, а рендерить будет
 * react-dom — и получится «Cannot read properties of null (reading 'useRef')»
 * и чёрный экран. По счётчику загрузок это видно сразу.
 *
 * Запуск: node --experimental-websocket scripts/debug-react-copies.mjs [адрес]
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
  const logs = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
    }
    if (msg.method === 'Network.responseReceived') {
      const url = msg.params.response.url;
      if (/react|framer|motion/i.test(url)) logs.push(`NET ${url.replace(BASE, '')}`);
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
    logs,
    close: () => ws.close(),
  };
}

const client = await connect();
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Network.enable');
await client.send('Page.navigate', { url: BASE });
await sleep(7000);

const result = await client.send('Runtime.evaluate', {
  expression: `
    JSON.stringify({
      reactScripts: performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => /react|framer|motion/i.test(n) && /\\.(js|mjs)/.test(n)),
    })
  `,
  returnByValue: true,
});

const data = JSON.parse(result.result.value);
console.log('\n=== Загруженные модули React/motion ===');
const seen = new Map();
for (const name of data.reactScripts) {
  const clean = name.replace(/^https?:\/\/[^/]+/, '');
  seen.set(clean, (seen.get(clean) ?? 0) + 1);
}
for (const [name, count] of seen) console.log(`  ${count > 1 ? '⚠️  ' : ''}${name}`);

console.log('\n=== Исключения ===');
const errors = client.logs.filter((l) => l && !l.startsWith('NET'));
if (errors.length === 0) console.log('(нет)');
else for (const e of [...new Set(errors)].slice(0, 3)) console.log(e.split('\n')[0]);

client.close();
process.exit(0);