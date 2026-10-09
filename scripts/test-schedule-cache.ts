/**
 * Тесты кэша расписания: дедупликация, два уровня TTL, потолок, сбросы.
 *
 * Сеть не используется: подменяется globalThis.fetch, поэтому тест не ходит
 * на ts.mpei.ru и не зависит от его доступности.
 *
 * Запуск: npx tsx scripts/test-schedule-cache.ts
 */

import fs from 'node:fs';
import path from 'node:path';

const DUMP = path.resolve(process.cwd(), 'scratch/schedule_raw.json');
if (!fs.existsSync(DUMP)) {
  console.error(`❌ Нет сохранённого ответа ts.mpei.ru: ${DUMP}`);
  console.error('   Получите его один раз: npm run tsx — и сохраните scripts/dump-schedule.ts');
  process.exit(1);
}

const payload = fs.readFileSync(DUMP, 'utf-8');

let requests = 0;
let failNext = false;
let lastUrl = '';

globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  lastUrl = url;
  requests++;
  if (failNext) {
    failNext = false;
    throw new Error('имитация сетевой ошибки');
  }
  return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { clearScheduleCache, getGroupSchedule, scheduleCacheStats } = await import(
  '../src/bot/scheduleCache.ts'
);

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

/** Момент в будущем: кэш проверяет TTL по переданному времени. */
const inMinutes = (min: number) => new Date(Date.now() + min * 60 * 1000);

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('ТЕСТЫ КЭША РАСПИСАНИЯ');
  console.log('====================================================');

  section('Дедупликация параллельных запросов');
  clearScheduleCache();
  requests = 0;
  await Promise.all(Array.from({ length: 10 }, () => getGroupSchedule(21985, 'ИЭ-11-26')));
  check('10 одновременных обращений к одной группу = 1 запрос', requests === 1, `запросов ${requests}`);

  section('Два уровня TTL');
  clearScheduleCache();
  requests = 0;
  await getGroupSchedule(300001, 'ИЭ-11-26');
  check('первая загрузка идёт на сервер', requests === 1);

  await getGroupSchedule(300001, 'ИЭ-11-26');
  check('повтор сразу берётся из горячего слоя', requests === 1);

  await getGroupSchedule(300001, 'ИЭ-11-26', undefined, inMinutes(10));
  check('через 10 мин берётся из холодного слоя, сеть не трогается', requests === 1);

  await getGroupSchedule(300001, 'ИЭ-11-26', undefined, inMinutes(50));
  check('через 50 мин холодный слой истёк, идёт перезагрузка', requests === 2);

  section('Потолок и вытеснение');
  clearScheduleCache();
  requests = 0;
  for (let g = 1; g <= 70; g++) {
    await getGroupSchedule(900000 + g, `Группа ${g}`);
  }
  const stats = scheduleCacheStats();
  check('в кэше не больше 50 групп', stats.groups <= 50, `групп ${stats.groups}`);
  check('оценка размера положительная', stats.bytes > 0);
  console.log(`     в кэше ${stats.groups} групп, оценка ${(stats.bytes / 1048576).toFixed(1)} МБ`);

  section('Сбросы (/reflash и кнопка «Обновить»)');
  clearScheduleCache();
  await getGroupSchedule(500001, 'ИЭ-11-26');
  requests = 0;
  clearScheduleCache(500001);
  await getGroupSchedule(500001, 'ИЭ-11-26');
  check('clearScheduleCache(groupId) сбрасывает оба слоя', requests === 1);

  requests = 0;
  clearScheduleCache();
  await getGroupSchedule(500002, 'ИЭ-11-26');
  check('clearScheduleCache() сбрасывает весь кэш', requests === 1);

  section('Устойчивость к сетевым ошибкам');
  requests = 0;
  failNext = true;
  let caught = false;
  try {
    await getGroupSchedule(600001, 'Битая группа');
  } catch {
    caught = true;
  }
  check('ошибка сети пробрасывается вызывающему', caught);
  check('запрос на первой попытке был один', requests === 1);

  // Зависший inflight вернул бы тот же отклонённый промис без нового запроса.
  const recovered = await getGroupSchedule(600001, 'Битая группа');
  check('повтор после ошибки уходит на сервер заново', requests === 2, `запросов ${requests}`);
  check('расписание после ошибки возвращается', recovered.days.length > 0);
  check('зависших запросов в кэше не осталось', scheduleCacheStats().inflight === 0);

  section('Диапазон дат не поехал');
  check('в URL есть и start, и finish', /start=\d{4}\.\d{2}\.\d{2}/.test(lastUrl) && /finish=\d{4}\.\d{2}\.\d{2}/.test(lastUrl));
  check('группа попала в URL', /schedule\/group\/600001/.test(lastUrl));

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Тесты кэша упали:', err);
  process.exit(1);
});