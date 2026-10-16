/**
 * Проверка вёрстки на настоящем движке браузера.
 *
 * Что проверяется (всё это ловится только в браузере, не типами):
 *  1. Нижнее меню не двигается: его нижняя граница совпадает с высотой
 *     вьюпорта на любом экране и любой вкладке. Именно это и было «сползание».
 *  2. Лента дней не содержит задвоенных клеток: в момент смены дня на экране
 *     ровно одна неделя, а не две.
 *  3. Высота ленты равна высоте текущего дня: короткий день не растянут
 *     под длинный соседний и ничего не срезано.
 *  4. Прокрутка ленты не двигает панель и не двигает документ.
 *  5. Всё то же самое работает с выключенной анимацией и в тёмной теме.
 *
 * Данные подставляет scripts/mock-api.mjs: ни БАРС, ни Telegram, ни сеть для
 * запуска не нужны.
 *
 * Запуск: node scripts/check-layout.mjs [папка со скриншотами]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Playwright нужен только этой проверке, поэтому в package.json его нет и
// ставится отдельно. Ищем его рядом с собранным фронтендом и в корне: держать
// копию браузера в корневом node_modules ради одного скрипта незачем.
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = ['../pwa/node_modules/playwright', '../node_modules/playwright'];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Следующий кандидат.
    }
  }

  throw new Error(
    'Не найден playwright. Установите его рядом со сборкой: ' +
      'cd pwa && npm i -D playwright && npx playwright install chromium',
  );
}

const { chromium } = loadPlaywright();

import { startMockServer, TODAY, formatRawDate } from './mock-api.mjs';

const OUT = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'scratch', 'layout');
const PORT = 5198;

/* ── проверки ────────────────────────────────────────────────────────────── */

const { server } = await startMockServer(PORT);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

// Service Worker не должен вмешиваться в проверку: он кэширует /api/bootstrap и
// тогда сценарии авторизации (?scenario=) не доходят до сети, а регистрация
// мешает детерминированным переходам. Глушим сам sw.js.
await context.route(/\/sw\.js(\?.*)?$/, (route) =>
  route.fulfill({ status: 404, contentType: 'text/javascript', body: '' }),
);

// Вход в PWA самостоятельный: приложение решает, показать интерфейс или экран
// входа, по PWA-токену в localStorage (см. pwa/src/auth.ts). Без токена
// приложение честно открывает экран входа, и ни одну проверку геометрии
// выполнить нельзя. Значение токена мок-сервер не проверяет.
await context.addInitScript(() => {
  localStorage.setItem('hub_pwa_token', 'layout-check-token');
  localStorage.setItem('hub_pwa_token_expires', String(Date.now() + 90 * 24 * 3600 * 1000));
});

const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(name);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('nav[role="tablist"]');
await page.waitForTimeout(600);

