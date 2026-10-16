/**
 * Ловит скачок нижней панели при переходе на вкладку «Задания».
 *
 * Пользователь жалуется: при заходе в ДЗ панель уезжает вверх на несколько
 * пикселей. Причина не в самой панели, а в том, что что-то под ней меняет
 * высоту или прокрутку, и панель на это реагирует.
 *
 * Поэтому меряем не «красиво ли выглядит», а конкретные числа: координату
 * панели и координату нижней кромки экрана до и после перехода. Разница в
 * первом числе и есть тот скачок.
 *
 * Запуск: node --experimental-websocket scripts/measure-tabbar.mjs [адрес]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

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

const evaluate = async (expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

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
 * Геометрия панели и страницы.
 *
 * Интересуют четыре числа:
 *   navTop — верхняя кромка панели (fixed bottom-0: должна стоять на месте);
 *   navBottom — нижняя кромка (должна совпадать с высотой окна);
 *   scrollY — прокрутка;
 *   bodyH — высота документа (если меньше окна, панель «висит» в воздухе).
 */
const probe = () => evaluate(`
  (() => {
    const nav = document.querySelector('nav[role="tablist"]');
    const r = nav ? nav.getBoundingClientRect() : null;
    const header = document.querySelector('header');
    return JSON.stringify({
      navTop: r ? Math.round(r.top) : null,
      navBottom: r ? Math.round(r.bottom) : null,
      navHeight: r ? Math.round(r.height) : null,
      headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
      scrollY: Math.round(scrollY),
      bodyH: Math.round(document.body.scrollHeight),
      winH: innerHeight,
      bodyOverflow: document.body.style.overflow || '(обычный)',
      activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label') ?? '?',
    });
  })()
`);

const tapTab = async (name) => {
  const pos = await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('[role="tab"]')]
        .find(x => x.getAttribute('aria-label') === ${JSON.stringify(name)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    })()
  `);
  if (!pos) return false;
  const { x, y } = JSON.parse(pos);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(70);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return true;
};

console.log(`\niPhone ${PHONE.width}×${PHONE.height}\n`);

for (const tab of ['Расписание', 'Задания', 'Расписание']) {
  const before = JSON.parse(await probe());
  if (!(await tapTab(tab))) { console.log(`  ⚠️  вкладка «${tab}» не найдена`); continue; }

  // Меряем сразу после: скачок виден в первом же кадре, а через 500 мс
  // панель уже вернулась и дефект не читается.
  await sleep(60);
  const justAfter = JSON.parse(await probe());
  await sleep(600);
  const settled = JSON.parse(await probe());

  const dTop = justAfter.navTop - before.navTop;
  const dHeader = justAfter.headerTop - before.headerTop;

  console.log(`  → «${tab}»`);
  console.log(`     панель: было ${before.navTop} → стало ${justAfter.navTop} (сдвиг ${dTop >= 0 ? '+' : ''}${dTop} px)`);
  console.log(`     шапка:  было ${before.headerTop} → стало ${justAfter.headerTop} (сдвиг ${dHeader >= 0 ? '+' : ''}${dHeader} px)`);
  console.log(`     прокрутка ${before.scrollY} → ${settled.scrollY}, документ ${settled.bodyH}px, окно ${settled.winH}px`);
  console.log(`     body.overflow = ${settled.bodyOverflow}`);
  console.log();
}

client.close();
process.exit(0);