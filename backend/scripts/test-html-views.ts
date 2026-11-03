/**
 * Экраны бота поддержки: ссылки, установка, отсутствие лишнего.
 *
 * Бот больше не дублирует инструкции: он отправляет на лендинг, в раздел
 * «Установка», а на Android даёт кнопку с постом последней версии APK.
 *
 * Запуск: npm run test:html
 */

process.env.PWA_URL = 'https://example.test';
delete process.env.TELEGRAM_APK_POST_URL;

const {
  buildWelcomeView,
  buildIosGuideView,
  buildAndroidGuideView,
  getApkPostUrl,
  CHANNEL_URL,
  DEFAULT_APK_POST_URL,
  GITHUB_URL,
  SUPPORT_URL,
} = await import('../../tg/pwaView.ts');

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

check(
  'приветствие ведёт на установку',
  welcomeButtons.some((b) => b.url === 'https://example.test/#install'),
);
check('приветствие содержит канал', welcomeButtons.some((b) => b.url === CHANNEL_URL));
check('приветствие содержит поддержку', welcomeButtons.some((b) => b.url === SUPPORT_URL));
check('приветствие содержит GitHub', welcomeButtons.some((b) => b.url === GITHUB_URL));
check(
  'есть кнопки платформ',
  welcomeButtons.some((b) => b.callback_data === 'platform_ios') &&
    welcomeButtons.some((b) => b.callback_data === 'platform_android'),
);
check('в приветствии нет длинной инструкции', !/Safari|экран Домой/.test(welcome.text));
check('в приветствии нет дубля поддержки', !welcome.text.includes('@mood_mpei_sup'));
check('нет привязки Telegram', !JSON.stringify(welcome).includes('start='));
check('нет админки', !JSON.stringify(welcome).includes('admin'));

const ios = buildIosGuideView();
const iosButtons = flatLinks(ios);
check('iOS: отправляет на сайт', /сайт/i.test(ios.text) && /инструкц/i.test(ios.text));
check('iOS: ссылка на раздел установки', iosButtons.some((b) => b.url === 'https://example.test/#install'));
check('iOS: есть возврат в меню', iosButtons.some((b) => b.callback_data === 'menu_back'));
check('iOS: без привязки Telegram', !/Подключить уведомления в Telegram/.test(ios.text));

const android = buildAndroidGuideView();
const androidButtons = flatLinks(android);
check('Android: отправляет на сайт', /сайт/i.test(android.text) && /инструкц/i.test(android.text));
check('Android: ссылка на раздел установки', androidButtons.some((b) => b.url === 'https://example.test/#install'));
check('Android: кнопка поста с APK', androidButtons.some((b) => b.url === DEFAULT_APK_POST_URL));
check('Android: есть возврат в меню', androidButtons.some((b) => b.callback_data === 'menu_back'));
check('Android: бот не отправляет файл', !('document' in android));
check('Android: без привязки Telegram', !/Подключить уведомления в Telegram/.test(android.text));

check('пост APK по умолчанию', getApkPostUrl() === 'https://t.me/mood_mpei/15');
process.env.TELEGRAM_APK_POST_URL = 'https://t.me/mood_mpei/99';
check('пост APK из окружения', getApkPostUrl() === 'https://t.me/mood_mpei/99');
process.env.TELEGRAM_APK_POST_URL = 'ftp://example.test/file';
check('невалидный пост APK игнорируется', getApkPostUrl() === DEFAULT_APK_POST_URL);
delete process.env.TELEGRAM_APK_POST_URL;

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
