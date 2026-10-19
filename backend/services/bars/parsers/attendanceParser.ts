import * as cheerio from 'cheerio';

import { cleanText } from './shared.ts';

/**
 * Одна пропущенная пара в МЭИ равна 2 академическим часам.
 * БАРС в таблице пропусков отдаёт количество ЗАНЯТИЙ, а не часов,
 * поэтому для показа в часах значение нужно умножать на этот коэффициент.
 */
export const ACADEMIC_HOURS_PER_LESSON = 2;

export interface SubjectAttendance {
  discipline: string;
  /** Пропущено пар, как отдаёт БАРС */
  missedLessons: number;
  /** Уважительная причина, пар */
  excusedLessons: number;
  /** Неуважительная причина, пар */
  unexcusedLessons: number;
  /** Пропущено в академических часах (пропущено пар × 2) */
  totalMissedHours: number;
  /** Уважительных часов */
  excusedHours: number;
  /** Неуважительных часов */
  unexcusedHours: number;
}

export interface AttendanceSummary {
  /** Пропущено пар */
  totalMissedLessons: number;
  /** Уважительных пар */
  totalExcusedLessons: number;
  /** Неуважительных пар */
  totalUnexcusedLessons: number;
  /** Всего пропущено академических часов */
  totalMissed: number;
  /** Уважительных академических часов */
  totalExcused: number;
  /** Неуважительных академических часов */
  totalUnexcused: number;
  bySubject: SubjectAttendance[];
  lastUpdated?: string;
}

/**
 * Очищает название дисциплины от суффиксов типа аттестации (экзамен, зачет и т.д.).
 */
function cleanDiscipline(text: string): string {
  const cleaned = cleanText(text);
  return cleaned.replace(/\s*\((?:экзамен|зач[её]т|диф)[\s\S]*?\)$/i, '').trim();
}

/**
 * Безопасно преобразует строковое значение в число, предотвращая NaN при пустых ячейках, дефисах и запятых.
 */
function parseNumber(val: unknown): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  const cleaned = String(val)
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(',', '.')
    .trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Переводит количество пар в академические часы.
 */
function lessonsToHours(lessons: number): number {
  return Math.round(lessons * ACADEMIC_HOURS_PER_LESSON);
}

/**
 * Парсит страницу посещаемости / сводки по пропускам БАРС МЭИ.
 *
 * Важно: колонки БАРС содержат количество ЗАНЯТИЙ (пар), а не академические часы.
 * Одна пара = 2 часа, поэтому часы считаются умножением на ACADEMIC_HOURS_PER_LESSON.
 */