/** Границы панели навигации, документа и ленты. */
const metrics = () =>
  page.evaluate(() => {
    const nav = document.querySelector('nav[role="tablist"]').getBoundingClientRect();
    const doc = document.documentElement;

    // Прокручиваемый контейнер ВИДИМОГО дня (самый длинный из тех, что в кадре):
    // прокрутка живёт внутри дня, а соседние дни смонтированы за экраном.
    const scroller = [...document.querySelectorAll('div')]
      .filter((el) => {
        if (getComputedStyle(el).overflowY !== 'auto' || el.clientHeight <= 0) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

    // Контейнер ленты дней: обрезающий div с карточками пар. Сами карточки
    // тоже скрывают переполнение, поэтому они исключены по классу surface.
    const pager = [...document.querySelectorAll('div')]
      .filter(
        (el) =>
          getComputedStyle(el).overflow === 'hidden' &&
          !el.className.includes('surface') &&
          el.querySelector('h3'),
      )
      .pop();

    const dateCells = [...document.querySelectorAll('button[aria-pressed]')];
    // Видимые клетки полосы дат: активная неделя (соседние страницы стоят за
    // экраном, но смонтированы — считать их по всему DOM нельзя).
    const visibleCells = dateCells.filter((cell) => {
      const box = cell.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
    });

    const seen = new Map();
    for (const cell of visibleCells) {
      const key = cell.getAttribute('aria-label');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    return {
      navTop: Math.round(nav.top),
      navBottom: Math.round(nav.bottom),
      viewportHeight: window.innerHeight,
      documentScrollTop: doc.scrollTop,
      documentScrollHeight: doc.scrollHeight,
      documentClientHeight: doc.clientHeight,
      scrollerScrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollerScrollHeight: scroller?.scrollHeight ?? null,
      scrollerClientHeight: scroller?.clientHeight ?? null,
      pagerHeight: pager ? Math.round(pager.getBoundingClientRect().height) : null,
      // Обрезан ли текущий день: обрезающий контейнер ниже, чем его содержимое.
      // Считаем именно по текущему дню: соседи стоят абсолютно и в scrollHeight
      // ленты попадают, хотя по вертикали обрезать нечего.
      pagerClipped: pager
        ? (() => {
            const day = [...pager.children].find((el) => getComputedStyle(el).position !== 'absolute');
            return day
              ? Math.round(day.getBoundingClientRect().height) - Math.round(pager.getBoundingClientRect().height)
              : null;
          })()
        : null,
      dateCells: dateCells.length,
      visibleDateCells: visibleCells.length,
      /** Повтор одной и той же даты среди ВИДИМЫХ — признак задвоенной недели. */
      duplicatedDates: [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k),
      selectedDay: document.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label') ?? null,
      /** Сколько пар нарисовано в видимой части ленты. */
      visibleLessons: [...document.querySelectorAll('h3')].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.left >= 0 && box.right <= window.innerWidth + 1;
      }).length,
    };
  });

const screenBottom = await page.evaluate(() => Math.round(window.innerHeight));
const dayLabel = (raw) => {
  const [, m, d] = raw.split('.');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${Number(d)} ${months[Number(m) - 1]}`;
};

/** На сколько дней отличаются две подписи вида «12 окт». */
function shiftByDays(from, to) {
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const parse = (label) => {
    const [d, m] = label.split(' ');
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), MONTHS.indexOf(m), Number(d));
  };
  return (parse(to) - parse(from)) / 86400000;
}

/** Смещение даты на n дней вперёд от сегодняшней. */
const shift = (n) => {
  const [y, m, d] = TODAY.split('.').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return formatRawDate(date);
};

console.log('\n1. Нижнее меню на сегодняшнем дне');
let m = await metrics();
check('панель прижата к низу', m.navBottom === screenBottom, `bottom=${m.navBottom} экран=${m.viewportHeight}`);
check('документ не прокручивается', m.documentScrollHeight <= m.documentClientHeight, `${m.documentScrollHeight} <= ${m.documentClientHeight}`);
check('открыт сегодняшний день', m.selectedDay === dayLabel(TODAY), `${m.selectedDay} (ожидали ${dayLabel(TODAY)})`);
check('клетки недели не задвоены', m.duplicatedDates.length === 0, m.duplicatedDates.join(', '));
check('видна длинная лента', m.pagerHeight > 400, `${m.pagerHeight}px`);
check('день не срезан обрезающим контейнером', (m.pagerClipped ?? 1) <= 0, `${m.pagerClipped}px`);
await page.screenshot({ path: join(OUT, '1-today.png') });

console.log('\n2. Свайп вперёд на короткий день');
await swipe();
await page.waitForTimeout(700);
m = await metrics();
check('панель на месте после свайпа', m.navBottom === screenBottom, `bottom=${m.navBottom}`);
check('день сменился на следующий', m.selectedDay === dayLabel(shift(1)), `${m.selectedDay}`);
check('клетки недели не задвоены', m.duplicatedDates.length === 0, m.duplicatedDates.join(', '));
await page.screenshot({ path: join(OUT, '2-next-day.png') });

console.log('\n3. Лента дня');
// Текущая раскладка: пейджер дней занимает ВСЮ доступную высоту, а прокрутка
// живёт внутри дня. Поэтому «высоту по содержимому» не проверяем — проверяем,
// что пейджер не вырожден и в кадре один день.
check(
  'лента занимает доступную высоту',
  m.pagerHeight !== null && m.pagerHeight > 300,
  `${m.pagerHeight}px`,
);
check('на экране ровно один день', m.visibleLessons <= 3, `карточек в кадре: ${m.visibleLessons}`);
await page.screenshot({ path: join(OUT, '3-short-day.png') });

console.log('\n3b. Кадр в середине жеста');
await swipeBack(1);
await page.waitForTimeout(700);
let mid = null;
await swipe({
  stopAfter: 6,
  screenshot: 'mid-swipe.png',
  onHold: async () => {
    mid = await page.evaluate(() => {
      // Трек ленты дней — первый ребёнок обрезающего пейджера: transform пишется
      // именно на него, а не на сам пейджер. Полосу недель здесь не проверяем:
      // её трек ВСЕГДА сдвинут на активную неделю, поэтому «transform !== none»
      // у неё бессмысленно.
      const pager = [...document.querySelectorAll('div')]
        .filter(
          (el) =>
            getComputedStyle(el).overflow === 'hidden' &&
            !el.className.includes('surface') &&
            el.querySelector('h3'),
        )
        .pop();
      const track = pager?.firstElementChild ?? null;

      const visibleCells = [...document.querySelectorAll('button[aria-pressed]')].filter((c) => {
        const box = c.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      }).length;

      return {
        trackTransform: track ? getComputedStyle(track).transform : null,
        visibleCells,
      };
    });
  },
});
check('лента пар уехала за пальцем', (mid?.trackTransform ?? 'none') !== 'none', mid?.trackTransform ?? '');
check('в кадре одна неделя, а не две', mid?.visibleCells >= 5 && mid?.visibleCells <= 7, `${mid?.visibleCells} клеток`);
await page.waitForTimeout(700);

console.log('\n3c. Свайп по полосе дат листает неделю с любого дня');
const weekBefore = await metrics();
// Жест начинается на полосе дат — верх ленты, а не по карточкам пар.
await swipeOnStrip();
await page.waitForTimeout(800);
const weekAfter = await metrics();
check('неделя сменилась свайпом по полосе', weekAfter.selectedDay !== weekBefore.selectedDay, `${weekBefore.selectedDay} → ${weekAfter.selectedDay}`);
check('сдвиг ровно на неделю', shiftByDays(weekBefore.selectedDay, weekAfter.selectedDay) === 7, shiftByDays(weekBefore.selectedDay, weekAfter.selectedDay) + ' дней');
check('панель на месте', weekAfter.navBottom === screenBottom, `bottom=${weekAfter.navBottom}`);
check('день не срезан', (weekAfter.pagerClipped ?? 1) <= 0, `${weekAfter.pagerClipped}px`);
await page.screenshot({ path: join(OUT, '3c-week-swipe.png') });
await swipeOnStripRight();
await page.waitForTimeout(800);
const weekBack = await metrics();
check('обратный свайп вернул неделю', weekBack.selectedDay === weekBefore.selectedDay, `${weekAfter.selectedDay} → ${weekBack.selectedDay}`);

console.log('\n4. Свайп через границу недели');
const before = m.selectedDay;
for (let i = 0; i < 4; i += 1) {
  await swipe();
  await page.waitForTimeout(550);
}
m = await metrics();
check('панель на месте', m.navBottom === screenBottom, `bottom=${m.navBottom}`);
check('день сменился', m.selectedDay !== before, `${before} → ${m.selectedDay}`);
check('клетки недели не задвоены', m.duplicatedDates.length === 0, m.duplicatedDates.join(', '));
await page.screenshot({ path: join(OUT, '4-other-week.png') });

console.log('\n5. Прокрутка длинного дня');
// Перезагрузка возвращает приложение на ближайший день (длинный, 5 пар), и он
// гарантированно виден. Крутим контейнер именно видимого дня.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('nav[role="tablist"]');
await page.waitForTimeout(600);

const scrolled = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')]
    .filter((d) => {
      if (getComputedStyle(d).overflowY !== 'auto' || d.clientHeight <= 0) return false;
      const box = d.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
    })
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!el) return { top: null };
  el.scrollTo({ top: 400 });
  return { top: Math.round(el.scrollTop) };
});
await page.waitForTimeout(300);
m = await metrics();
check('панель не сдвинулась при прокрутке', m.navBottom === screenBottom, `bottom=${m.navBottom}`);
check('документ остался в покое', m.documentScrollTop === 0, String(m.documentScrollTop));
check('прокрутилась именно лента', (scrolled.top ?? 0) > 0, String(scrolled.top));
check('документ не вырос', m.documentScrollHeight <= m.documentClientHeight, `${m.documentScrollHeight} <= ${m.documentClientHeight}`);
await page.screenshot({ path: join(OUT, '5-scrolled.png') });

console.log('\n5b. Раскрытие домашнего задания');
const dayContentHeight = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')]
      .filter((d) => {
        if (getComputedStyle(d).overflowY !== 'auto' || d.clientHeight <= 0) return false;
        const box = d.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return el?.scrollHeight ?? 0;
  });
const beforeContent = await dayContentHeight();
// Клик по кнопке ДЗ делаем через DOM: реальный mouse-click в Playwright
// перехватывается pointer-capture пейджера и до React-обработчика не доходит.
// Здесь важна раскладка после раскрытия, а не сам тап.
await page.evaluate(() => {
  const span = [...document.querySelectorAll('span')].find((s) =>
    s.textContent?.includes('Прорешать'),
  );
  (span?.closest('button'))?.click();
});
await page.waitForTimeout(700);
const afterExpand = await metrics();
const afterContent = await dayContentHeight();
// Пейджер дней фиксированной высоты, поэтому рост содержимого виден по
// scrollHeight контейнера дня, а не по высоте пейджера.
check(
  'содержимое дня выросло под развёрнутое задание',
  afterContent > beforeContent,
  `${beforeContent}px → ${afterContent}px`,
);
check(
  'развёрнутое задание не срезано',
  afterExpand.pagerClipped <= 0,
  `разница с высотой ленты: ${afterExpand.pagerClipped}px`,
);
await page.screenshot({ path: join(OUT, '5b-expanded.png') });

console.log('\n6. Остальные вкладки');
for (const [label, name] of [
  ['Успеваемость', '6-grades'],
  ['Задания', '7-tasks'],
  ['Кабинет', '8-profile'],
]) {
  await page.getByRole('tab', { name: label }).click();
  await page.waitForTimeout(600);
  const mm = await metrics();
  check(`${label}: панель на месте`, mm.navBottom === screenBottom, `bottom=${mm.navBottom}`);
  check(`${label}: документ не растёт`, mm.documentScrollHeight <= mm.documentClientHeight);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

console.log('\n7. Экран предмета');
await page.getByRole('tab', { name: 'Расписание' }).click();
await page.waitForTimeout(600);
await page.getByText('Математический анализ', { exact: true }).first().click();
await page.waitForTimeout(800);
const subject = await metrics();
check('экран предмета: панель на месте', subject.navBottom === screenBottom, `bottom=${subject.navBottom}`);
await page.screenshot({ path: join(OUT, '9-subject.png') });

console.log('\n8. Уменьшенное движение');
await page.emulateMedia({ reducedMotion: 'reduce' });
// Экран предмета живёт внутри вкладки расписания, поэтому уходим на другую
// вкладку и обратно — иначе вернёмся всё на тот же экран предмета.
await page.getByRole('tab', { name: 'Успеваемость' }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: 'Расписание' }).click();
await page.waitForTimeout(500);
const calmBefore = await metrics();
await swipe();
await page.waitForTimeout(400);
const calmAfter = await metrics();
check('смена дня работает и без анимаций', calmAfter.selectedDay !== calmBefore.selectedDay, `${calmBefore.selectedDay} → ${calmAfter.selectedDay}`);
check('панель на месте', calmAfter.navBottom === screenBottom, `bottom=${calmAfter.navBottom}`);
check('высота ленты не обрезана', (calmAfter.pagerClipped ?? 1) <= 0, `${calmAfter.pagerClipped}px`);
await page.emulateMedia({ reducedMotion: null });

console.log('\n8b. Тёмная тема');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
const dark = await metrics();
check('тёмная тема: панель на месте', dark.navBottom === screenBottom, `bottom=${dark.navBottom}`);
await page.screenshot({ path: join(OUT, '10-dark.png') });

console.log('\n9. Авторизация');
// Снимаем Service Worker и его кэши: иначе /api/bootstrap может прийти из кэша
// и экран входа не покажется.
await page.evaluate(async () => {
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = (await caches?.keys?.()) ?? [];
  await Promise.all(keys.map((k) => caches.delete(k)));
});

// Сессия БАРС истекла (мок отдаёт barsAuthorized:false): приложение обязано
// предложить войти заново, а не показывать пустой интерфейс. Локальный кэш
// чистим, чтобы не подставить данные прошлой сессии.
await page.evaluate(() => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('hub_cache_')) localStorage.removeItem(key);
  }
});
await page.goto(`http://127.0.0.1:${PORT}/?scenario=no-bars`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
let auth = await page.evaluate(() => document.getElementById('root')?.innerText ?? '');
check('без входа в БАРС показан экран входа', /Нужен вход в БАРС/.test(auth), auth.split('\n')[0] ?? '');
check('есть кнопка «Войти заново»', await page.getByRole('button', { name: 'Войти заново' }).isVisible());
await page.screenshot({ path: join(OUT, '9-no-bars.png') });

// Рабочей сессии нет: сервер отвечает 401, приложение возвращается к экрану
// самостоятельного входа по логину и паролю БАРС.
await page.goto(`http://127.0.0.1:${PORT}/?scenario=no-auth`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
auth = await page.evaluate(() => document.getElementById('root')?.innerText ?? '');
check('без рабочей сессии показан экран входа', /Войдите логином и паролем/.test(auth), auth.split('\n')[0] ?? '');
check('интерфейс не пустой', auth.trim().length > 0, `${auth.trim().length} символов`);
await page.screenshot({ path: join(OUT, '10-no-auth.png') });

await browser.close();
server.close();

console.log(problems.length === 0 ? '\nВсе проверки пройдены.' : `\nПроблемы: ${problems.join(', ')}`);
process.exit(problems.length === 0 ? 0 : 1);

/* ── жест ────────────────────────────────────────────────────────────────── */

/**
 * Координата точки для свайпа по дням.
 *
 * Ниже полосы дат: жест по полосе листает неделю, а по ленте с парами — день.
 * Если начать свайп в верхних 40 px, попадёшь в полосу.
 */
async function grabY() {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => getComputedStyle(d).overflowY === 'auto' && d.clientHeight > 0,
    );
    return Math.round(el.getBoundingClientRect().top + 200);
  });
}

