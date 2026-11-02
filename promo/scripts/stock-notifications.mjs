import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'dark', isMobile: true, hasTouch: true });
const page = await ctx.newPage();

async function open(query = '') {
  await page.goto(`https://mood-app.ru/preview/${query}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.addStyleTag({ content: '#test-badge{display:none!important} button[class*="z-[60]"]{display:none!important}' });
  await page.waitForTimeout(1800);
}

await open();
await page.locator('button[aria-label="Уведомления"]').click();
await page.waitForTimeout(1400);
await page.screenshot({ path: 'media/stock/15-notifications.png' });
console.log('center top');
await page.mouse.move(195, 600);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(600);
await page.screenshot({ path: 'media/stock/15b-notifications-bottom.png' });
console.log('center bottom');

await open('?notif=1');
await page.waitForTimeout(1600);
for (let i = 1; i <= 4; i += 1) {
  await page.screenshot({ path: `media/stock/16-notification-${i}.png` });
  console.log('notification', i, (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 160));
  const close = page.getByText('Закрыть', { exact: true }).last();
  if (!(await close.count())) break;
  await close.click();
  await page.waitForTimeout(2600);
}

await browser.close();
