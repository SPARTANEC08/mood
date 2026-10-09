/**
 * Словарь соответствий (алиасов) разговорных и сокращенных названий предметов
 * официальным названиям дисциплин в расписании НИУ МЭИ.
 *
 * Файл вынесен отдельно, чтобы его можно было легко дополнять новыми предметами и синонимами.
 */

export interface SubjectAliasEntry {
  canonicalName: string;
  aliases: string[];
}

export const SUBJECT_ALIASES: SubjectAliasEntry[] = [
  {
    canonicalName: 'Математика',
    aliases: [
      'матан',
      'матеша',
      'математика',
      'вышка',
      'высшая математика',
      'мат',
      'математический анализ',
      'алгебра',
    ],
  },
  {
    canonicalName: 'Информатика',
    aliases: [
      'инфа',
      'прога',
      'программирование',
      'информатика',
      'ит',
      'it',
      'информационные технологии',
    ],
  },
  {
    canonicalName: 'Физика',
    aliases: [
      'физика',
      'физ',
      'физон',
      'общая физика',
    ],
  },
  {
    canonicalName: 'История России',
    aliases: [
      'история',
      'ист',
      'история россии',
      'ир',
    ],
  },
  {
    canonicalName: 'Иностранный язык',
    aliases: [
      'англ',
      'английский',
      'иняз',
      'ин яз',
      'иностранный',
      'иностранный язык',
      'немецкий',
      'французский',
    ],
  },
  {
    canonicalName: 'Основы профессиональной деятельности',
    aliases: [
      'опд',
      'основы проф деятельности',
      'основы профессиональной деятельности',
      'проф деятельность',
      'профдеятельность',
    ],
  },
  {
    canonicalName: 'Основы российской государственности',
    aliases: [
      'орг',
      'государственность',
      'основы российской государственности',
      'основы рос государственности',
      'оргд',
    ],
  },
  {
    canonicalName: 'Элективные дисциплины по физической культуре и спорту',
    aliases: [
      'физра',
      'физ-ра',
      'спорт',
      'физкультура',
      'электив по физкультуре',
      'элективная физкультура',
      'элективные дисциплины по физической культуре и спорту',
      'спортзал',
    ],
  },
  {
    canonicalName: 'Учебная практика: ознакомительная практика',
    aliases: [
      'практика',
      'учебная практика',
      'ознакомительная практика',
      'учебная практика: ознакомительная практика',
    ],
  },
];

/**
 * Нормализует строку для сопоставления (нижний регистр, удаление лишних знаков)
 */
function clean(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Аббревиатура по первым буквам значимых слов: «Основы российской государственности» -> «орг» */
function abbreviation(str: string): string {
  return clean(str)
    .split(' ')
    .filter((w) => w.length > 2)
    .map((w) => w[0])
    .join('');
}

function entryMatchesDiscipline(entry: SubjectAliasEntry, discipline: string): boolean {
  const d = clean(discipline);
  return [entry.canonicalName, ...entry.aliases].some((a) => {
    const ca = clean(a);
    return ca.length >= 4 && (d.includes(ca) || ca.includes(d));
  });
}

/**
 * Находит дисциплины из расписания группы, которые пользователь имел в виду.
 * Возвращает точные названия из расписания (может быть несколько).
 */
export function resolveDisciplines(input: string, scheduleDisciplines: string[]): string[] {
  const q = clean(input);
  if (!q) return [];
  const unique = [...new Set(scheduleDisciplines)];

  // 1. Точное название из расписания
  const exact = unique.filter((d) => clean(d) === q);
  if (exact.length) return exact;

  // 2. Словарь сокращений
  const entry =
    SUBJECT_ALIASES.find((e) => e.aliases.some((a) => clean(a) === q)) ||
    (q.length >= 3 ? SUBJECT_ALIASES.find((e) => e.aliases.some((a) => clean(a).startsWith(q))) : undefined);
  if (entry) {
    const byAlias = unique.filter((d) => entryMatchesDiscipline(entry, d));
    if (byAlias.length) return byAlias;
  }

  // 3. Аббревиатура («орг», «опд», «тоэ»)
  const byAbbr = unique.filter((d) => abbreviation(d) === q.replace(/\s/g, ''));
  if (byAbbr.length) return byAbbr;

  // 4. Начало названия или любого слова
  if (q.length >= 3) {
    const byPrefix = unique.filter((d) => {
      const cd = clean(d);
      return cd.startsWith(q) || cd.split(' ').some((w) => w.startsWith(q));
    });
    if (byPrefix.length) return byPrefix;
  }

  return [];
}
