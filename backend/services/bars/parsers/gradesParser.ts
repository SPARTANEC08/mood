import * as cheerio from 'cheerio';

import { cleanText } from './shared.ts';

/**
 * Контрольное мероприятие (КМ) — это реальная единица оценивания в МЭИ.
 * У каждого КМ есть вес в процентах; сумма весов по дисциплине равна 100%.
 */
export interface ControlPoint {
  /** Порядковый номер КМ в дисциплине (1, 2, 3...) */
  number: number;
  /** Название КМ без номера: «Элементарная математика. Матрицы и определители» */
  title?: string;
  /** Вес КМ в процентах (10, 25, 35...) */
  weight?: number;
  /** Выставленная оценка, null если ещё не выставлена. */
  score: number | null;
  /**
   * Все попытки по этому КМ, если БАРС показал их в одной ячейке
   * («2 (дата) 4 (дата)»). Для среднего берётся их арифметическое.
   */
  attempts?: number[];
  /** Неделя проведения: «4» */
  week?: string;
  /** Дата получения оценки: «23.09.26» */
  date?: string;
}

/**
 * Балл за контрольную неделю (промежуточный срез, не КМ).
 */
export interface WeekScore {
  week: number;
  score: number | null;
}

export interface SubjectGrade {
  discipline: string;
  lecturer?: string;
  controlType: 'Экзамен' | 'Зачет' | 'Диф. зачет' | 'Неизвестно';
  /** Полный текст вида аттестации из ЛК */
  attestationRaw?: string;
  /** КМ дисциплины с весами */
  controlPoints: ControlPoint[];
  /** Баллы по контрольным неделям */
  weekScores: WeekScore[];
  /** «Балл текущего контроля» из ЛК (средневзвешенный по БАРС) */
  totalScore: number | null;
  finalGrade?: string;
}

export interface SemesterGrades {
  /** Например: «2026-2027 осенний (1 курс)» */
  semesterName: string;
  isCurrent: boolean;
  subjects: SubjectGrade[];
}

function parseScore(val: string): number | null {
  const cleaned = cleanText(val).replace(',', '.');
  if (!cleaned || cleaned === '-' || cleaned === '—') return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Определяет стандартизированный тип промежуточной аттестации.
 */
function parseControlType(text: string): SubjectGrade['controlType'] {
  const lower = text.toLowerCase();
  if (lower.includes('зачёт (без оценки)') || lower.includes('зачет (без оценки)')) {
    return 'Зачет';
  }
  if (lower.includes('экзамен')) return 'Экзамен';
  if (
    lower.includes('зачёт с оценкой') ||
    lower.includes('зачет с оценкой') ||
    lower.includes('диф')
  ) {
    return 'Диф. зачет';
  }
  if (lower.includes('зачёт') || lower.includes('зачет')) return 'Зачет';
  return 'Неизвестно';
}

/**
 * Разбирает строку оценки.
 *
 * БАРС может показать в одной ячейке несколько попыток:
 * «2 (10.10.26) 4 (15.10.26)» — пересдача. Даты в скобках оценками не считаем,
 * а все числа без скобок — это попытки. Для среднего и для балла по КМ берём их
 * арифметическое: именно так это делает БАРС, и именно из-за этого расходился
 * средний балл, когда приложение учитывало только последнюю оценку.
 */
function parseGradeCell(raw: string): { score: number | null; date?: string; attempts?: number[] } {
  const cleaned = cleanText(raw);
  if (!cleaned) return { score: null };

  const dates = [...cleaned.matchAll(/\(([^)]+)\)/g)]
    .map((match) => cleanText(match[1] ?? ''))
    .filter(Boolean);

  const numbers = [...cleaned.replace(/\([^)]*\)/g, ' ').matchAll(/\d+(?:[.,]\d+)?/g)]
    .map((match) => parseScore(match[0]))
    .filter((value): value is number => value !== null);

  if (numbers.length === 0) return { score: null, date: dates.at(-1) };

  if (numbers.length === 1) {
    return { score: numbers[0]!, date: dates.at(-1) };
  }

  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return {
    score: Math.round(mean * 100) / 100,
    date: dates.at(-1),
    attempts: numbers,
  };
}

/**
 * Разбирает строку срока вида «4 (23.09.26)» или «5 (28.09.26-04.10.26)».
 */
function parseWeekCell(raw: string): { week?: string; date?: string } {
  const cleaned = cleanText(raw);
  if (!cleaned) return {};

  const m = cleaned.match(/^(\d+)\s*(?:\(([^)]*)\))?$/);
  if (!m) return { date: cleaned };

  return {
    week: m[1],
    date: m[2] ? cleanText(m[2]) : undefined,
  };
}

