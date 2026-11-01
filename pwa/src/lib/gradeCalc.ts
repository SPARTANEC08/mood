/**
 * Расчёт «что нужно для цели» по весам КМ.
 *
 * Формула та же, что в `backend/gradeCalculator.ts`: средний балл — это
 * `Σ(балл × вес) / Σвесов` по закрытым КМ. Здесь добавляется прогноз:
 * сколько осталось набрать и какие минимальные баллы за оставшиеся КМ дадут
 * цель. Всё считается на клиенте — серверных изменений нет.
 */

import type { ApiControlPoint, ApiSubjectGrade } from '../types/api';

/** Проверка весов: без неё прогноз был бы математически неверным. */
export interface WeightCheck {
  ok: boolean;
  reason: 'ok' | 'empty' | 'missing' | 'sum';
  /** Сумма весов всех КМ, в процентах. */
  sum: number;
  /** Сколько КМ без положительного веса. */
  missing: number;
}

export function checkWeights(subject: ApiSubjectGrade | null | undefined): WeightCheck {
  const points = subject?.controlPoints ?? [];
  if (points.length === 0) {
    return { ok: false, reason: 'empty', sum: 0, missing: 0 };
  }

  let sum = 0;
  let missing = 0;

  for (const point of points) {
    if (typeof point.weight === 'number' && point.weight > 0) sum += point.weight;
    else missing += 1;
  }

  if (missing > 0) {
    return { ok: false, reason: 'missing', sum: round2(sum), missing };
  }

  if (Math.abs(sum - 100) > 0.01) {
    return { ok: false, reason: 'sum', sum: round2(sum), missing: 0 };
  }

  return { ok: true, reason: 'ok', sum: round2(sum), missing: 0 };
}

/** Сумма баллов, уже набранных по закрытым КМ (балл × вес). */
export function earnedWeighted(subject: ApiSubjectGrade): number {
  return subject.controlPoints.reduce((sum, point) => {
    if (point.score === null || !isPositiveWeight(point)) return sum;
    return sum + point.score * point.weight;
  }, 0);
}

/** Сумма весов закрытых и оставшихся КМ. */
export function weightSums(subject: ApiSubjectGrade): {
  total: number;
  graded: number;
  pending: number;
} {
  let graded = 0;
  let pending = 0;

  for (const point of subject.controlPoints) {
    if (!isPositiveWeight(point)) continue;
    if (point.score === null) pending += point.weight;
    else graded += point.weight;
  }

  return { total: graded + pending, graded, pending };
}

/**
 * Текущий средневзвешенный балл по закрытым КМ.
 * null — оценок ещё нет.
 */
export function currentWeighted(subject: ApiSubjectGrade): number | null {
  const { graded } = weightSums(subject);
  if (graded <= 0) return null;

  return round2(earnedWeighted(subject) / graded);
}

/**
 * Средний балл, который нужно получить за оставшиеся КМ, чтобы выйти на цель.
 * null — оставшихся КМ нет.
 */
export function requiredAverage(
  subject: ApiSubjectGrade,
  target: number,
): number | null {
  const { total, pending } = weightSums(subject);
  if (pending <= 0 || total <= 0) return null;

  return round2((target * total - earnedWeighted(subject)) / pending);
}

/** Максимум, который можно получить, если за всё оставшееся поставить 5. */
export function maxPossible(subject: ApiSubjectGrade): number | null {
  const { total, pending } = weightSums(subject);
  if (total <= 0) return null;

  return round2((earnedWeighted(subject) + 5 * pending) / total);
}

/** Балл за конкретную оставшуюся КМ в минимальном плане. */
export interface PlanItem {
  point: ApiControlPoint;
  score: number;
}

export interface MinimumPlan {
  /** Достижима ли цель: если даже все пятёрки не хватает — false. */
  feasible: boolean;
  /** По одной строке на каждую оставшуюся КМ. */
  items: PlanItem[];
}

