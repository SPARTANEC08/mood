/**
 * Замеряет, за сколько PWA показывает данные после входа.
 *
 * Нужен потому, что «медленно» на телефоне — это не ощущение, а конкретные
 * миллисекунды, и без замера нельзя отличить «долгий API» от «долгая отрисовка
 * на мобильном». Скрипт кладёт токен в localStorage, перезагружает страницу и
 * меряет от навигации до появления первых данных расписания.
 *
 * Запуск: node --experimental-websocket scripts/debug-perf.mjs [адрес] [telegramId]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const TELEGRAM_ID = process.argv[3] ?? '757471228';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    close: () => ws.close(),
  };
}

const client = await connect();
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Network.enable');
await client.send('Network.setCacheDisabled', { cacheDisabled: false });

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

console.log(`[perf] ${BASE}\n`);

// ── 1. Получаем токен тем же запросом, что делает кнопка входа ───────────────
const issued = await fetch(`${BASE}/api/pwa/issue?devTelegramId=${TELEGRAM_ID}`);
if (!issued.ok) {
  console.log(`❌ Не удалось получить токен: HTTP ${issued.status}`);
  const body = await issued.text().catch(() => '');
  console.log(body.slice(0, 200));
  console.log('\nЗначит, на этой сборке dev-входа нет (он только в dev-сборке).');
  console.log('Войти можно кнопкой «Открыть в браузере» в боте.');
  process.exit(0);
}

const { token, expiresAt } = await issued.json();
console.log('[perf] Токен получен.');

// ── 2. Кладём его и перезагружаем ───────────────────────────────────────────
await client.send('Page.navigate', { url: BASE });
await sleep(3000);

await evaluate(`
  localStorage.setItem('hub_pwa_token', ${JSON.stringify(token)});
  localStorage.setItem('hub_pwa_token_expires', ${JSON.stringify(String(expiresAt))});
  'ok'
`);

// Метки в браузере: сколько реально заняла загрузка, а не сетевая задержка.
await client.send('Page.navigate', { url: BASE });

const t0 = Date.now();
let firstPaint = null;
let fullData = null;

for (let i = 0; i < 60; i++) {
  const probe = await evaluate(`
    JSON.stringify({
      nav: Math.round(performance.getEntriesByType('navigation')[0]?.responseEnd ?? 0),
      paint: Math.round(performance.getEntriesByType('paint')
        .find(p => p.name === 'first-contentful-paint')?.startTime ?? 0),
      skeletons: document.querySelectorAll('[class*="animate-pulse"]').length,
      text: (document.getElementById('root')?.innerText ?? '').length,
      hasSchedule: (document.getElementById('root')?.innerText ?? '').includes('пара')
        || (document.getElementById('root')?.innerText ?? '').includes('Группа'),
    })
  `);

  const p = JSON.parse(probe);
  if (firstPaint === null && p.paint > 0) firstPaint = p.paint;
  if (fullData === null && p.hasSchedule) { fullData = Date.now() - t0; break; }
  await sleep(250);
}

const resources = await evaluate(`
  JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.replace(location.origin, ''),
    dur: Math.round(e.duration),
  })).sort((a, b) => b.dur - a.dur).slice(0, 8))
`);

console.log('=== СКОРОСТЬ ===');
console.log(`  Ответ сервера (ttfb): ${JSON.parse(await evaluate(`JSON.stringify(Math.round(performance.getEntriesByType('navigation')[0]?.responseStart ?? 0))`))} мс`);
console.log(`  Первая отрисовка:      ${firstPaint ?? '—'} мс`);
console.log(`  Данные на экране:      ${fullData === null ? 'не дождались за 15 с' : `${fullData} мс`}`);

console.log('\n=== САМЫЕ МЕДЛЕННЫЕ ЗАПРОСЫ ===');
for (const r of JSON.parse(resources)) console.log(`  ${String(r.dur).padStart(6)} мс  ${r.name}`);

client.close();
process.exit(0);