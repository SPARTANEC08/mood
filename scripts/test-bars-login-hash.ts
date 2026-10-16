/**
 * Проверка ключа связи между ботом и PWA — sha256 от логина БАРС.
 *
 * Это самая важная функция во всей схеме идентичности: по ней один и тот же
 * человек узнаёт себя при входе в бота и в PWA. Ошибка в ней незаметна и
 * разрушительна — человек просто видит пустое приложение и думает, что его ДЗ
 * пропали, поэтому проверка живёт отдельно и проверяет границы.
 *
 * Что проверяется:
 *  - нормализация: регистр и пробелы не создают нового человека;
 *  - стабильность: один и тот же логин всегда даёт один и тот же хэш;
 *  - формат: 64 hex-символа (как ждёт индекс в users.json);
 *  - необратимость: хэш не содержит логин и не декодируется обратно;
 *  - разные логины не сходятся (нет коллизий на типовых фамилиях).
 *
 * Сеть не используется: BarsClient и БАРС тут ни при чём.
 *
 * Запуск: npm run test:bars-login-hash
 */

import { computeBarsLoginHash, normalizeBarsLogin } from '../src/utils/barsLoginHash.ts';

let failed = 0;
let passed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

function checkEqual(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected);
  if (actual !== expected) {
    console.error(`       получено: ${String(actual)}`);
    console.error(`       ожидалось: ${String(expected)}`);
  }
}

console.log('\n=== barsLoginHash: ключ связи бота и PWA ===\n');

// ── формат ────────────────────────────────────────────────────────────────────
const base = computeBarsLoginHash('st123456');
check('64 hex-символа', /^[0-9a-f]{64}$/.test(base));
check('не пустая строка', base.length === 64);
check('тот же логин — тот же хэш', computeBarsLoginHash('st123456') === base);

// ── нормализация ──────────────────────────────────────────────────────────────
// Именно здесь чаще всего и ломается связка: человек в боте набирает «Ivanov»,
// в PWA — «ivanov », и без нормализации это два разных аккаунта.
check('разный регистр', computeBarsLoginHash('IVANOV') === computeBarsLoginHash('ivanov'));
check('пробелы по краям', computeBarsLoginHash('  ivanov  ') === computeBarsLoginHash('ivanov'));
check('смешанный регистр с пробелами', computeBarsLoginHash(' IvaNov ') === computeBarsLoginHash('ivanov'));
checkEqual('нормализованный вид', normalizeBarsLogin('  IvaNov  '), 'ivanov');
check('нормализация не меняет семантику пустого ввода', normalizeBarsLogin('   ') === '');

// ── уникальность ──────────────────────────────────────────────────────────────
const logins = ['ivanov', 'ivanov1', 'ivanova', 'petrov', 'sidorov', 'ab', 'ba', 'a', ''];
const hashes = logins.map((l) => computeBarsLoginHash(l));

check('разные логины дают разные хэши', new Set(hashes).size === hashes.length);
check('пустой логин тоже даёт хэш (не исключение)', computeBarsLoginHash('') !== base);

// ── необратимость ─────────────────────────────────────────────────────────────
check('логин не виден в хэше', !base.includes('st123456'));
check(
  'хэш не декодируется в логин',
  Buffer.from(base, 'hex').toString('utf-8') !== 'st123456',
);
check('хэш не содержит исходную строку даже частично', !base.includes('123456'));

// ── известное значение ────────────────────────────────────────────────────────
// Фиксированный вектор: если реализация сменится, тест заметит сразу. Пустая
// строка — самый простой вход, для которого результат можно посчитать руками.
checkEqual(
  'sha256 от пустой строки',
  computeBarsLoginHash(''),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
);

console.log(`\n${failed === 0 ? '✅' : '❌'} barsLoginHash: ${passed} ok, ${failed} ошибок\n`);
process.exit(failed === 0 ? 0 : 1);