export function parseAttendancePage($: cheerio.CheerioAPI): AttendanceSummary {
  const bySubject: SubjectAttendance[] = [];
  let summaryTotalMissed: number | null = null;
  let summaryTotalExcused: number | null = null;
  let summaryTotalUnexcused: number | null = null;
  let lastUpdated: string | undefined = undefined;

  // 1. Поиск даты обновления / актуализации
  $('body')
    .find('p, span, div, small, em, strong')
    .each((_, el) => {
      if (lastUpdated) return;
      const text = cleanText($(el).clone().children().remove().end().text());
      if (/состояние на|обновлено|актуально на/i.test(text)) {
        const match = text.match(/\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/);
        if (match) lastUpdated = match[0];
      }
    });

  // 2. Поиск верхней сводки или карточек с метриками (если они присутствуют)
  $('.card, .summary, [class*="stat"], [class*="metric"], [class*="alert"]').each((_, card) => {
    const cardText = cleanText($(card).text());
    if (cardText.includes('пропущ') || cardText.includes('посещаем')) {
      const missedMatch = cardText.match(/всего\s*(?:пропущено)?[:\s]*(\d+(?:[.,]\d+)?)/i);
      const excusedMatch = cardText.match(/уважительн\w*[:\s]*(\d+(?:[.,]\d+)?)/i);
      const unexcusedMatch = cardText.match(/(?:неуважительн\w*|без\s+уважительн\w*)[:\s]*(\d+(?:[.,]\d+)?)/i);
      if (missedMatch && summaryTotalMissed === null) summaryTotalMissed = parseNumber(missedMatch[1]);
      if (excusedMatch && summaryTotalExcused === null) summaryTotalExcused = parseNumber(excusedMatch[1]);
      if (unexcusedMatch && summaryTotalUnexcused === null) summaryTotalUnexcused = parseNumber(unexcusedMatch[1]);
    }
  });

  // 3. Поиск таблицы пропусков (#tableSkipSummary или общая таблица с колонками дисциплин и пропусков)
  let table = $('#tableSkipSummary');
  if (!table.length) {
    $('table').each((_, t) => {
      const text = $(t).text();
      if (text.includes('Дисциплина') && (text.includes('Пропущ') || text.includes('Посещаем') || text.includes('уважительн'))) {
        table = $(t);
        return false;
      }
    });
  }

  if (table.length) {
    let missedCol = 2;
    let excusedCol = 3;
    let unexcusedCol = -1;

    // Определяем индексы колонок из заголовка таблицы
    table.find('thead tr, tr').each((_, tr) => {
      const ths = $(tr).find('th');
      if (ths.length >= 2) {
        const hasDisciplineInThisRow = ths.toArray().some((th) =>
          cleanText($(th).text()).toLowerCase().includes('дисциплин'),
        );
        const offset = hasDisciplineInThisRow ? 0 : 1;

        ths.each((idx, th) => {
          const hText = cleanText($(th).text()).toLowerCase();
          if ((hText.includes('пропущ') || hText.includes('проп.')) && !hText.includes('%') && !hText.includes('без')) {
            missedCol = idx + offset;
          }
          if (hText.includes('уважит') && !hText.includes('без')) {
            excusedCol = idx + offset;
          }
          if ((hText.includes('неуважит') || hText.includes('без уважит')) && !hText.includes('%')) {
            unexcusedCol = idx + offset;
          }
        });
      }
    });

    // Обрабатываем строки таблицы предметов
    table.find('tbody tr, tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;

      const firstCellText = cleanText($(tds[0]).text()).toLowerCase();

      // Строка "Всего" / "Итого"
      if (firstCellText.startsWith('всего') || firstCellText.startsWith('итого')) {
        const totalMissed = parseNumber($(tds[missedCol] || tds[2]).text());
        const totalExcused = parseNumber($(tds[excusedCol] || tds[3]).text());
        const totalUnexcused =
          unexcusedCol !== -1
            ? parseNumber($(tds[unexcusedCol]).text())
            : Math.max(0, totalMissed - totalExcused);

        if (summaryTotalMissed === null) summaryTotalMissed = totalMissed;
        if (summaryTotalExcused === null) summaryTotalExcused = totalExcused;
        if (summaryTotalUnexcused === null) summaryTotalUnexcused = totalUnexcused;
        return;
      }

      // Пропускаем адаптивные разделительные строки и пустые строки
      if (tds.length < 4 || !firstCellText) return;

      const rawDiscipline = cleanText($(tds[0]).text());
      const discipline = cleanDiscipline(rawDiscipline);

      // БАРС отдаёт количество ПАР, не часов
      const missedLessons = parseNumber($(tds[missedCol] || tds[2]).text());
      const excusedLessons = parseNumber($(tds[excusedCol] || tds[3]).text());
      const unexcusedLessons =
        unexcusedCol !== -1
          ? parseNumber($(tds[unexcusedCol]).text())
          : Math.max(0, missedLessons - excusedLessons);

      bySubject.push({
        discipline,
        missedLessons,
        excusedLessons,
        unexcusedLessons,
        totalMissedHours: lessonsToHours(missedLessons),
        excusedHours: lessonsToHours(excusedLessons),
        unexcusedHours: lessonsToHours(unexcusedLessons),
      });
    });
  }

  // Расчет итоговых значений, если отсутствовали в сводке или строке "Всего"
  const computedMissedLessons = bySubject.reduce((acc, s) => acc + s.missedLessons, 0);
  const computedExcusedLessons = bySubject.reduce((acc, s) => acc + s.excusedLessons, 0);
  const computedUnexcusedLessons = bySubject.reduce((acc, s) => acc + s.unexcusedLessons, 0);

  const totalMissedLessons = summaryTotalMissed ?? computedMissedLessons;
  const totalExcusedLessons = summaryTotalExcused ?? computedExcusedLessons;
  const totalUnexcusedLessons = summaryTotalUnexcused ?? computedUnexcusedLessons;

  return {
    totalMissedLessons,
    totalExcusedLessons,
    totalUnexcusedLessons,
    totalMissed: lessonsToHours(totalMissedLessons),
    totalExcused: lessonsToHours(totalExcusedLessons),
    totalUnexcused: lessonsToHours(totalUnexcusedLessons),
    bySubject,
    lastUpdated,
  };
}
