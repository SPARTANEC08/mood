/**
 * Тесты времени: Europe/Moscow, активное окно 8–23, полночь отчёта.
 *
 * Все проверки идут от ФИКСИРОВАННЫХ UTC-моментов, а не от «сейчас»: иначе на
 * CI и локально результат зависел бы от часового пояса машины и времени прогона.
 * Москва — фиксированный UTC+3 (без переходов), поэтому пересчёт детерминирован.
 *
 * Запуск: npm run test:time
 */

import { formatDisplayDate, normalizeRawDate, toMoscow } from '../utils/time.ts';
import { msUntilNextMoscowMidnight } from '../services/notifications/dailyReport.ts';
import { isWithinActiveWindow } from '../services/notifications/notifier/run.ts';

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
console.log('   ТЕСТЫ ВРЕМЕНИ (Europe/Moscow)');
console.log('====================================================');

section('Московское время из UTC');
{
  // 2026-10-18 21:30 UTC → 2026-10-19 00:30 МСК (переход через сутки).
  const moment = toMoscow(new Date('2026-10-18T21:30:00Z'));
  check('дата переходит через полночь', moment.rawDate === '2026.10.19', moment.rawDate);
  check('время 00:30', moment.time === '00:30', moment.time);

  const noon = toMoscow(new Date('2026-10-18T09:05:00Z'));
  check('12:05 МСК', noon.time === '12:05', noon.time);
}

section('Формат дат');
{
  check('DD.MM.YYYY → YYYY.MM.DD', normalizeRawDate('18.10.2026') === '2026.10.18');
  check('уже сырой формат не меняется', normalizeRawDate('2026.10.18') === '2026.10.18');
  check('мусор возвращается как есть', normalizeRawDate('не дата') === 'не дата');
  check('показ YYYY.MM.DD → DD.MM.YYYY', formatDisplayDate('2026.10.18') === '18.10.2026');
  check('показ мусора не падает', formatDisplayDate('18.10.2026') === '18.10.2026');
}

section('Активное окно 8–23 МСК');
{
  // 08:00 МСК = 05:00 UTC, 07:59 = 04:59 UTC, 22:59 = 19:59 UTC, 23:00 = 20:00 UTC.
  check('08:00 — внутри', isWithinActiveWindow(new Date('2026-10-18T05:00:00Z')));
  check('07:59 — снаружи', !isWithinActiveWindow(new Date('2026-10-18T04:59:00Z')));
  check('22:59 — внутри', isWithinActiveWindow(new Date('2026-10-18T19:59:00Z')));
  check('23:00 — уже снаружи', !isWithinActiveWindow(new Date('2026-10-18T20:00:00Z')));
  check('00:30 МСК — снаружи', !isWithinActiveWindow(new Date('2026-10-18T21:30:00Z')));
}

section('Полночь отчёта');
{
  // 13:00 МСК (10:00 UTC) → до 00:00 МСК 11 часов + полсекунды запаса.
  const now = new Date('2026-10-18T10:00:00Z');
  const delay = msUntilNextMoscowMidnight(now.getTime());
  check('до полуночи ≈11 часов', delay === 11 * 60 * 60 * 1000 + 500, String(delay));

  const atMidnight = now.getTime() + delay;
  const landed = toMoscow(new Date(atMidnight));
  check('через задержку — 00:00 МСК', landed.time === '00:00', landed.time);
  check('следующие сутки', landed.rawDate === '2026.10.19', landed.rawDate);

  // Расчёт не зависит от момента внутри суток: всегда 0 < delay ≤ 24ч.
  for (const iso of ['2026-10-18T00:00:01Z', '2026-10-18T20:59:59Z', '2026-06-01T12:00:00Z']) {
    const d = msUntilNextMoscowMidnight(new Date(iso).getTime());
    check(`задержка в диапазоне суток (${iso})`, d > 0 && d <= 24 * 60 * 60 * 1000 + 500, String(d));
  }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
