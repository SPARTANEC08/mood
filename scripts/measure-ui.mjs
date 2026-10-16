/**
 * Замер UI на эмулированном iPhone с замедленным процессором.
 *
 * Три вещи делают этот замер честным, а предыдущие попытки — нет:
 *
 * 1. Эмуляция телефона. На десктопном вьюпорте 756×469 интерфейс влезает
 *    целиком и ни одна анимация не страдает. Проблемы пользователя
 *    появляются на 390×844 с медленным процессором.
 *
 * 2. CPU throttling ×4. Ровно так работает телефон середины ценового
 *    диапазона. Без этого любой лаг на десктопе выглядит невоспроизводимым,
 *    и оптимизировать приходится вслепую.
 *
 * 3. Счётчики ставятся ПОСЛЕ последней навигации. Раньше они ставились до
 *    неё, страница перезагружалась и обнуляла их — отсюда «0 кадров»
 *    при анимации, которая на самом деле шла.
 *
 * Запуск: node --experimental-websocket scripts/measure-ui.mjs [адрес]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** iPhone 13: 390×844, DPR 3 — самый массовый размер. */
const PHONE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
};

/** Замедление ЦП. 4× — типичный iPhone SE / средний Android. */
const CPU_THROTTLE = 4;

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
await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

// ── Счётчики. Ставятся ПОСЛЕ финальной навигации, иначе страница их сносит.
const INSTALL = `
  window.__lt = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  // Кадры считает собственный цикл requestAnimationFrame, а не перехват
  // window.requestAnimationFrame. Перехват не работает: framer-motion 14
  // анимирует через Web Animations API (element.animate), минуя rAF
  // полностью, поэтому перехваченный счётчик всегда давал ноль — и замер
  // выглядел «ничего не тормозит», хотя анимация шла.
  window.__f = 0;
  window.__tick = () => {
    window.__f++;
    window.__raf = requestAnimationFrame(window.__tick);
  };
  window.__raf = requestAnimationFrame(window.__tick);

  window.__rec = () => ({ f: window.__f, lt: [...window.__lt] });
  window.__reset = () => {
    window.__f = 0;
    window.__lt = [];
  };
  'ok';
`;

const reset = () => evaluate(`window.__reset(); 'ok'`);
const read = () => evaluate(`JSON.stringify(window.__rec())`);

/** Ждёт, пока текст экрана перестанет меняться: конец анимации. */
async function waitSettled(timeoutMs = 3000) {
  const start = Date.now();
  let last = null;
  let stable = 0;

  while (Date.now() - start < timeoutMs) {
    const text = await evaluate(`(document.getElementById('root')?.innerText ?? '').slice(0, 300)`);
    if (text === last) {
      if (++stable >= 3) return Date.now() - start;
    } else {
      stable = 0;
      last = text;
    }
    await sleep(32);
  }
  return Date.now() - start;
}

async function tap(x, y) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(70);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Медленный свайп: так ведёт себя палец, а не безумный флик. */
async function swipe(x, y, dx, steps = 14) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y }],
    });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Находит цент��р кнопки по её подписи. */
const findCenter = (text) =>
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

// ── Подготовка: открыть и войти ─────────────────────────────────────────────
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
await evaluate(INSTALL);

console.log(`\niPhone ${PHONE.width}×${PHONE.height}, CPU ×${CPU_THROTTLE}\n`);
console.log('=== ЗАМЕРЫ ДО ПРАВОК ===');

const results = [];

async function measure(name, action) {
  await reset();
  const t0 = Date.now();
  await action();
  const wall = Date.now() - t0;
  const settle = wall + (await waitSettled());
  const { f, lt } = JSON.parse(await read());

  results.push({ name, ms: settle, frames: f, longTasks: lt, worst: lt.length ? Math.max(...lt) : 0 });

  const bad = lt.length ? `${lt.length} (худшая ${Math.max(...lt)} мс)` : 'нет';
  console.log(`  ${name.padEnd(28)} ${String(settle).padStart(5)} мс  кадров ${String(f).padStart(3)}  длинных задач: ${bad}`);
}

// ── 1. Переключение вкладок ─────────────────────────────────────────────────
for (const tab of ['Успеваемость', 'Задания', 'Кабинет', 'Расписание']) {
  const pos = await findCenter(tab);
  if (!pos) { console.log(`  ⚠️  вкладка «${tab}» не найдена`); continue; }
  const { x, y } = JSON.parse(pos);
  await measure(`вкладка «${tab}»`, () => tap(x, y));
}

// ── 2. Переключение дней внутри недели ──────────────────────────────────────
const days = JSON.parse(await evaluate(`
  JSON.stringify([...document.querySelectorAll('button[aria-pressed]')].map(b => {
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), x: r.x + r.width/2, y: r.y + r.height/2 };
  }))
`));

for (const d of days.slice(0, 4)) {
  await measure(`день «${d.label}»`, () => tap(d.x, d.y));
}

// ── 3. Свайп недели ─────────────────────────────────────────────────────────
await measure('свайп недели вперёд', () => swipe(PHONE.width / 2, 220, -PHONE.width * 0.55));
await measure('свайп недели назад', () => swipe(PHONE.width / 2, 220, PHONE.width * 0.55));

// ── 4. Быстрое листание недель (серия свайпов) ───────────────────────────────
await measure('серия свайпов', async () => {
  for (let i = 0; i < 3; i++) {
    await swipe(PHONE.width / 2, 220, -PHONE.width * 0.5);
    await sleep(120);
  }
});

// ── Итог ────────────────────────────────────────────────────────────────────
const avg = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
const totalLong = results.reduce((a, r) => a + r.longTasks.length, 0);
const worst = results.reduce((a, r) => Math.max(a, r.worst), 0);

console.log('\n=== СВОДКА ДО ПРАВОК ===');
console.log(`  Среднее время до устоявшегося экрана: ${avg} мс`);
console.log(`  Длинных задач (>50 мс):               ${totalLong}`);
console.log(`  Худшая длинная задача:                ${worst} мс`);
console.log(`  КАДР JSON:`);
console.log(JSON.stringify({ phone: PHONE, cpu: CPU_THROTTLE, results }));

await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
client.close();
process.exit(0);