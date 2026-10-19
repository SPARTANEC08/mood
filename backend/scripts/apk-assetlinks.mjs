/**
 * Сборка pwa/public/.well-known/assetlinks.json из keystore.
 *
 * Digital Asset Links — то, чем Android проверяет, что APK принадлежит домену.
 * Без корректного файла (и без Content-Type: application/json) TWA откроется
 * С АДРЕСНОЙ СТРОКОЙ, то есть как обычная вкладка.
 *
 * Отпечаток НЕ хардкодится: берётся из mood.keystore через keytool. При
 * перегенерации ключа достаточно повторить `npm run apk:assetlinks` — файл
 * обновится сам. Ручная правка SHA-256 запрещена: опечатка или старый отпечаток
 * здесь — тихая поломка верификации, которую видно только на устройстве.
 *
 * Запуск: npm run apk:assetlinks
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = path.join(ROOT, '.env');
const KEYSTORE_PATH = path.join(ROOT, 'mood.keystore');
const OUTPUT_DIR = path.join(ROOT, 'pwa/public/.well-known');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'assetlinks.json');

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

  if (!existsSync(KEYSTORE_PATH)) {
    console.error('❌ mood.keystore не найден. Сначала: npm run apk:keystore');
    process.exit(1);
  }

  const storepass = env.APK_KEYSTORE_PASSWORD?.trim();
  const keypass = env.APK_KEY_PASSWORD?.trim() || storepass;
  const alias = env.APK_KEY_ALIAS?.trim() || 'mood';
  const packageId = env.APK_PACKAGE_ID?.trim() || 'ru.mpei.mood';

  if (!storepass) {
    console.error('❌ APK_KEYSTORE_PASSWORD не найден в .env.');
    process.exit(1);
  }

  const output = execFileSync(
    'keytool',
    ['-list', '-v', '-keystore', KEYSTORE_PATH, '-alias', alias, '-storepass', storepass, '-keypass', keypass],
    { encoding: 'utf-8' },
  );

  const match = /SHA256:\s*([0-9A-F:]+)/i.exec(output);
  if (!match) {
    console.error('❌ keytool не вернул SHA256 отпечаток.');
    process.exit(1);
  }
  const fingerprintSha256 = match[1].toUpperCase();

  // Формат строго по спецификации Digital Asset Links: массив relation/target,
  // отпечаток — hex в верхнем регистре с двоеточиями.
  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageId,
        sha256_cert_fingerprints: [fingerprintSha256],
      },
    },
  ];

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(assetlinks, null, 2)}\n`);

  console.log('✅ assetlinks.json собран из keystore:');
  console.log(`   package: ${packageId}`);
  console.log(`   SHA-256: ${fingerprintSha256}`);
  console.log(`   файл:    ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main();
