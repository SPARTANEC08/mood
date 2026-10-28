/**
 * Тесты кэша расписания и разбора группы.
 *
 * Полный цикл кэша (hot/cold TTL, дедупликация, force) требует сети к
 * ts.mpei.ru, поэтому здесь проверяются те части, которые от сети не зависят:
 * управление кэшем (stats/clear) и нормализация запроса группы — именно она
 * решает, попадёт ли пользователь в нужную группу при латинской раскладке.
 *
 * Живой сценарий загрузки описан в ручном чек-листе (README, «Тесты»).
 *
 * Запуск: npm run test:schedule-cache
 */

import { clearScheduleCache, isUsableSchedule, scheduleCacheStats } from '../scheduleCache.ts';
import { latinToCyrillicLookalikes, normalizeGroupString } from '../parser/mpeiApi.ts';

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
console.log('   ТЕСТЫ КЭША РАСПИСАНИЯ И ГРУПП');
console.log('====================================================');

section('Состояние кэша');
{
  clearScheduleCache();
  const stats = scheduleCacheStats();
  check('после очистки групп нет', stats.groups === 0, JSON.stringify(stats));
  check('байт не занято', stats.bytes === 0, JSON.stringify(stats));
  check('нет загрузок в полёте', stats.inflight === 0, JSON.stringify(stats));
  check('форма ответа стабильна', typeof stats.groups === 'number' && typeof stats.bytes === 'number' && typeof stats.inflight === 'number');

  // Повторная очистка и очистка конкретной группы не должны падать.
  clearScheduleCache();
  clearScheduleCache(12345);
  check('очистка идемпотентна и не бросает', scheduleCacheStats().groups === 0);
}

section('Пустой ответ МЭИ');
{
  check('пустое расписание непригодно', !isUsableSchedule({ days: [] } as never));
  check('undefined непригоден', !isUsableSchedule(undefined));
  check('расписание с днями пригодно', isUsableSchedule({ days: [{}] } as never));
}

section('Нормализация группы');
{
  check('пробелы обрезаются', normalizeGroupString('  ИЭ-11-26  ') === 'ИЭ-11-26');
  check('длинное тире → дефис', normalizeGroupString('ИЭ—11—26') === 'ИЭ-11-26');
  check('короткое тире → дефис', normalizeGroupString('ИЭ–11–26') === 'ИЭ-11-26');
  check('минус → дефис', normalizeGroupString('ИЭ−11−26') === 'ИЭ-11-26');
  check('обычная строка не меняется', normalizeGroupString('ТФ-01-25') === 'ТФ-01-25');
}

section('Латинские похожие буквы → кириллица');
{
  // Раскладка: пользователь набрал «Bbl»/«H3» латиницей вместо кириллицы.
  check('лат. e → е', latinToCyrillicLookalikes('e') === 'е');
  check('лат. t → т', latinToCyrillicLookalikes('t') === 'т');
  check('верхний регистр сохраняется', latinToCyrillicLookalikes('T') === 'Т');
  check('цифры не трогаются', latinToCyrillicLookalikes('11-26') === '11-26');
  check('кириллица не трогается', latinToCyrillicLookalikes('ИЭ') === 'ИЭ');
  check('смешанная строка: ИЭ латиницей → ИЭ', latinToCyrillicLookalikes('иe') === 'ие', latinToCyrillicLookalikes('иe'));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
