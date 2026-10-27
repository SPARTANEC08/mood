/**
 * Экраны бота поддержки: ссылки, установка, отсутствие лишнего.
 *
 * Полноценный HTML-аудит старых клиентских экранов больше не нужен: бот
 * показывает только три экрана — приветствие и две инструкции установки.
 *
 * Запуск: npm run test:html
 */

process.env.PWA_URL = 'https://example.test';

const { buildWelcomeView, buildIosGuideView, buildAndroidGuideView, CHANNEL_URL, GITHUB_URL, SUPPORT_URL } =
  await import('../../tg/pwaView.ts');

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function flatLinks(view: { keyboard: Array<Array<{ url?: string; callback_data?: string }>> }) {
  return view.keyboard.flat();
}

console.log('\n=== Экраны бота поддержки ===\n');

const welcome = buildWelcomeView();
const welcomeButtons = flatLinks(welcome);

check('приветствие содержит ссылку на PWA', welcomeButtons.some((b) => b.url === 'https://example.test'));
check('приветствие содержит канал', welcomeButtons.some((b) => b.url === CHANNEL_URL));
check('приветствие содержит поддержку', welcomeButtons.some((b) => b.url === SUPPORT_URL));
check('приветствие содержит GitHub', welcomeButtons.some((b) => b.url === GITHUB_URL));
check('есть кнопки платформ', welcomeButtons.some((b) => b.callback_data === 'platform_ios') && welcomeButtons.some((b) => b.callback_data === 'platform_android'));
check('нет привязки Telegram', !JSON.stringify(welcome).includes('start='));
check('нет админки', !JSON.stringify(welcome).includes('admin'));

const ios = buildIosGuideView();
check('iOS: Safari и экран Домой', /Safari/.test(ios.text) && /экран Домой/.test(ios.text));
check('iOS: без привязки Telegram', !/Подключить уведомления в Telegram/.test(ios.text));
check('iOS: ссылка на PWA', flatLinks(ios).some((b) => b.url === 'https://example.test'));

const android = buildAndroidGuideView();
check('Android: APK или PWA', /APK/.test(android.text) && /PWA/.test(android.text));
check('Android: без привязки Telegram', !/Подключить уведомления в Telegram/.test(android.text));

for (const [name, view] of [
  ['welcome', welcome],
  ['ios', ios],
  ['android', android],
] as const) {
  check(`${name}: есть клавиатура`, view.keyboard.length > 0);
  check(`${name}: нет пустых рядов`, view.keyboard.every((row) => row.length > 0));
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалов: ${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
