/**
 * Время всегда считаем по Москве, независимо от часового пояса сервера.
 */
const TZ = 'Europe/Moscow';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface MoscowMoment {
  /** YYYY.MM.DD */
  rawDate: string;
  /** HH:MM */
  time: string;
}

export function toMoscow(date: Date = new Date()): MoscowMoment {
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) p[part.type] = part.value;
  return { rawDate: `${p.year}.${p.month}.${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** DD.MM.YYYY -> YYYY.MM.DD (остальное возвращает как есть) */
export function normalizeRawDate(value: string): string {
  const clean = (value || '').trim();
  const m = clean.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : clean;
}

/** YYYY.MM.DD -> DD.MM.YYYY */
export function formatDisplayDate(rawDate: string): string {
  const m = (rawDate || '').match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : rawDate;
}
