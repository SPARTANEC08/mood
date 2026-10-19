/**
 * Сборка подписанного APK через Bubblewrap.
 *
 * Запускать ТОЛЬКО когда меняется сам APK: имя, иконка, тема, start_url,
 * applicationId или keystore. Любые изменения PWA-кода/контента/стилей в APK не
 * требуют — они подхватываются при следующем запуске приложения (TWA грузит
 * сайт с сервера).
 *
 * Пароли keystore Bubblewrap спрашивает интерактивно: возьмите их из .env
 * (APK_KEYSTORE_PASSWORD / APK_KEY_PASSWORD). Первый запуск скачает JDK и
 * Android SDK — это разовая операция.
 *
 * Запуск: npm run apk:build
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ANDROID_DIR = path.join(ROOT, 'android');
const MANIFEST_PATH = path.join(ANDROID_DIR, 'twa-manifest.json');
const OUT_DIR = path.join(ROOT, 'apk');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readEnvFile() {
  const values = {};
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function main() {
  if (!existsSync(MANIFEST_PATH)) fail('android/twa-manifest.json не найден. Сначала: npm run apk:init');
  if (!existsSync(path.join(ROOT, 'mood.keystore'))) fail('mood.keystore не найден. Сначала: npm run apk:keystore');

  // Bubblewrap умеет брать пароли из окружения — значит сборка неинтерактивна.
  // Имена BUBBLEWRAP_* его собственные; наши секреты лежат в APK_*.
  const env = { ...readEnvFile(), ...process.env };
  const storepass = env.APK_KEYSTORE_PASSWORD?.trim();
  const keypass = env.APK_KEY_PASSWORD?.trim() || storepass;
  if (!storepass) fail('APK_KEYSTORE_PASSWORD не найден в .env. Сначала: npm run apk:keystore');

  console.log('[apk] bubblewrap build (первый запуск может скачать JDK/SDK)...');
  const result = spawnSync('npx', ['--yes', '@bubblewrap/cli', 'build', '--skipPwaValidation'], {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      BUBBLEWRAP_KEYSTORE_PASSWORD: storepass,
      BUBBLEWRAP_KEY_PASSWORD: keypass,
    },
  });

  if (result.status !== 0) fail(`bubblewrap build завершился с кодом ${result.status}`);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  // Поле называется appVersion (см. apk-init.mjs): appVersionName Bubblewrap
  // игнорирует, и versionName в APK остаётся пустым.
  const version = manifest.appVersion || '1.0.0';
  const candidates = [
    path.join(ANDROID_DIR, 'app-release-signed.apk'),
    path.join(ANDROID_DIR, 'app/build/outputs/apk/release/app-release-signed.apk'),
  ];

  const built = candidates.find((file) => existsSync(file));
  if (!built) {
    console.warn('⚠️  APK собран, но файл не найден по ожидаемым путям. Проверьте вывод Bubblewrap.');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, `mood-${version}.apk`);
  copyFileSync(built, target);

  console.log(`\n✅ APK готов: ${path.relative(ROOT, target)}`);
  console.log('   Проверка подписи и отпечатка: npm run apk:verify');
}

main();
