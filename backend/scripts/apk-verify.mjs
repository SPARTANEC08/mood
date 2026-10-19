/**
 * Проверка собранного APK: подпись, package name и совпадение SHA-256 с
 * assetlinks.json. Расхождение отпечатка = TWA откроется с адресной строкой,
 * поэтому проверка обязательна перед раздачей.
 *
 * apksigner берётся из Android SDK Bubblewrap (~/.bubblewrap/android_sdk) или из
 * PATH/ANDROID_HOME. Если его нет — проверяем отпечаток keystore против
 * assetlinks (подпись APK при этом проверить нельзя, о чём сообщаем честно).
 *
 * Запуск: npm run apk:verify [-- apk/mood-1.0.0.apk]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = path.join(ROOT, '.env');
const KEYSTORE_PATH = path.join(ROOT, 'mood.keystore');
const ASSETLINKS_PATH = path.join(ROOT, 'pwa/public/.well-known/assetlinks.json');
const OUT_DIR = path.join(ROOT, 'apk');

function readEnvFile() {
  const values = {};
  if (!existsSync(ENV_PATH)) return values;
  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/** Ищет инструмент build-tools: ~/.bubblewrap/android_sdk, ANDROID_HOME, PATH. */
function findBuildTool(name) {
  const roots = [
    path.join(os.homedir(), '.bubblewrap/android_sdk/build-tools'),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'build-tools'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'build-tools'),
  ].filter(Boolean);

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(root, version, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

function latestApk() {
  if (!existsSync(OUT_DIR)) return null;
  const files = readdirSync(OUT_DIR).filter((file) => file.endsWith('.apk')).sort();
  return files.length > 0 ? path.join(OUT_DIR, files[files.length - 1]) : null;
}

function main() {
  const explicit = process.argv.slice(2).find((arg) => arg.endsWith('.apk'));
  const apkPath = explicit ? path.resolve(explicit) : latestApk();

  const env = { ...readEnvFile(), ...process.env };
  const storepass = env.APK_KEYSTORE_PASSWORD?.trim();
  const keypass = env.APK_KEY_PASSWORD?.trim() || storepass;
  const alias = env.APK_KEY_ALIAS?.trim() || 'mood';

  if (!storepass) { console.error('❌ APK_KEYSTORE_PASSWORD не найден в .env.'); process.exit(1); }
  if (!existsSync(ASSETLINKS_PATH)) { console.error('❌ assetlinks.json не найден. Запустите npm run apk:assetlinks'); process.exit(1); }

  const assetlinks = JSON.parse(readFileSync(ASSETLINKS_PATH, 'utf-8'));
  const expected = assetlinks[0]?.target?.sha256_cert_fingerprints?.[0];
  const expectedPackage = assetlinks[0]?.target?.package_name;

  // 1. Отпечаток из keystore.
  const keystoreOutput = execFileSync(
    'keytool',
    ['-list', '-v', '-keystore', KEYSTORE_PATH, '-alias', alias, '-storepass', storepass, '-keypass', keypass],
    { encoding: 'utf-8' },
  );
  const keystoreFingerprint = /SHA256:\s*([0-9A-F:]+)/i.exec(keystoreOutput)?.[1]?.toUpperCase();

  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`  ok   ${name}`);
    else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  console.log('=== Проверка APK (TWA) ===\n');
  check('assetlinks SHA-256 совпадает с keystore', expected === keystoreFingerprint, `${expected} vs ${keystoreFingerprint}`);
  check('package в assetlinks', expectedPackage === (env.APK_PACKAGE_ID?.trim() || 'ru.mpei.mood'), String(expectedPackage));

  if (!apkPath || !existsSync(apkPath)) {
    console.log('\n⚠️  APK не найден в apk/ — проверка файла пропущена (сначала npm run apk:build).');
    console.log(`\nОтпечаток keystore: ${keystoreFingerprint}`);
    process.exit(failures > 0 ? 1 : 0);
  }

  console.log(`\nФайл: ${path.relative(ROOT, apkPath)}`);

  // 2. Package name из самого APK (aapt2 dump badging).
  const aapt2 = findBuildTool('aapt2');
  if (aapt2) {
    try {
      const badging = execFileSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf-8' });
      const packageName = /package: name='([^']+)'/.exec(badging)?.[1];
      check(
        'package APK = ru.mpei.mood',
        packageName === (env.APK_PACKAGE_ID?.trim() || 'ru.mpei.mood'),
        String(packageName),
      );
      const versionName = /versionName='([^']*)'/.exec(badging)?.[1];
      check('versionName заполнен', Boolean(versionName), String(versionName));
    } catch (err) {
      check('package APK прочитан', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log('⚠️  aapt2 не найден — package name в APK не проверен.');
  }

  // 3. Подпись и отпечаток.
  const apksigner = findBuildTool('apksigner');
  if (!apksigner) {
    console.log('⚠️  apksigner не найден (нет Android SDK) — подпись файла не проверена.');
    console.log(`   Отпечаток keystore: ${keystoreFingerprint}`);
    process.exit(failures > 0 ? 1 : 0);
  }

  let verifyOutput = '';
  try {
    verifyOutput = execFileSync(apksigner, ['verify', '--print-certs', apkPath], { encoding: 'utf-8' });
    check('подпись APK валидна', true);
  } catch (err) {
    check('подпись APK валидна', false, err instanceof Error ? err.message : String(err));
  }

  // apksigner печатает digest в виде "Signer #1 certificate SHA-256 digest: ab12..."
  const apkDigest = /SHA-256 digest:\s*([0-9a-f]+)/i.exec(verifyOutput)?.[1]?.toUpperCase();
  const apkColon = apkDigest?.replace(/(..)(?=.)/g, '$1:');

  check(
    'отпечаток APK совпадает с assetlinks',
    Boolean(apkColon) && apkColon === expected,
    `${apkColon} vs ${expected}`,
  );

  console.log(failures > 0 ? '\n❌ Есть проблемы — APK раздавать нельзя.' : '\n✅ APK подписан и совпадает с assetlinks.json.');
  process.exit(failures > 0 ? 1 : 0);
}

main();
