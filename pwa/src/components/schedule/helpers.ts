/**
 * Помощники экрана расписания: перерывы, дни недели и московское время.
 *
 * Вынесены из SchedulePage, чтобы страница отвечала за данные и раскладку, а
 * мелкие чистые функции жили отдельно и не раздували компонент.
 */

import { parseRawDate } from '@/lib/dates';

/** Короткие и полные названия дней недели для клеток без данных расписания. */
export const SHORT_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const LONG_DAYS = [
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Перерыв между парами.
 *
 * Порядок и длительность взяты из учебного расписания института: если между
 * парами окно больше часа, показываем обеденный перерыв — именно так студент и
 * понимает «окно» в расписании.
 */
export function findLunchBreak(
  before: { timeEnd: string },
  current: { timeStart: string },
): { from: string; to: string } | null {
  const start = toMinutes(before.timeEnd);
  const end = toMinutes(current.timeStart);
  const gap = end - start;

  // Окно 12:45–13:45 в расписании МЭИ
  if (start === 765 && end === 825) {
    return { from: before.timeEnd, to: current.timeStart };
  }
  // Любое окно длиннее 60 минут тоже считаем перерывом
  if (gap >= 60) {
    return { from: before.timeEnd, to: current.timeStart };
  }
  return null;
}

export function truncatePreview(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Полное название дня недели для даты, которой нет в выгрузке. */
export function longDayName(raw: string): string {
  const date = parseRawDate(raw);
  if (!date) return 'День';
  return LONG_DAYS[(date.getUTCDay() + 6) % 7];
}

/**
 * Формат даты по Москве — один на весь модуль.
 *
 * Intl.DateTimeFormat НЕ тривиальный объект: создание разбирает локаль и
 * timezone из ICU, это десятки микросекунд и заметная работа на телефоне.
 * Формат создаётся один раз при загрузке модуля.
 */
const MOSCOW_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Сегодня по Москве — та же зона, что и у бота. */
export function toMoscowRaw(now: Date = new Date()): string {
  const parts = MOSCOW_FORMAT.formatToParts(now);

  let year = '';
  let month = '';
  let day = '';

  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }

  return `${year}.${month}.${day}`;
}
