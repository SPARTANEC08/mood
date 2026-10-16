/**
 * Скриншоты в середине жеста: видно, что именно «заливает» экран.
 *
 * Числа замеров не показывают, что происходит визуально: анимация может
 * длиться полсекунды и при этом быть ровной. Снимок в середине жеста показывает
 * наложение старой и новой недели — то есть сам дефект.
 *
 * Запуск: node --experimental-websocket scripts/shoot-swipe.mjs [адрес] [папка]
 */

import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = process.argv[3] ?? '/tmp/hub-shots';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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

mkdirSync(OUT, { recursive: true });

const client = await connect();
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Emulation.setDeviceMetricsOverride', {
  ...PHONE,
  screenOrientation: { type: 'portraitPrimary', angle: 0 },
});
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

const shot = async (name) => {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = `${OUT}/${name}.png`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};

// ── Вход ────────────────────────────────────────────────────────────────────
await client.send('Page.navigate', { url: BASE });
await sleep(3000);
const issued = await fetch(`${BASE}/api/pwa/issue?devTelegramId=757471228`);
if (issued.ok) {
  const { token, expiresAt } = await issued.json();
  await evaluate(`
    localStorage.setItem('hub_pwa_token', ${JSON.stringify(token)});
    localStorage.setItem('hub_pwa_token_expires', ${JSON.stringify(String(expiresAt))});
    'ok'
  `);
}
await client.send('Page.navigate', { url: BASE });
await sleep(8000);

console.log('Снимки:', OUT);

// 1. Обычный экран.
console.log(await shot('1-idle'));

/**
 * Сколько элементов одновременно видно во время анимации недели.
 *
 * Это главный измеряемый дефект «залива»: в режиме popLayout старый слой
 * остаётся в DOM до конца exit-анимации, и если новый уже нарисован, на
 * экране их два. Считаем блоки недели — даты и карточки пар.
 */
const countLayers = () => evaluate(`
  (() => {
    // Ищем узлы-обёртки анимации: у framer-motion это элементы с
    // transform, внутри которых лежат кнопки дат.
    const dateButtons = [...document.querySelectorAll('button[aria-pressed]')];
    const seen = new Map();
    for (const b of dateButtons) {
      const key = b.getAttribute('aria-label');
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(b);
    }
    const dupes = [...seen.entries()].filter(([, els]) => els.length > 1);
    return JSON.stringify({
      totalDateCells: dateButtons.length,
      duplicatedDates: dupes.map(([k]) => k),
      visible: dupes.map(([, els]) => els.filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      }).length),
      textLen: (document.getElementById('root')?.innerText ?? '').length,
    });
  })()
`);

// 2. Свайп с остановкой на середине — там, где видно наложение.
await client.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: PHONE.width * 0.8, y: 220 }],
});

const midX = PHONE.width * 0.8 - PHONE.width * 0.3;
for (let i = 1; i <= 8; i++) {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: PHONE.width * 0.8 - (PHONE.width * 0.3 * i) / 8, y: 220 }],
  });
  await sleep(16);
}

console.log(await shot('2-mid-swipe'));
console.log('Слои в середине жеста:', await countLayers());

// 3. Через 80 мс после отпускания — пик анимации выхода.
await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(90);
console.log(await shot('3-just-after-release'));
console.log('Слои через 90 мс:', await countLayers());

await sleep(400);
console.log(await shot('4-settled'));
console.log('Слои в покое:', await countLayers());

client.close();
process.exit(0);