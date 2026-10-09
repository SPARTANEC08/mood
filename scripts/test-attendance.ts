/**
 * Тестовый раннер выгрузки и парсинга посещаемости из БАРС МЭИ.
 * Запуск: npx tsx scripts/test-attendance.ts
 */

import { BarsScraper } from '../src/services/bars/barsScraper.js';

async function main(): Promise<void> {
  console.log('=== Выгрузка и парсинг посещаемости БАРС МЭИ ===\n');

  const scraper = new BarsScraper();
  const attendance = await scraper.getAttendance();

  console.log('📊 Общая сводка пропусков:');
  console.log(`  • Всего пропущено:            ${attendance.totalMissed} ч. (зан.)`);
  console.log(`  • По уважительной причине:    ${attendance.totalExcused} ч.`);
  console.log(`  • По неуважительной причине:  ${attendance.totalUnexcused} ч.`);
  if (attendance.lastUpdated) {
    console.log(`  • По состоянию на:            ${attendance.lastUpdated}`);
  }
  console.log(`  • Всего дисциплин в учете:    ${attendance.bySubject.length}\n`);

  // Сортировка дисциплин по убыванию пропущенных часов
  const sortedSubjects = [...attendance.bySubject].sort(
    (a, b) => b.totalMissedHours - a.totalMissedHours || b.unexcusedHours - a.unexcusedHours,
  );

  console.log('📋 Детализация пропусков по дисциплинам:');
  console.table(
    sortedSubjects.map((s) => ({
      'Дисциплина': s.discipline,
      'Всего пропущено': s.totalMissedHours,
      'По уважительной': s.excusedHours,
      'По неуважительной': s.unexcusedHours,
    })),
  );

  const missedOnly = sortedSubjects.filter((s) => s.totalMissedHours > 0);
  if (missedOnly.length > 0) {
    console.log(`\n⚠️  Дисциплины с наибольшим количеством пропусков:`);
    for (const item of missedOnly) {
      console.log(
        `   - ${item.discipline}: ${item.totalMissedHours} проп. ` +
          `(неуваж: ${item.unexcusedHours}, уваж: ${item.excusedHours})`,
      );
    }
  } else {
    console.log('\n🎉 Отлично! Пропусков занятий нет.');
  }
}

main().catch((err) => {
  console.error('\n❌ Ошибка при выгрузке посещаемости:', err);
  process.exit(1);
});