/**
 * Отделяет номер КМ от названия: «1. Элементарная математика» -> { number: 1, title: '...' }
 */
function splitNumberAndTitle(text: string): { number?: number; title: string } {
  const cleaned = cleanText(text);
  const m = cleaned.match(/^(\d{1,2})\s*[.)]\s*(.+)$/);
  if (!m) return { title: cleaned };
  return { number: Number.parseInt(m[1], 10), title: cleanText(m[2]) };
}

/**
 * Парсит страницу успеваемости БАРС МЭИ в структурированный объект SemesterGrades.
 *
 * Важно: раньше здесь «контрольными точками» считались строки «Контрольная неделя №N»,
 * из-за чего веса КМ терялись и средний балл считался неверно.
 * Теперь controlPoints — это настоящие КМ с весом в процентах.
 */
export function parseGradesPage($: cheerio.CheerioAPI): SemesterGrades {
  const semSelect = $('select#ddl_StudyFilterSemester');
  const selectedOption = semSelect.find('option:selected');
  const semesterName = cleanText(selectedOption.text()) || '2026/2027, Осенний семестр';

  const firstOptionVal = semSelect.find('option').first().val();
  const selectedVal = selectedOption.val();
  const isCurrent = !selectedVal || selectedVal === firstOptionVal;

  const subjects: SubjectGrade[] = [];

  $('[id^="s_ss_"]').each((_, collapseEl) => {
    const collapseId = $(collapseEl).attr('id');
    if (!collapseId || collapseId === 's_ss_All') return;

    const headerDiv = $(`[data-bs-target="#${collapseId}"]`);
    if (!headerDiv.length) return;

    const rawHeader = cleanText(headerDiv.clone().children('span, a').remove().end().text());

    // «Математика, Кленина Л.И., экзамен, 4ЗЕ сдать до 24.12.2026»
    const parts = rawHeader.split(',').map((p) => cleanText(p));
    const discipline = parts[0] || 'Неизвестная дисциплина';
    const lecturer = parts[1] || undefined;
    const attestationRaw = parts[2] || undefined;
    const controlType = parseControlType(attestationRaw ?? '');

    const controlPoints: ControlPoint[] = [];
    const weekScores: WeekScore[] = [];
    let totalScore: number | null = null;
    let finalGrade: string | undefined;

    const rows = $(collapseEl).find('table tr');

    rows.each((_, tr) => {
      const tds = $(tr).find('td');

      // Строка КМ: 4 ячейки — название, вес, срок, оценка.
      // Прочие служебные строки имеют colspan и сюда не попадают.
      if (tds.length === 4) {
        const nameCell = cleanText($(tds[0]).text());
        const weight = parseScore($(tds[1]).text());
        const when = parseWeekCell($(tds[2]).text());
        const grade = parseGradeCell($(tds[3]).text());

        const { number, title } = splitNumberAndTitle(nameCell);

        controlPoints.push({
          number: number ?? controlPoints.length + 1,
          title,
          weight: weight ?? undefined,
          score: grade.score,
          attempts: grade.attempts,
          week: when.week,
          date: grade.date ?? when.date,
        });
        return;
      }

      const rowText = cleanText($(tr).text());

      // «Балл текущего контроля:» — средневзвешенный по весам КМ
      if (rowText.includes('Балл текущего контроля:')) {
        const value = tds.length > 0 ? parseScore($(tds[tds.length - 1]).text()) : null;
        if (value !== null) totalScore = value;
        return;
      }

      // «Контрольная неделя №N» — срез, а не КМ
      if (rowText.includes('Контрольная неделя №')) {
        const numMatch = rowText.match(/№\s*(\d+)/);
        const value = tds.length > 0 ? parseScore($(tds[tds.length - 1]).text()) : null;
        weekScores.push({
          week: numMatch ? Number.parseInt(numMatch[1], 10) : weekScores.length + 1,
          score: value,
        });
        return;
      }

      // «Итоговая оценка:»
      if (rowText.includes('Итоговая оценка:')) {
        const value = cleanText($(tds[tds.length - 1]).text() ?? '');
        if (value && value !== '-' && value !== '—') {
          finalGrade = value;
        }
      }
    });

    controlPoints.sort((a, b) => a.number - b.number);
    weekScores.sort((a, b) => a.week - b.week);

    subjects.push({
      discipline,
      lecturer,
      controlType,
      attestationRaw,
      controlPoints,
      weekScores,
      totalScore,
      finalGrade,
    });
  });

  return { semesterName, isCurrent, subjects };
}