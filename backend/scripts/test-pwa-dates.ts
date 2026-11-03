/**
 * Тесты недельной арифметики для расписания PWA.
 *
 * Зачем отдельно от test:time: там серверное время и окно уведомлений, а здесь —
 * правило «какой день восстанавливать при открытии». Приложение запоминает
 * последний выбранный день в localStorage; если не проверять неделю, через
 * семь дней оно открывается на том же дне недели, но со старым расписанием.
 * У ИЭ-43-26 это выглядело как «сегодня математика, а показывается проектная
 * деятельность»: во вторнике отличается ровно одна пара.
 *
 * Дата фиксированная (вт 03.11.2026), зона не участвует — все функции работают
 * с календарными строками YYYY.MM.DD через UTC-полночь.
 *
 * Запуск: npm run test:pwa-dates
 */

import {
  isSameWeekRaw,
  isWeekBeforeRaw,
  weekStartRaw,
} from '../../pwa/src/lib/dates.ts';

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

console.log('====================================================');
console.log('   ТЕСТЫ ДАТ PWA (недели расписания)');
console.log('====================================================');

section('Понедельник недели');
{
  check('вторник → понедельник', weekStartRaw('2026.11.03') === '2026.11.02', String(weekStartRaw('2026.11.03')));
  check('сам понедельник не сдвигается', weekStartRaw('2026.11.02') === '2026.11.02');
  check('воскресенье — та же неделя', weekStartRaw('2026.11.08') === '2026.11.02');
  check('следующий понедельник — новая неделя', weekStartRaw('2026.11.09') === '2026.11.09');
  check('переход через год', weekStartRaw('2026.01.01') === '2025.12.29', String(weekStartRaw('2026.01.01')));
  check('мусор — null', weekStartRaw('не дата') === null);
  check('пустая строка — null', weekStartRaw('') === null);
}

section('Одна ли неделя');
{
  check('вт 03.11 и вс 08.11 — одна', isSameWeekRaw('2026.11.03', '2026.11.08'));
  check('вт 03.11 и пн 09.11 — разные', !isSameWeekRaw('2026.11.03', '2026.11.09'));
  check('вт 27.10 и вт 03.11 — разные', !isSameWeekRaw('2026.10.27', '2026.11.03'));
  check('вт 10.11 и вт 03.11 — разные', !isSameWeekRaw('2026.11.10', '2026.11.03'));
  check('сама с собой — одна', isSameWeekRaw('2026.11.03', '2026.11.03'));
  check('мусор — не одна', !isSameWeekRaw('мусор', '2026.11.03'));
}

section('Прошлая ли неделя');
{
  check('вт 27.10 раньше вт 03.11', isWeekBeforeRaw('2026.10.27', '2026.11.03'));
  check('вс 01.11 раньше пн 02.11', isWeekBeforeRaw('2026.11.01', '2026.11.02'));
  check('вт 10.11 не раньше вт 03.11', !isWeekBeforeRaw('2026.11.10', '2026.11.03'));
  check('чт 05.11 не раньше вт 03.11', !isWeekBeforeRaw('2026.11.05', '2026.11.03'));
  check('мусор — false', !isWeekBeforeRaw('мусор', '2026.11.03'));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
