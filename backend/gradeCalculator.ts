import type { ControlPoint, SubjectGrade } from './services/bars/parsers/gradesParser.js';

/**
 * Итог по дисциплине: средний балл по весам КМ и сводка по контрольным мероприятиям.
 */
export interface SubjectGradeReport {
  discipline: string;
  controlType: SubjectGrade['controlType'];
  attestationRaw?: string;

  /** Средневзвешенный балл по выставленным КМ (только те, где есть оценка) */
  currentAverage: number | null;
  /** Средневзвешенный балл, посчитанный БАРС — для сверки */
  barsAverage: number | null;
  /** Сумма весов выставленных КМ в процентах */
  gradedWeight: number;
  /** Сумма всех весов КМ в процентах (обычно 100) */
  totalWeight: number;
  /** Всего КМ в дисциплине */
  totalCount: number;
  /** Сколько КМ уже с оценкой */
  gradedCount: number;
  /** Сколько КМ ещё не закрыто */
  pendingCount: number;
  /** Полный список КМ — для сворачиваемого блока */
  controlPoints: ControlPoint[];
  /** Итоговая оценка из ЛК, если выставлена */
  finalGrade?: string;
}

/**
 * Средневзвешенный балл по КМ, у которых есть и вес, и оценка.
 * Если веса не пришли из БАРС, считаем обычное среднее.
 */
export function weightedAverage(points: ControlPoint[]): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  let plainSum = 0;
  let plainCount = 0;

  for (const p of points) {
    if (p.score === null) continue;

    plainSum += p.score;
    plainCount += 1;

    if (typeof p.weight === 'number' && p.weight > 0) {
      weightedSum += p.score * p.weight;
      weightSum += p.weight;
    }
  }

  if (plainCount === 0) return null;
  if (weightSum === 0) return round2(plainSum / plainCount);

  return round2(weightedSum / weightSum);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Полный отчёт по одной дисциплине.
 */
export function buildSubjectReport(subject: SubjectGrade): SubjectGradeReport {
  const graded = subject.controlPoints.filter((p) => p.score !== null);
  const pending = subject.controlPoints.filter((p) => p.score === null);

  let gradedWeight = 0;
  let totalWeight = 0;
  for (const p of subject.controlPoints) {
    const w = typeof p.weight === 'number' && p.weight > 0 ? p.weight : 0;
    totalWeight += w;
    if (p.score !== null) gradedWeight += w;
  }

  return {
    discipline: subject.discipline,
    controlType: subject.controlType,
    attestationRaw: subject.attestationRaw,

    currentAverage: weightedAverage(subject.controlPoints),
    barsAverage: subject.totalScore,
    gradedWeight,
    totalWeight,
    totalCount: subject.controlPoints.length,
    gradedCount: graded.length,
    pendingCount: pending.length,
    controlPoints: subject.controlPoints,
    finalGrade: subject.finalGrade,
  };
}

/**
 * Отчёты по всем дисциплинам семестра, отсортированные по среднему баллу (от худшего к лучшему).
 */
export function buildSemesterReport(subjects: SubjectGrade[]): SubjectGradeReport[] {
  return subjects
    .map(buildSubjectReport)
    .filter((r) => r.totalCount > 0)
    .sort((a, b) => (a.currentAverage ?? 99) - (b.currentAverage ?? 99));
}