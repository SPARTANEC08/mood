/**
 * Тесты антибрутфорс-лимитера входа.
 *
 * Проверяются обе оси (владелец и логин), рост блокировки и потолок. Состояние
 * в памяти процесса, поэтому тест начинается с resetLoginLimiter — иначе он
 * зависел бы от других тестов в этом же файле.
 *
 * Запуск: npm run test:login-limiter
 */

import {
  checkLoginAllowed,
  formatRetryAfter,
  registerLoginFailure,
  registerLoginSuccess,
  resetLoginLimiter,
} from '../utils/loginLimiter.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

const MIN = 60 * 1000;

console.log('====================================================');
console.log('   ТЕСТЫ ЛИМИТЕРА ВХОДА');
console.log('====================================================');

section('Порог 5 неудач');
{
  resetLoginLimiter();
  check('сначала вход разрешён', !checkLoginAllowed('owner-1', 'st100').blocked);

  for (let i = 1; i <= 4; i += 1) {
    const state = registerLoginFailure('owner-1', 'st100');
    check(`после ${i} неудач блокировки нет`, !state.blocked, JSON.stringify(state));
  }

  const fifth = registerLoginFailure('owner-1', 'st100');
  check('пятая неудача блокирует', fifth.blocked);
  check('пауза ≈15 минут', fifth.retryAfterMs >= 15 * MIN - 1000 && fifth.retryAfterMs <= 15 * MIN + 1000, String(fifth.retryAfterMs));

  const nowBlocked = checkLoginAllowed('owner-1', 'st100');
  check('повторная проверка видит блок', nowBlocked.blocked && nowBlocked.retryAfterMs > 0);
}

section('Успех сбрасывает счётчики');
{
  resetLoginLimiter();
  registerLoginFailure('owner-2', 'st200');
  registerLoginFailure('owner-2', 'st200');
  registerLoginSuccess('owner-2', 'st200');
  check('после успеха вход разрешён', !checkLoginAllowed('owner-2', 'st200').blocked);

  // После сброса отсчёт начинается заново: 4 неудачи ещё не блокируют,
  // пятая — блокирует. Если бы счётчик не сбросился, блок случился бы раньше.
  let blockedTooEarly = false;
  for (let i = 1; i <= 4; i += 1) {
    if (registerLoginFailure('owner-2', 'st200').blocked) blockedTooEarly = true;
  }
  check('4 неудачи после сброса не блокируют', !blockedTooEarly);
  check('пятая после сброса блокирует', registerLoginFailure('owner-2', 'st200').blocked);
}

section('Ось логина: разные владельцы, один логин');
{
  resetLoginLimiter();
  for (let i = 1; i <= 5; i += 1) {
    registerLoginFailure(`owner-${i}`, 'common-login');
  }

  const freshOwner = checkLoginAllowed('owner-99', 'common-login');
  check('новый владелец с тем же логином заблокирован', freshOwner.blocked, JSON.stringify(freshOwner));
  check('другой логин нового владельца свободен', !checkLoginAllowed('owner-99', 'other-login').blocked);
}

section('Рост блокировки и потолок 6 часов');
{
  resetLoginLimiter();
  const blocks: number[] = [];

  for (let strike = 1; strike <= 6; strike += 1) {
    for (let i = 1; i <= 5; i += 1) registerLoginFailure('grow-owner', 'grow-login');
    const state = checkLoginAllowed('grow-owner', 'grow-login');
    blocks.push(state.retryAfterMs);
  }

  check('первая пауза 15 минут', blocks[0]! >= 15 * MIN - 1000 && blocks[0]! <= 15 * MIN + 1000, String(blocks[0]));
  check('вторая пауза 30 минут', blocks[1]! >= 30 * MIN - 1000 && blocks[1]! <= 30 * MIN + 1000, String(blocks[1]));
  check('паузы не убывают', blocks.every((value, index) => index === 0 || value >= blocks[index - 1]!), JSON.stringify(blocks));
  check('потолок 6 часов', blocks[blocks.length - 1]! <= 6 * 60 * MIN, String(blocks[blocks.length - 1]));
  check('потолок достигнут', blocks[blocks.length - 1]! >= 6 * 60 * MIN - 1000, String(blocks[blocks.length - 1]));
}

section('Человекочитаемая пауза');
{
  check('1 минута', formatRetryAfter(MIN) === '1 минуту', formatRetryAfter(MIN));
  check('2 минуты', formatRetryAfter(2 * MIN) === '2 минуты', formatRetryAfter(2 * MIN));
  check('5 минут', formatRetryAfter(5 * MIN) === '5 минут', formatRetryAfter(5 * MIN));
  check('11 минут (не «11 минуту»)', formatRetryAfter(11 * MIN) === '11 минут', formatRetryAfter(11 * MIN));
  check('21 минута', formatRetryAfter(21 * MIN) === '21 минуту', formatRetryAfter(21 * MIN));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
