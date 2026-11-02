import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'dark', isMobile: true, hasTouch: true, permissions: ['notifications'] });
const page = await ctx.newPage();
await page.addInitScript(({ fixed }) => {
  const RealDate = Date;
  function FakeDate(...args) { if (args.length === 0) return new RealDate(fixed); return new RealDate(...args); }
  FakeDate.now = () => fixed;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = FakeDate;
  try { Object.defineProperty(Notification, 'permission', { get: () => 'granted' }); } catch {}
}, { fixed: Date.parse('2026-11-02T09:30:00+03:00') });

async function open() {
  await page.goto('https://mood-app.ru/preview/', { waitUntil: 'networkidle', timeout: 90000 });
  await page.addStyleTag({ content: '#test-badge{display:none!important} button[class*="z-[60]"]{display:none!important}' });
  await page.waitForTimeout(1800);
}
async function shot(name) { await page.waitForTimeout(400); await page.screenshot({ path: `media/stock/${name}.png` }); console.log('shot', name); }

await open();
await page.locator('button[aria-label="Успеваемость"]').click();
await page.waitForTimeout(900);
await page.getByText('Математический анализ', { exact: true }).last().click();
await page.waitForTimeout(600);
await page.mouse.move(195, 600);
await page.mouse.wheel(0, 700);
await page.waitForTimeout(600);
await shot('05b-grades-km-list');

await open();
await page.locator('button[aria-label="Кабинет"]').click();
await page.waitForTimeout(800);
await page.getByText('Приказы', { exact: true }).click();
await page.waitForTimeout(500);
await shot('18-profile-orders');
await page.getByText('Библиотека НТБ', { exact: true }).click();
await page.waitForTimeout(500);
await shot('19-profile-library');

await browser.close();
