/**
 * Генерация keystore для подписи APK (TWA).
 *
 * Идемпотентно: если mood.keystore уже есть, ключ НЕ перегенерируется — только
 * печатается SHA-256 отпечаток. Перегенерация сменила бы подпись, и новый APK
 * встал бы как другое приложение (обновить поверх установленного нельзя).
 *
 * Пароли берутся из .env (APK_KEYSTORE_PASSWORD / APK_KEY_PASSWORD). Если их
 * там нет, скрипт генерирует случайные и ДОПИСЫВАЕТ в .env — файл в .gitignore,
 * наружу секрет не уходит. Ручной ввод не нужен, поэтому сборка воспроизводима.
 *
 * Запуск: npm run apk:keystore
 *
 * ВНИМАНИЕ: сделайте бэкап mood.keystore и паролей в защищённое место. Без них
 * выпустить обновление поверх установленного приложения невозможно.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = path.join(ROOT, '.env');
const KEYSTORE_PATH = path.join(ROOT, 'mood.keystore');

const ALIAS = process.env.APK_KEY_ALIAS?.trim() || 'mood';

/** Простой разбор .env: строки KEY=VALUE, без кавычек и экспорта (как в проекте). */
function readEnvFile() {
  const values = {};
  if (!existsSync(ENV_PATH)) return values;

  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function appendEnv(key, value) {
  const prefix = existsSync(ENV_PATH) && !readFileSync(ENV_PATH, 'utf-8').endsWith('\n') ? '\n' : '';
  appendFileSync(ENV_PATH, `${prefix}\n# Добавлено apk:keystore. Бэкап обязателен.\n${key}=${value}\n`);
}

/** SHA-256 отпечаток сертификата из keystore (hex с двоеточиями, как в assetlinks). */
function fingerprint(storepass, keypass) {
  const output = execFileSync(
    'keytool',
    ['-list', '-v', '-keystore', KEYSTORE_PATH, '-alias', ALIAS, '-storepass', storepass, '-keypass', keypass],
    { encoding: 'utf-8' },
  );

  const match = /SHA256:\s*([0-9A-F:]+)/i.exec(output);
  if (!match) throw new Error('keytool не вернул SHA256 — проверьте alias и пароль.');
  return match[1].toUpperCase();
}

function main() {
  const env = { ...readEnvFile(), ...process.env };

  let storepass = env.APK_KEYSTORE_PASSWORD?.trim();
  let keypass = env.APK_KEY_PASSWORD?.trim();

  if (existsSync(KEYSTORE_PATH)) {
    if (!storepass) {
      console.error('❌ mood.keystore есть, но APK_KEYSTORE_PASSWORD не найден в .env.');
      console.error('   Восстановите пароль из бэкапа — без него собрать APK нельзя.');
      process.exit(1);
    }
    console.log('✅ mood.keystore уже существует — НЕ перегенерирую (смена ключа ломает обновления).');
    console.log(`   alias:   ${ALIAS}`);
    console.log(`   SHA-256: ${fingerprint(storepass, keypass || storepass)}`);
    return;
  }

  let generated = false;
  if (!storepass) {
    storepass = randomBytes(24).toString('base64url');
    appendEnv('APK_KEYSTORE_PASSWORD', storepass);
    generated = true;
  }
  if (!keypass) {
    keypass = storepass;
    appendEnv('APK_KEY_PASSWORD', keypass);
    generated = true;
  }
  if (!env.APK_KEY_ALIAS) appendEnv('APK_KEY_ALIAS', ALIAS);
  if (!env.APK_PACKAGE_ID) appendEnv('APK_PACKAGE_ID', 'ru.mpei.mood');

  execFileSync(
    'keytool',
    [
      '-genkeypair', '-v',
      '-keystore', KEYSTORE_PATH,
      '-alias', ALIAS,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-storepass', storepass,
      '-keypass', keypass,
      '-dname', 'CN=Mood, OU=MPEI, O=Mood, L=Moscow, ST=Moscow, C=RU',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  console.log(`✅ Создан mood.keystore${generated ? ' (пароли дописаны в .env)' : ''}.`);
  console.log(`   alias:   ${ALIAS}`);
  console.log(`   SHA-256: ${fingerprint(storepass, keypass)}`);
  console.log('\n⚠️  Сделайте бэкап mood.keystore и паролей (APK_KEYSTORE_PASSWORD, APK_KEY_PASSWORD).');
  console.log('   Потеря ключа = новый APK встанет как другое приложение.');
}

main();
