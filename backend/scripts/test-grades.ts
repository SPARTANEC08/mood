/**
 * Тестовый раннер выгрузки и парсинга успеваемости из БАРС МЭИ.
 * Запуск: npx tsx backend/scripts/test-grades.ts
 */

import { BarsScraper } from '../services/bars/barsScraper.js';

async function main(): Promise<void> {
  console.log('=== Выгрузка и парсинг успеваемости БАРС МЭИ ===\n');

  const scraper = new BarsScraper();
  const grades = await scraper.getCurrentSemesterGrades();

  console.log(`Семестр: ${grades.semesterName} (актуальный: ${grades.isCurrent ? 'да' : 'нет'})`);
  console.log(`Всего дисциплин: ${grades.subjects.length}\n`);

  console.table(
    grades.subjects.map((s) => ({
      Предмет: s.discipline,
      'КТ 1': s.controlPoints[0]?.score ?? null,
      'КТ 2': s.controlPoints[1]?.score ?? null,
      'КТ 3': s.controlPoints[2]?.score ?? null,
      Итог: s.totalScore,
      Оценка: s.finalGrade ?? null,
    })),
  );
}

main().catch((err) => {
  console.error('\n❌ Ошибка при выгрузке оценок:', err);
  process.exit(1);
});
