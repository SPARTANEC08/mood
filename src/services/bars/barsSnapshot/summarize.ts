/**
 * Сводка по успеваемости для блока «Кабинет»: задолженности и распределение
 * оценок по контрольным мероприятиям.
 *
 * Задолженность — это именно двойка за КМ. Незакрытое КМ (score === null)
 * задолженностью НЕ считается: его ещё просто не сдали, и путать это с
 * «двойкой» значит показывать страшные 33 вместо реального числа. В
 * распределение оценок незакрытые тоже не входят — там ровно то, что выставлено.
 *
 * Дробные баллы (4,5) округляются вниз: для полосы важна оценка по
 * пятибалльной шкале, а не десятичная точность.
 */

import type { BarsMoreResponse } from '../../../server/types.ts';
import type { SubjectGrade } from '../parsers/gradesParser.js';

export function summarizeAcademic(subjects: SubjectGrade[]): BarsMoreResponse['academic'] {
  let fives = 0;
  let fours = 0;
  let threes = 0;
  let twos = 0;
  let closed = 0;
  let total = 0;

  for (const subject of subjects) {
    for (const point of subject.controlPoints) {
      total += 1;

      const raw = point.score;

      // Не выставлено — ни в задолженность, ни в распределение.
      if (raw === null) continue;

      closed += 1;

      if (raw <= 2) {
        // Двойка — это и есть задолженность.
        twos += 1;
        continue;
      }

      const rounded = Math.floor(raw);
      if (rounded >= 5) fives += 1;
      else if (rounded === 4) fours += 1;
      else threes += 1;
    }
  }

  return {
    debts: twos,
    closed,
    total,
    distribution: { fives, fours, threes, twos, total: fives + fours + threes + twos },
  };
}

export function emptyAcademic(): BarsMoreResponse['academic'] {
  return {
    debts: 0,
    closed: 0,
    total: 0,
    distribution: { fives: 0, fours: 0, threes: 0, twos: 0, total: 0 },
  };
}
