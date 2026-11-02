import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'dark', isMobile: true, hasTouch: true, permissions: ['notifications'] });
const page = await ctx.newPage();
await page.addInitScript(() => {
  try { Object.defineProperty(Notification, 'permission', { get: () => 'granted' }); } catch {}
});
await page.goto('https://mood-app.ru/preview/', { waitUntil: 'networkidle', timeout: 90000 });
await page.addStyleTag({ content: '#test-badge{display:none!important} button[class*="z-[60]"]{display:none!important}' });
await page.waitForTimeout(1800);
await page.locator('button[aria-label="Кабинет"]').click();
await page.waitForTimeout(1000);
await page.screenshot({ path: 'media/stock/13-profile.png' });
await page.getByText('Стипендии', { exact: true }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'media/stock/14-scholarship.png' });
console.log((await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 400));
await browser.close();
