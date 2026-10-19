/**
 * Инициализация TWA-проекта: android/twa-manifest.json из .env и манифеста PWA.
 *
 * Почему своим скриптом, а не `bubblewrap init`: интерактивные вопросы Bubblewrap
 * нельзя воспроизвести, а конфиг должен быть в git и одинаковым у всех. Мы
 * держим источником правды android/twa-manifest.json; сам Gradle-проект Bubblewrap
 * разворачивает из него при `apk:build`.
 *
 * Идемпотентно: существующий twa-manifest.json не перезаписывается без --force.
 *
 * Запуск: npm run apk:init [-- --force]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = path.join(ROOT, '.env');
const ANDROID_DIR = path.join(ROOT, 'android');
const MANIFEST_PATH = path.join(ANDROID_DIR, 'twa-manifest.json');

function readEnvFile() {
  const values = {};
  if (!existsSync(ENV_PATH)) return values;

  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function main() {
  const env = { ...readEnvFile(), ...process.env };
  const force = process.argv.includes('--force');

  const pwaUrl = env.PWA_URL?.trim();
  if (!pwaUrl) {
    console.error('❌ PWA_URL не задан в .env — без домена TWA собрать нельзя.');
    process.exit(1);
  }

  const host = new URL(pwaUrl).host;
  const packageId = env.APK_PACKAGE_ID?.trim() || 'ru.mpei.mood';
  const alias = env.APK_KEY_ALIAS?.trim() || 'mood';

  if (!existsSync(path.join(ROOT, 'mood.keystore'))) {
    console.error('❌ mood.keystore не найден. Сначала: npm run apk:keystore');
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, 'pwa/public/.well-known/assetlinks.json'))) {
    console.error('❌ assetlinks.json не найден. Сначала: npm run apk:assetlinks');
    process.exit(1);
  }

  if (existsSync(MANIFEST_PATH) && !force) {
    console.log('✅ android/twa-manifest.json уже есть — не перезаписываю (--force чтобы обновить).');
    return;
  }

  const manifest = {
    packageId,
    host,
    name: 'Mood — расписание МЭИ',
    launcherName: 'Mood',
    display: 'standalone',
    themeColor: '#15131E',
    themeColorDark: '#15131E',
    navigationColor: '#15131E',
    navigationColorDark: '#15131E',
    navigationDividerColor: '#15131E',
    navigationDividerColorDark: '#15131E',
    backgroundColor: '#15131E',
    // Push через TWA не нужен: уведомления идут из Telegram-бота.
    enableNotifications: false,
    startUrl: '/',
    iconUrl: `${pwaUrl.replace(/\/$/, '')}/icons/icon-512.png?v=2`,
    maskableIconUrl: `${pwaUrl.replace(/\/$/, '')}/icons/icon-maskable-512.png?v=2`,
    splashScreenFadeOutDuration: 300,
    signingKey: { path: '../mood.keystore', alias },
    // В twa-manifest.json поле называется appVersion: Bubblewrap читает именно
    // его (`data.appVersion`), а appVersionName молча игнорирует — тогда
    // versionName в APK оказывается пустым.
    appVersion: '1.0.0',
    // Для сайдлоада версия не важна (обновление поверх проходит по подписи), но
    // при будущей публикации в Play её нужно увеличивать при каждом релизе.
    appVersionCode: 1,
    shortcuts: [],
    webManifestUrl: `${pwaUrl.replace(/\/$/, '')}/manifest.webmanifest`,
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: `${pwaUrl.replace(/\/$/, '')}/`,
    // 24 (Android 7.0) — минимум библиотеки androidbrowserhelper 2.7.4.
    // С 21 сборка падает на manifest merger: uses-sdk 21 < 24.
    minSdkVersion: 24,
    orientation: 'portrait',
    fingerprints: [],
    additionalTrustedOrigins: [],
    retainedBundles: [],
  };

  mkdirSync(ANDROID_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('✅ android/twa-manifest.json создан:');
  console.log(`   package: ${packageId}`);
  console.log(`   host:    ${host}`);
  console.log(`   key:     mood.keystore (alias ${alias})`);
  console.log('\nДальше: npm run apk:build');
}

main();
