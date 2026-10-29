#!/usr/bin/env node
/**
 * Проверяет, что бот действительно отделён от приложения.
 *
 * Бот собирается самостоятельным бандлом (`dist/bot.js`), поэтому в нём не
 * должно быть ни драйвера БД, ни ключей шифрования, ни кода API. Если кто-то
 * снова импортирует серверный модуль в `tg/`, проверка это поймает — иначе
 * «изолированный» бот тихо потащил бы за собой весь backend.
 *
 * Запуск: npm run build && npm run check:bot
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.resolve(root, 'dist', 'bot.js');

if (!fs.existsSync(bundlePath)) {
  console.error('[check:bot] dist/bot.js не найден — сначала npm run build:bot');
  process.exit(1);
}

const code = fs.readFileSync(bundlePath, 'utf8');

/**
 * Строки, которых в боте быть не должно.
 *
 * Это не «стиль», а граница приватности: всё перечисленное означает доступ к
 * персональным данным или к инфраструктуре приложения.
 */
const forbidden = [
  ['better-sqlite3', 'драйвер базы данных'],
  ['mood.sqlite', 'файл базы данных'],
  ['ENCRYPTION_SECRET_KEY', 'ключ шифрования кредов БАРС'],
  ['PWA_AUTH_SECRET', 'секрет PWA-токенов'],
  ['VAPID_PRIVATE_KEY', 'приватный ключ Web Push'],
  ['startNotifier', 'фоновый нотификатор'],
  ['startDailyReport', 'ночной отчёт'],
  ['startMaintenance', 'уборка диска'],
  ['Fastify', 'HTTP API'],
];

const failures = [];

for (const [needle, why] of forbidden) {
  if (code.includes(needle)) {
    failures.push(`найдено «${needle}» — это ${why}`);
  }
}

// Относительные импорты серверных модулей допустимы только в исходниках;
// в бандле их быть не должно вовсе.
const backendImport = /from\s*["'](?:\.\.\/)*(?:backend|db)\//;
for (const line of code.split('\n')) {
  if (backendImport.test(line)) failures.push(`импорт серверного модуля: ${line.trim()}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(`\n[check:bot] провалено проверок: ${failures.length}`);
  process.exit(1);
}

const sizeKb = (fs.statSync(bundlePath).size / 1024).toFixed(0);
console.log(`[check:bot] ok: ${path.relative(root, bundlePath)} (${sizeKb} КБ), серверных модулей нет.`);
