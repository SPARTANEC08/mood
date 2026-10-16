import { MpeiRawLesson, MpeiSearchResult } from './types.ts';

const MPEI_DIRECT_API = 'https://ts.mpei.ru/api';

/**
 * Предел времени на запрос к ts.mpei.ru.
 *
 * Без него fetch ждёт бесконечно, а это единственный поход во внешний сервис,
 * который происходит ВНУТРИ входа (поиск группы по названию из БАРС). Итог был
 * такой: пароль верный, БАРС ответил, а человек смотрит на «Проверяем…», пока
 * портал РУЗ не отпустит соединение — а на медленной мобильной сети это минуты,
 * на лежащем портале — десятки минут.
 *
 * Двадцать секунд — с запасом на медленный канал: за это время нормальный ответ
 * успевает прийти, а «висок» обрывается и превращается в понятное сообщение.
 */
const MPEI_TIMEOUT_MS = 20_000;

export function getApiBaseUrl(): string {
  return MPEI_DIRECT_API;
}

/**
 * Map of common Latin characters mistakenly entered instead of Cyrillic
 */
const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а',
  b: 'в',
  e: 'е',
  k: 'к',
  m: 'м',
  h: 'н',
  o: 'о',
  p: 'р',
  c: 'с',
  t: 'т',
  y: 'у',
  x: 'х',
};

/**
 * Normalize group string:
 * 1. Trim whitespace
 * 2. Convert common look-alike latin letters to cyrillic
 * 3. Normalize dashes
 */
export function normalizeGroupString(input: string): string {
  const trimmed = input.trim();
  const normalizedDash = trimmed.replace(/[—–−]/g, '-');
  return normalizedDash;
}

/**
 * Convert latin look-alike letters to cyrillic for fallback matching
 */
export function latinToCyrillicLookalikes(input: string): string {
  return input
    .split('')
    .map((char) => {
      const lower = char.toLowerCase();
      if (LATIN_TO_CYRILLIC[lower]) {
        const replacement = LATIN_TO_CYRILLIC[lower];
        return char === char.toUpperCase() ? replacement.toUpperCase() : replacement;
      }
      return char;
    })
    .join('');
}

export interface GroupSearchResult {
  success: boolean;
  group?: MpeiSearchResult;
  suggestions?: MpeiSearchResult[];
  error?: string;
}

/**
 * Searches for a group on the official ts.mpei.ru portal.
 * Handles uppercase, lowercase, mixed case, and common typing differences.
 */
export async function searchGroupOnMpei(
  groupInput: string,
  apiBase: string = getApiBaseUrl()
): Promise<GroupSearchResult> {
  const cleanInput = normalizeGroupString(groupInput);

  if (!cleanInput) {
    return {
      success: false,
      error: 'Указан пустой номер группы.',
    };
  }

  // 1. Try search with clean input
  let results = await fetchSearchResults(cleanInput, apiBase);

  // 2. If no results, try with latin-to-cyrillic converted input
  if (results.length === 0) {
    const cyrillicConverted = latinToCyrillicLookalikes(cleanInput);
    if (cyrillicConverted.toLowerCase() !== cleanInput.toLowerCase()) {
      results = await fetchSearchResults(cyrillicConverted, apiBase);
    }
  }

  // 3. Filter only groups
  const groupsOnly = results.filter((item) => item.type === 'group');

  if (groupsOnly.length === 0) {
    // Check if maybe search with prefix yields any suggestions
    const prefix = cleanInput.slice(0, 4);
    const suggestionResults = prefix.length >= 2 ? await fetchSearchResults(prefix, apiBase) : [];
    const suggestions = suggestionResults.filter((item) => item.type === 'group');

    return {
      success: false,
      error: `Группа "${cleanInput}" не найдена на официальном сайте НИУ МЭИ (ts.mpei.ru).`,
      suggestions: suggestions.slice(0, 5),
    };
  }

  // 4. Look for exact case-insensitive match
  const targetLower = cleanInput.toLowerCase();
  const targetCyrillicLower = latinToCyrillicLookalikes(cleanInput).toLowerCase();

  const exactMatch = groupsOnly.find(
    (g) =>
      g.label.trim().toLowerCase() === targetLower ||
      g.label.trim().toLowerCase() === targetCyrillicLower
  );

  if (exactMatch) {
    return {
      success: true,
      group: exactMatch,
    };
  }

  // If there is only 1 group returned and it closely matches
  if (groupsOnly.length === 1) {
    return {
      success: true,
      group: groupsOnly[0],
    };
  }

  // If multiple groups found, check if one starts with target or matches closely
  const closeMatch = groupsOnly.find(
    (g) =>
      g.label.toLowerCase().replace(/[^а-яa-z0-9]/g, '') ===
      targetLower.replace(/[^а-яa-z0-9]/g, '')
  );

  if (closeMatch) {
    return {
      success: true,
      group: closeMatch,
    };
  }

  return {
    success: false,
    error: `Точное совпадение для группы "${cleanInput}" не найдено. Найдено несколько похожих групп.`,
    suggestions: groupsOnly.slice(0, 10),
  };
}

/**
 * Fetch search results from the official MPEI endpoint
 */
async function fetchSearchResults(term: string, apiBase: string): Promise<MpeiSearchResult[]> {
  const url = `${apiBase}/search?term=${encodeURIComponent(term)}&type=group`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MPEI_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Ошибка запроса к официальному сайту НИУ МЭИ: ${message}`);
  }
}

/**
 * Fetches group schedule from official ts.mpei.ru
 *
 * @param groupId Numeric group ID from search (e.g. 21985)
 * @param dateRange Optional start and finish dates in YYYY.MM.DD format
 * @param apiBase Optional API base URL
 */
export async function fetchScheduleFromMpei(
  groupId: number,
  dateRange?: { start?: string; finish?: string },
  apiBase: string = getApiBaseUrl()
): Promise<MpeiRawLesson[]> {
  let url = `${apiBase}/schedule/group/${groupId}`;
  const params: string[] = [];

  if (dateRange?.start && dateRange?.finish) {
    params.push(`start=${encodeURIComponent(dateRange.start)}`);
    params.push(`finish=${encodeURIComponent(dateRange.finish)}`);
  }

  // lng=1 is Russian language
  params.push('lng=1');

  if (params.length > 0) {
    url += `?${params.join('&')}`;
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MPEI_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('Официальный сайт вернул неожиданный формат ответа (ожидался массив занятий).');
    }

    return data as MpeiRawLesson[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Не удалось загрузить расписание с сайта НИУ МЭИ: ${message}`);
  }
}