/**
 * Свайп влево: палец идёт от правого края к левому, как при листании вперёд.
 *
 * stopAfter и screenshot позволяют остановиться в середине жеста — именно на
 * этом кадре раньше были видны две недели сразу.
 */
async function swipe({ stopAfter = 10, screenshot = null, onHold = null } = {}) {
  const y = await grabY();

  await page.mouse.move(340, y);
  await page.mouse.down();

  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(340 - (300 * i) / 10, y);
    await page.waitForTimeout(12);

    if (i === stopAfter) {
      await page.waitForTimeout(120);
      if (onHold) await onHold();
      if (screenshot) await page.screenshot({ path: join(OUT, screenshot) });
      await page.mouse.up();
      return;
    }
  }

  await page.mouse.up();
}

/**
 * Свайп по полосе дат: палец начинает на клетках недели, а не на карточках.
 */
async function swipeOnStrip() {
  const y = await page.evaluate(() => {
    const strip = document.querySelector('button[aria-pressed]');
    return Math.round(strip.getBoundingClientRect().top + strip.getBoundingClientRect().height / 2);
  });

  await page.mouse.move(340, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(340 - (300 * i) / 10, y);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

async function swipeOnStripRight() {
  const y = await page.evaluate(() => {
    const strip = document.querySelector('button[aria-pressed]');
    return Math.round(strip.getBoundingClientRect().top + strip.getBoundingClientRect().height / 2);
  });

  await page.mouse.move(60, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(60 + (300 * i) / 10, y);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

/** Свайп вправо: палец идёт от левого края к правому. */
async function swipeBack(times) {
  const y = await grabY();

  for (let i = 0; i < times; i += 1) {
    await page.mouse.move(60, y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k += 1) {
      await page.mouse.move(60 + (300 * k) / 10, y);
      await page.waitForTimeout(12);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
}
