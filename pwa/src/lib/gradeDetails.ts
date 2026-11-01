/**
 * Селекторы для нижних листов «Успеваемости».
 *
 * Держим их отдельно от React: правила «что считается долгом», «какие разделы
 * рейтинга показывать» и «как разложить пропуски» — чистая логика, которую
 * можно проверить тестом без браузера.
 */

import type {
  ApiSubjectGrade,
  AttendanceResponse,
  BarsMoreResponse,
} from '../types/api';

/** Одна задолженность: конкретная КМ с выставленной двойкой. */
export interface DebtItem {
  key: string;
  discipline: string;
  point: number;
  title?: string;
  score: number;
  weight?: number;
  week?: string;
  date?: string;
}

/**
 * Задолженности — только выставленные двойки (score ≤ 2).
 *
 * Незакрытые КМ сюда не попадают: в БАРС они не считаются задолженностью,
 * и цифра на карточке должна совпадать с количеством строк в листе.
 */
export function collectDebts(
  grades: { subjects: ApiSubjectGrade[] } | null | undefined,
): DebtItem[] {
  if (!grades) return [];

  const items: DebtItem[] = [];

  for (const subject of grades.subjects) {
    for (const point of subject.controlPoints) {
      if (point.score === null || point.score > 2) continue;

      items.push({
        key: `${subject.discipline}:${point.number}`,
        discipline: subject.discipline,
        point: point.number,
        title: point.title,
        score: point.score,
        weight: point.weight,
        week: point.week,
        date: point.date,
      });
    }
  }

  return items.sort(
    (a, b) => a.discipline.localeCompare(b.discipline, 'ru') || a.point - b.point,
  );
}

/** Раздел рейтинга в виде, готовом для строки листа. */
export interface RatingRow {
  key: string;
  title: string;
  semester: number | null;
  total: number | null;
}

/**
 * Разделы рейтинга без «Комплексного»: он показывается отдельно крупной
 * цифрой, и дублировать его в списке значило бы дважды объяснять одно число.
 */
export function ratingRows(
  rating: BarsMoreResponse['rating'] | null | undefined,
): RatingRow[] {
  return (rating?.parts ?? [])
    .filter((part) => part.key !== 'comprehensive')
    .map((part) => ({
      key: part.key,
      title: part.title,
      semester: part.semester,
      total: part.total,
    }));
}

/** Есть ли в рейтинге хоть одно число: иначе лист покажет пустое состояние. */
export function hasRatingValues(
  rating: BarsMoreResponse['rating'] | null | undefined,
): boolean {
  if (!rating) return false;
  if (rating.comprehensive?.semester !== null && rating.comprehensive?.semester !== undefined) {
    return true;
  }
  if (rating.comprehensive?.total !== null && rating.comprehensive?.total !== undefined) {
    return true;
  }
  return rating.parts.some((part) => part.semester !== null || part.total !== null);
}

/** Пропуски по одному предмету. */
export interface AttendanceRow {
  key: string;
  discipline: string;
  missedLessons: number;
  excusedLessons: number;
  unexcusedLessons: number;
  totalMissedHours: number;
}

/** Строки пропусков по предметам; пустой массив — нет данных для разбивки. */
export function attendanceRows(
  attendance: AttendanceResponse | null | undefined,
): AttendanceRow[] {
  return (attendance?.bySubject ?? []).map((subject) => ({
    key: subject.discipline,
    discipline: subject.discipline,
    missedLessons: subject.missedLessons,
    excusedLessons: subject.excusedLessons,
    unexcusedLessons: subject.unexcusedLessons,
    totalMissedHours: subject.totalMissedHours,
  }));
}

/** Число в формате приложения: 4,5; null — прочерк. */
export function formatScore(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace('.', ',');
}