/**
 * Минимальный план по оставшимся КМ.
 *
 * Берём `floor(требуемого среднего)` для всех КМ, а затем повышаем на балл
 * самые тяжёлые, пока цель не достигнута. Так план не содержит лишних пятёрок
 * и, что важнее, не предлагает двойку там, где хватает тройки с четвёркой.
 *
 * Если требуемый средний больше 5 — цель недостижима, план возвращается с
 * `feasible: false` и максимумами, чтобы интерфейс мог показать предел.
 */
export function minimumPlan(
  subject: ApiSubjectGrade,
  target: number,
): MinimumPlan {
  const pending = subject.controlPoints.filter(
    (point): point is ApiControlPoint & { weight: number } =>
      point.score === null && isPositiveWeight(point),
  );

  if (pending.length === 0) return { feasible: true, items: [] };

  const required = requiredAverage(subject, target);
  if (required === null) return { feasible: true, items: [] };

  if (required > 5.0001) {
    return {
      feasible: false,
      items: pending.map((point) => ({ point, score: 5 })),
    };
  }

  const base = Math.max(0, Math.floor(required + 1e-9));
  const scores = new Map<number, number>(
    pending.map((point) => [point.number, Math.min(5, base)]),
  );

  /*
   * Дефицит считаем по фактическим весам: у КМ они разные, поэтому «вычесть
   * одинаковый балл» для всех было бы ошибкой.
   */
  let deficit =
    target * weightSums(subject).total -
    earnedWeighted(subject) -
    pending.reduce(
      (sum, point) => sum + (scores.get(point.number) ?? 0) * point.weight,
      0,
    );

  const byWeight = [...pending].sort(
    (a, b) => b.weight - a.weight || a.number - b.number,
  );

  for (const point of byWeight) {
    if (deficit <= 1e-9) break;
    const current = scores.get(point.number) ?? 0;
    if (current >= 5) continue;

    scores.set(point.number, current + 1);
    deficit -= point.weight;
  }

  return {
    feasible: deficit <= 1e-9,
    items: pending.map((point) => ({
      point,
      score: scores.get(point.number) ?? 0,
    })),
  };
}

/**
 * Итоговый средний по введённым баллам за оставшиеся КМ.
 *
 * Пустое значение считается нулём: пользователь видит худший сценарий, а
 * подставить минимальный план можно отдельной кнопкой.
 */
export function simulateAverage(
  subject: ApiSubjectGrade,
  scores: Record<number, number | null>,
): number | null {
  const { total } = weightSums(subject);
  if (total <= 0) return null;

  const pendingSum = subject.controlPoints.reduce((sum, point) => {
    if (point.score !== null || !isPositiveWeight(point)) return sum;
    const value = scores[point.number];
    return sum + (value ?? 0) * point.weight;
  }, 0);

  return round2((earnedWeighted(subject) + pendingSum) / total);
}

/** Пороги оценок, введённые вручную. Пустое поле — порог не задан. */
export type GradeThresholds = {
  five: number | null;
  four: number | null;
  three: number | null;
};

/** Предполагаемая оценка по среднему и порогам; null — пороги не заданы. */
export function predictGrade(
  average: number | null,
  thresholds: GradeThresholds,
): '5' | '4' | '3' | '2' | null {
  if (average === null) return null;

  if (thresholds.five !== null && average >= thresholds.five) return '5';
  if (thresholds.four !== null && average >= thresholds.four) return '4';
  if (thresholds.three !== null && average >= thresholds.three) return '3';
  if (thresholds.three !== null) return '2';
  return null;
}

/** «4+» для дробного требования, «4» для точного целого. */
export function formatRequiredAverage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value <= 0) return '0+';

  const nearest = Math.round(value);
  if (Math.abs(value - nearest) < 1e-9) return String(nearest);
  return `${Math.ceil(value - 1e-9)}+`;
}

function isPositiveWeight(point: ApiControlPoint): point is ApiControlPoint & { weight: number } {
  return typeof point.weight === 'number' && point.weight > 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
