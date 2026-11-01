/**
 * Тесты калькулятора оценок.
 *
 * Проверяем именно математику: текущий средний, требуемый средний на
 * оставшиеся КМ, минимальный план без лишних пятёрок и недостижимые цели.
 *
 * Запуск: npm run test:grade-calculator
 */

import {
  checkWeights,
  currentWeighted,
  formatRequiredAverage,
  maxPossible,
  minimumPlan,
  predictGrade,
  requiredAverage,
  simulateAverage,
} from '../../pwa/src/lib/gradeCalc.ts';
import type { ApiSubjectGrade } from '../../pwa/src/types/api.ts';

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

function subject(
  weights: Array<number | undefined>,
  scores: Array<number | null>,
): ApiSubjectGrade {
  return {
    discipline: 'Тестовая дисциплина',
    controlType: 'Экзамен',
    currentAverage: null,
    barsAverage: null,
    gradedWeight: 0,
    totalWeight: 0,
    totalCount: weights.length,
    gradedCount: scores.filter((score) => score !== null).length,
    pendingCount: scores.filter((score) => score === null).length,
    controlPoints: weights.map((weight, index) => ({
      number: index + 1,
      weight,
      score: scores[index] ?? null,
    })),
  };
}

console.log('====================================================');
console.log('   ТЕСТЫ: КАЛЬКУЛЯТОР ОЦЕНОК');
console.log('====================================================');

section('Текущий средний и веса');
{
  const grades = subject([25, 25, 25, 25], [4, 3, null, null]);
  const weights = checkWeights(grades);

  check('веса валидны', weights.ok, weights.reason);
  check('сумма весов 100', weights.sum === 100, String(weights.sum));
  check('текущий средний 3.5', currentWeighted(grades) === 3.5, String(currentWeighted(grades)));
  check('максимум 4.25', maxPossible(grades) === 4.25, String(maxPossible(grades)));
}

section('Требуемый средний');
{
  const grades = subject([25, 25, 25, 25], [4, 3, null, null]);

  check(
    'для 4.0 нужно 4.5',
    requiredAverage(grades, 4) === 4.5,
    String(requiredAverage(grades, 4)),
  );
  check(
    'для 3.5 нужно 3.5',
    requiredAverage(grades, 3.5) === 3.5,
    String(requiredAverage(grades, 3.5)),
  );
  check(
    'для 5.0 нужно больше 5',
    (requiredAverage(grades, 5) ?? 0) > 5,
    String(requiredAverage(grades, 5)),
  );
}

section('Формат требования');
{
  check('4.5 → 5+', formatRequiredAverage(4.5) === '5+', formatRequiredAverage(4.5));
  check('3.7 → 4+', formatRequiredAverage(3.7) === '4+', formatRequiredAverage(3.7));
  check('4.0 → 4', formatRequiredAverage(4) === '4', formatRequiredAverage(4));
  check('null → —', formatRequiredAverage(null) === '—', formatRequiredAverage(null));
}

section('Минимальный план');
{
  const grades = subject([25, 25, 25, 25], [4, 3, null, null]);

  const plan4 = minimumPlan(grades, 4);
  check('цель 4.0 достижима', plan4.feasible);
  check(
    'план 5 и 4',
    plan4.items.map((item) => item.score).join(',') === '5,4',
    plan4.items.map((item) => item.score).join(','),
  );

  const plan35 = minimumPlan(grades, 3.5);
  check('цель 3.5 достижима', plan35.feasible);
  check(
    'план 4 и 3, без двойки',
    plan35.items.map((item) => item.score).join(',') === '4,3',
    plan35.items.map((item) => item.score).join(','),
  );

  const plan5 = minimumPlan(grades, 5);
  check('цель 5.0 недостижима', plan5.feasible === false);
  check(
    'при недостижимости — пятёрки',
    plan5.items.every((item) => item.score === 5),
    plan5.items.map((item) => item.score).join(','),
  );
}

section('Разные веса');
{
  const grades = subject([30, 30, 40], [4, null, null]);
  const plan = minimumPlan(grades, 4);

  check('веса валидны', checkWeights(grades).ok);
  check('план по 4 за обе КМ', plan.items.map((item) => item.score).join(',') === '4,4');
  check(
    'средний после плана 4.0',
    simulateAverage(grades, { 2: 4, 3: 4 }) === 4,
    String(simulateAverage(grades, { 2: 4, 3: 4 })),
  );
}

section('Неполные веса');
{
  const missing = subject([25, 25, undefined], [4, null, null]);
  const notHundred = subject([25, 25, 25], [4, null, null]);

  check('нет веса у КМ → предупреждение', checkWeights(missing).reason === 'missing');
  check('сумма не 100 → предупреждение', checkWeights(notHundred).reason === 'sum');
}

section('Все КМ закрыты');
{
  const grades = subject([50, 50], [5, 4]);

  check('текущий средний 4.5', currentWeighted(grades) === 4.5, String(currentWeighted(grades)));
  check('требуемый средний null', requiredAverage(grades, 4) === null);
  check('план пуст', minimumPlan(grades, 4).items.length === 0);
}

section('Симуляция и прогноз оценки');
{
  const grades = subject([25, 25, 25, 25], [4, 3, null, null]);

  check(
    'симуляция 5 и 4 даёт 4.0',
    simulateAverage(grades, { 3: 5, 4: 4 }) === 4,
    String(simulateAverage(grades, { 3: 5, 4: 4 })),
  );

  const thresholds = { five: 4.5, four: 3.5, three: 2.5 };
  check('4.2 → 4', predictGrade(4.2, thresholds) === '4', String(predictGrade(4.2, thresholds)));
  check('4.6 → 5', predictGrade(4.6, thresholds) === '5', String(predictGrade(4.6, thresholds)));
  check(
    'без порогов прогноза нет',
    predictGrade(4.2, { five: null, four: null, three: null }) === null,
  );
  check(
    'неполные пороги не дают ложный прогноз',
    predictGrade(4.2, { five: 4.5, four: null, three: 2.5 }) === null,
  );
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exit(1);
