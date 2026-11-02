import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const OUT = 'stock';
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

const FIXED = Date.parse('2026-11-02T09:30:00+03:00');
await page.addInitScript(({ fixed }) => {
  const RealDate = Date;
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(fixed);
    return new RealDate(...args);
  }
  FakeDate.now = () => fixed;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = FakeDate;
}, { fixed: FIXED });

async function open(query = '') {
  await page.goto(`https://mood-app.ru/preview/${query}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.addStyleTag({ content: '#test-badge{display:none!important} button[class*="z-[60]"]{display:none!important}' });
  await page.waitForTimeout(1800);
}

async function shot(name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}

async function safe(name, fn) {
  try { await fn(); await shot(name); }
  catch (e) { console.log('FAIL', name, String(e.message).slice(0, 140)); }
}

await open();
await shot('01-schedule');

await safe('02-calendar', async () => {
  await page.locator('button[aria-label="Открыть календарь"]').click();
});
await open();

await safe('03-subject', async () => {
  await page.getByText('Физика', { exact: true }).first().click();
});

await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(900);
await shot('04-grades');

await safe('05-grades-expanded', async () => {
  await page.getByText('Математический анализ', { exact: true }).last().click();
});

await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(800);
await safe('06-debts', async () => { await page.getByText('Задолженности', { exact: true }).click(); });
await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(800);
await safe('07-rating', async () => { await page.getByText('Рейтинг', { exact: true }).click(); });
await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(800);
await safe('08-attendance', async () => { await page.getByText('Пропущено пар', { exact: true }).click(); });

await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(800);
await safe('09-calculator', async () => { await page.getByText('Калькулятор оценок', { exact: true }).click(); await page.waitForTimeout(700); });
await safe('10-calculator-plan', async () => {
  await page.locator('[role="dialog"]').first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
});

await open();
await page.locator('button[aria-label="Задания"]').click();
await page.waitForTimeout(900);
await shot('11-tasks');
await safe('12-important', async () => { await page.getByText('Важное', { exact: true }).click(); });

await open();
await page.locator('button[aria-label="Кабинет"]').click();
await page.waitForTimeout(900);
await shot('13-profile');
await safe('14-scholarship', async () => { await page.getByText('Стипендии', { exact: true }).click(); });

await open();
await page.locator('button[aria-label="Добавить задание или объявление"]').click();
await page.waitForTimeout(900);
await shot('17-add-sheet');

await browser.close();
