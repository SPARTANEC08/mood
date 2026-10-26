/**
 * Проверка разбора таблицы стипендий БАРС.
 *
 * Раньше парсер возвращал первую строку и терял остальные назначения. Тест
 * фиксирует: несколько видов стипендий, активные и завершённые, плюс старые
 * поля type/period/amount для совместимости.
 *
 * Запуск: npm run test:scholarship
 */

import * as cheerio from 'cheerio';

import { parseScholarship } from '../services/bars/parsers/studentInfoParser.ts';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const html = `
  <table>
    <thead>
      <tr>
        <th>Вид стипендии</th>
        <th>Дата начала</th>
        <th>Дата окончания</th>
        <th>Размер</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>Академическая</td><td>01.09.2026</td><td>31.12.2026</td><td>3 000 ₽</td></tr>
      <tr><td>Социальная</td><td>01.09.2026</td><td>31.12.2026</td><td>2 000 ₽</td></tr>
      <tr><td>Повышенная</td><td>01.02.2026</td><td>30.06.2026</td><td>5 000 ₽</td></tr>
    </tbody>
  </table>
`;

console.log('\n=== Стипендии: несколько назначений ===\n');

const result = parseScholarship(cheerio.load(html), new Date('2026-10-15T12:00:00'));

check('назначение есть', result.isAppointed === true);
check('вернулись все три строки', result.items?.length === 3, String(result.items?.length));
check('академическая активна', result.items?.[0]?.type === 'Академическая' && result.items[0].isActive === true);
check('социальная активна', result.items?.[1]?.type === 'Социальная' && result.items[1].isActive === true);
check('повышенная завершена', result.items?.[2]?.type === 'Повышенная' && result.items[2].isActive === false);
check('старое поле type — первое активное', result.type === 'Академическая', String(result.type));
check('старое поле amount заполнено', result.amount === '3 000 ₽', String(result.amount));

const noDates = parseScholarship(
  cheerio.load(`
    <table>
      <thead><tr><th>Вид</th><th>Дата начала</th><th>Дата окончания</th><th>Размер</th></tr></thead>
      <tbody><tr><td>Социальная</td><td></td><td></td><td>2 000 ₽</td></tr></tbody>
    </table>
  `),
  new Date('2026-10-15T12:00:00'),
);
check('без дат назначение считается активным', noDates.isAppointed && noDates.items?.[0]?.isActive === true);

const empty = parseScholarship(cheerio.load('<div>Стипендия не назначена</div>'));
check('текстовое «не назначена»', empty.isAppointed === false && (empty.items?.length ?? 0) === 0);

console.log('\n====================================================');
console.log(`ИТОГО: ${failures === 0 ? '✅' : '❌'} ${checks - failures} / ${checks}`);
console.log('====================================================\n');

process.exit(failures === 0 ? 0 : 1);
