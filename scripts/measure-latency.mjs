/**
 * Точный замер: время до ПЕРВОГО изменения экрана.
 *
 * Предыдущий замер ждал полной стабилизации — это 3 проверки по 32 мс, то есть
 * минимум 96 мс чистой погрешности, завышенной в результат. На вопрос «переключение
 * дня мгновенное или нет» такой ответ бесполезен: невозможно отличить 100 мс
 * от 190 мс, когда 96 из них — измеритель.
 *
 * Здесь момент отсчёта — первое же изменение innerText, то есть первый кадр,
 * на котором пользователь увидел результат. Это и есть «мгновенно».
 *
 * Запуск: node --experimental-websocket scripts/measure-latency.mjs [адрес]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const CPU = 4;

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

const client = await connect();
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Emulation.setDeviceMetricsOverride', { ...PHONE, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await client.send('Emulation.setCPUThrottlingRate', { rate: CPU });

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

// Вход
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

/**
 * Ставит наблюдатель за DOM и возвращает момент первого изменения.
 * Наблюдатель живёт в странице, поэтому между кадрами ничего не теряется.
 */
const armWatcher = () => evaluate(`
  (() => {
    window.__seen = null;
    window.__t0 = performance.now();
    const root = document.getElementById('root');
    const mo = new MutationObserver(() => {
      if (window.__seen === null) window.__seen = performance.now() - window.__t0;
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    window.__mo = mo;
    'armed';
  })()
`);

const readWatcher = () => evaluate(`
  (() => {
    const ms = window.__seen;
    window.__mo.disconnect();
    return JSON.stringify({ ms });
  })()
`);

/**
 * Нажатие. Пауза между началом и концом — имитация реального пальца.
 *
 * Отсчёт в странице перезапускается на отпускании: палец держится на экране
 * 70 мс, и это время не должно попадать в замер реакции интерфейса. Иначе все
 * замеры выходили одинаковыми — ровно 83 мс, то есть 70 мс паузы плюс 13.
 */
const tap = async (x, y) => {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(70);
  await evaluate(`window.__t0 = performance.now(); 'reset'`);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

const centerOf = (text) =>
  evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button,[role="tab"]')]
        .find(x => x.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()
  `);

/**
 * Замер: ставим наблюдатель, жмём, ждём первое изменение DOM.
 * t0 берётся в странице в момент нажатия, поэтому в замер не попадает ни
 * задержка CDP, ни время на поиск координат.
 */
async function measureFirstPaint(name, action) {
  await evaluate(`
    window.__t0 = performance.now();
    window.__seen = null;
    if (window.__mo) window.__mo.disconnect();
    const root = document.getElementById('root');
    window.__mo = new MutationObserver(() => {
      if (window.__seen === null) window.__seen = performance.now() - window.__t0;
    });
    window.__mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    'armed';
  `);

  await action();

  // Ждём первого изменения, но не бесконечно.
  for (let i = 0; i < 100; i++) {
    const { ms } = JSON.parse(await readWatcher.call(null));
    if (ms !== null) {
      console.log(`  ${name.padEnd(30)} ${String(Math.round(ms)).padStart(4)} мс до первого изменения`);
      return Math.round(ms);
    }
    await sleep(25);
  }

  console.log(`  ${name.padEnd(30)} > 2.5 с (не дождались)`);
  return null;
}

console.log(`\niPhone ${PHONE.width}×${PHONE.height}, CPU ×${CPU}`);
console.log('=== ЗАДЕРЖКА ДО ПЕРВОГО ИЗМЕНЕНИЯ ЭКРАНА ===\n');

const out = {};

// Вкладки
for (const tab of ['Успеваемость', 'Задания', 'Расписание']) {
  const pos = await centerOf(tab);
  if (!pos) { console.log(`  ⚠️  «${tab}» не найдена`); continue; }
  const { x, y } = JSON.parse(pos);
  out[`вкладка ${tab}`] = await measureFirstPaint(`вкладка «${tab}»`, () => tap(x, y));
  await sleep(900);
}

// Дни
const days = JSON.parse(await evaluate(`
  JSON.stringify([...document.querySelectorAll('button[aria-pressed]')].map(b => {
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), x: r.x + r.width/2, y: r.y + r.height/2 };
  }))
`));

for (const d of days.slice(0, 4)) {
  out[`день ${d.label}`] = await measureFirstPaint(`день «${d.label}»`, () => tap(d.x, d.y));
  await sleep(700);
}

// Свайп: измеряем от отпускания пальца до появления новой недели.
await evaluate(`
  window.__t0 = performance.now();
  window.__seen = null;
  if (window.__mo) window.__mo.disconnect();
  window.__mo = new MutationObserver(() => {
    if (window.__seen === null) window.__seen = performance.now() - window.__t0;
  });
  window.__mo.observe(document.getElementById('root'), { childList: true, subtree: true, characterData: true, attributes: true });
  'armed';
`);

await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: PHONE.width * 0.8, y: 220 }] });
for (let i = 1; i <= 12; i++) {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: PHONE.width * 0.8 - (PHONE.width * 0.5 * i) / 12, y: 220 }],
  });
  await sleep(16);
}
await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

for (let i = 0; i < 100; i++) {
  const { ms } = JSON.parse(await readWatcher());
  if (ms !== null) {
    out['свайп недели (от отпускания)'] = Math.round(ms);
    console.log(`  ${'свайп недели'.padEnd(30)} ${String(Math.round(ms)).padStart(4)} мс до появления новой недели`);
    break;
  }
  await sleep(25);
}

const values = Object.values(out).filter((v) => typeof v === 'number');
console.log('\n=== ИТОГ ===');
console.log(`  Медиана: ${values.sort((a, b) => a - b)[Math.floor(values.length / 2)]} мс`);
console.log(`  Худшее:  ${Math.max(...values)} мс`);
console.log('JSON ' + JSON.stringify(out));

await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
client.close();
process.exit(0);