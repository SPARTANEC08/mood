import * as cheerio from 'cheerio';

import { cleanSpaces as cleanText } from './shared.ts';

/**
 * Внутривузовский рейтинг — страница «Оценки» личного кабинета
 * (ST_LK/Score/ListScore).
 *
 * Раньше рейтинг брался из раздела «Рейтинг» (ST_PartN1…N6), где БАРС
 * отдаёт один и тот же общий балл в каждом разделе и ничего осмысленного.
 * Эта страница даёт настоящую картину.
 *
 * Что в ней есть:
 *
 *   Период | Учебная деятельность за семестр | Учеба, прочее |
 *   Учебный | Научно-инновационный | Общественный | Культурно-творческий |
 *   Спортивный | Дисциплинарный | Комплексный
 *
 * У каждого раздела два подзаголовка — «Общий» и «За семестр», поэтому в
 * одной строке данных значения размножаются: порядок идёт парами.
 * Числа разделены запятой: «76,9».
 *
 * Вторая строка таблицы — служебная подпись «Среднее (семестр учитывается
 * после 8-ой недели)», значений не несёт, поэтому пропускается.
 */

export interface RatingPart {
  key: string;
  title: string;
  /** Балл за всё время. */
  total: number | null;
  /** Балл за текущий семестр. */
  semester: number | null;
}

export interface RatingSummary {
  /** Подпись периода: «2026/2027, Осень». */
  period: string | null;
  /** Балл за учебную деятельность за семестр. */
  academicScore: number | null;
  /** Балл «Учеба, прочее». */
  studyScore: number | null;
  /** Разделы рейтинга. */
  parts: RatingPart[];
  /** Комплексный рейтинг — то, что обычно и подразумевают под «рейтингом». */
  comprehensive: RatingPart | null;
  /** Общий балл за семестр (последняя пара колонок). */
  overall: number | null;
}

/** «76,9» → 76.9; «—» или пусто → null. */
function parseScore(text: string): number | null {
  const cleaned = cleanText(text).replace(',', '.').replace('%', '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;

  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Ключи разделов в порядке колонок страницы.
 *
 * Порядок совпадает с заголовками и критичен: значения в строке идут подряд,
 * поэтому разделы сопоставляются по позиции, а не по названию.
 */
const PART_KEYS = [
  { key: 'academic', title: 'Учебный' },
  { key: 'research', title: 'Научно-инновационный' },
  { key: 'public', title: 'Общественный' },
  { key: 'creative', title: 'Культурно-творческий' },
  { key: 'sport', title: 'Спортивный' },
  { key: 'disciplinary', title: 'Дисциплинарный' },
  { key: 'comprehensive', title: 'Комплексный' },
] as const;

/**
 * Разбирает страницу «Оценки» (ST_LK/Score/ListScore).
 */
export function parseScorePage($: cheerio.CheerioAPI): RatingSummary {
  const table = $('table').first();

  // Заголовки верхнего уровня — названия разделов. Они идут до первой группы
  // «Общий / За семестр», которая о повторяется для каждого раздела.
  const allHeaders: string[] = [];
  table.find('th').each((_, th) => {
    allHeaders.push(cleanText($(th).text()));
  });

  // Первая строка данных — период и значения.
  const firstRow = table.find('tbody tr').first();
  const cells: string[] = firstRow.find('td').map((_, td) => $(td).text()).get();

  const period = cells.length > 0 ? cleanText(cells[0]) : null;
  const academicScore = cells.length > 1 ? parseScore(cells[1]) : null;
  const studyScore = cells.length > 2 ? parseScore(cells[2]) : null;

  // Значения разделов начинаются с индекса 3 и идут парами: общий, за семестр.
  const parts: RatingPart[] = [];
  let overall: number | null = null;

  PART_KEYS.forEach((part, index) => {
    const totalIdx = 3 + index * 2;
    const semesterIdx = totalIdx + 1;

    const total = cells.length > totalIdx ? parseScore(cells[totalIdx]) : null;
    const semester = cells.length > semesterIdx ? parseScore(cells[semesterIdx]) : null;

    // Последняя пара — это «Общий» по всем разделам.
    if (index === PART_KEYS.length - 1) {
      overall = total;
    }

    parts.push({ key: part.key, title: part.title, total, semester });
  });

  const comprehensive = parts.find((p) => p.key === 'comprehensive') ?? null;

  return {
    period,
    academicScore,
    studyScore,
    parts,
    comprehensive,
    overall,
  };
}