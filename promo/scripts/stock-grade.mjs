import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'dark', isMobile: true, hasTouch: true, permissions: ['notifications'] });
await ctx.addInitScript(({ fixed }) => {
  const RealDate = Date;
  function FakeDate(...args) { if (args.length === 0) return new RealDate(fixed); return new RealDate(...args); }
  FakeDate.now = () => fixed;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = FakeDate;
  try { Object.defineProperty(Notification, 'permission', { get: () => 'granted' }); } catch {}
}, { fixed: Date.parse('2026-11-02T09:30:00+03:00') });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5173/preview/?notif=1', { waitUntil: 'networkidle', timeout: 90000 });
await page.addStyleTag({ content: '#test-badge{display:none!important} button[class*="z-[60]"]{display:none!important}' });
await page.waitForTimeout(1600);
for (let i = 0; i < 3; i += 1) {
  await page.getByText('Закрыть', { exact: true }).last().click();
  await page.waitForTimeout(2600);
}
await page.waitForTimeout(500);
await page.screenshot({ path: 'media/stock/16-notification-grade.png' });
console.log((await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(-260));
await browser.close();
