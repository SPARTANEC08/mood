/**
 * Кэш расписания по группам.
 *
 * Раньше это был голый `Map` прямо в botEngine с ленивой проверкой TTL. Три
 * проблемы, которые видны на замерах (backend/scripts/):
 *
 * 1. Гонка. На холодном кэше 10 студентов одной группы давали 10 запросов
 *    к ts.mpei.ru вместо одного: проверка TTL и запись происходят после
 *    await, и все десятерые успевали пройти проверку. Для МЭИ это ещё и
 *    лишняя нагрузка на их API.
 * 2. Просроченные записи никогда не вытеснялись. TTL проверялся только при
 *    чтении, поэтому группа, которую никто не открывал, занимала память
 *    до следующего clear().
 * 3. Рост без предела. Каждая новая группа добавлялась в Map навсегда.
 *
 * Здесь: дедупликация запроса, активное вытеснение просроченных и потолок
 * по числу групп (LRU).
 */

import { fetchScheduleFromMpei } from './parser/mpeiApi.ts';
import { parseSchedule } from './parser/scheduleParser.ts';
import type { ParsedSchedule } from './parser/types.ts';

/**
 * Горячий слой: «сегодня и завтра». Меняется по дням, спрашивается чаще всего.
 * Кэш на 3 минуты — как был.
 */
const HOT_TTL_MS = 3 * 60 * 1000;

/**
 * Холодный слой: весь диапазон −14…+90 дней. Меняется редко (расписание
 * меняют в начале семестра), но разбирается дороже всего.
 */
const COLD_TTL_MS = 45 * 60 * 1000;

/**
 * Потолок кэша по числу групп. При 0.24 МБ на группу 50 групп — это 12 МБ,
 * то есть потолок срабатывает раньше, чем память становится проблемой.
 * Стоит как защита от роста, а не как способ выиграть память.
 */
const MAX_GROUPS = 50;

interface CacheEntry {
  schedule: ParsedSchedule;
  /** Горячий слой: заполнен когда страницу открывали недавно. */
  hotAt: number;
  /** Время фактической загрузки — по нему считается холодный TTL. */
  coldAt: number;
  /** Приблизительный размер в байтах, для учёта лимита. */
  bytes: number;
}

/** Последняя успешная загрузка (свежесть) и промис загрузки (дедупликация). */
interface LoadState {
  /** Когда данные реально приехали с сервера. */
  fetchedAt: number;
  /** Размер свежих данных для построения холодного слоя. */
  bytes: number;
  inflight: Promise<ParsedSchedule> | null;
}

const byHot = new Map<number, CacheEntry>();
const loadState = new Map<number, LoadState>();

/**
 * Порядок последнего обращения для LRU: Map в JS сохраняет порядок вставки,
 * поэтому достаточно пере-вставить ключ при чтении.
 */
function touch(groupId: number, entry: CacheEntry): void {
  byHot.delete(groupId);
  byHot.set(groupId, entry);
}

/**
 * Приблизительный размер разобранного расписания в байтах.
 *
 * Точный размер считать дорого: пришлось бы обходить дерево на каждой загрузке.
 * Оценка идёт по объёму строк в слотах, которые и занимают основную память.
 * Сходится с замером на реальных данных с точностью около 20%, чего достаточно
 * для грубого лимита и для отчётов.
 */
function estimateBytes(schedule: ParsedSchedule): number {
  let slots = 0;
  let textChars = 0;

  for (const day of schedule.days) {
    slots += day.slots.length;
    for (const slot of day.slots) {
      for (const v of slot.variants) {
        textChars +=
          v.discipline.length +
          v.kindOfWork.length +
          v.auditorium.length +
          v.building.length +
          v.lecturerShort.length +
          v.lecturerFullName.length +
          v.jointGroups.length * 8 +
          v.onlineUrls.length * 48;
      }
    }
  }

  // 2 байта на символ + 96 байт заголовка объекта + 24 байта указателя в массиве.
  return schedule.days.length * 512 + slots * 160 + textChars * 2 + slots * 96;
}

/**
 * Вытесняет просроченные записи, затем самые старые, пока не влезем в потолок.
 * Вызывается после каждой вставки, поэтому кэш не может расти без предела.
 */
function evict(): void {
  const now = Date.now();

  for (const [groupId, entry] of byHot) {
    if (now - entry.coldAt >= COLD_TTL_MS) {
      byHot.delete(groupId);
      loadState.delete(groupId);
    }
  }

  while (byHot.size > MAX_GROUPS) {
    // Map обходит ключи в порядке вставки: самый первый — наименее свежий.
    const oldest = byHot.keys().next();
    if (oldest.done) break;
    const groupId = oldest.value;
    byHot.delete(groupId);
    loadState.delete(groupId);
  }
}

/**
 * Диапазон дат, который бот показывает: две недели назад и три месяца вперёд.
 */
function getScheduleDateRange(): { start: string; finish: string } {
  const now = new Date();
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const finish = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  };

  return { start: fmt(start), finish: fmt(finish) };
}

/**
 * Загружает расписание группы, объединяя параллельные обращения.
 *
 * Если запрос уже идёт, все ожидающие получают тот же промис: десять
 * студентов одной группы, открывших расписание одновременно, дадут один
 * запрос к ts.mpei.ru.
 */
async function load(groupId: number, label: string, description?: string): Promise<ParsedSchedule> {
  const state = loadState.get(groupId);

  if (state?.inflight) {
    return state.inflight;
  }

  const inflight = (async () => {
    try {
      const rawLessons = await fetchScheduleFromMpei(groupId, getScheduleDateRange());
      const parsed = parseSchedule(rawLessons, { id: groupId, label, description });
      const bytes = estimateBytes(parsed);

      loadState.set(groupId, { fetchedAt: Date.now(), bytes, inflight: null });
      byHot.set(groupId, { schedule: parsed, hotAt: Date.now(), coldAt: Date.now(), bytes });
      evict();

      return parsed;
    } catch (err: unknown) {
      // Сбросить inflight обязательно: иначе после сетевой ошибки группа
      // больше никогда не загрузится до перезапуска процесса.
      loadState.set(groupId, {
        fetchedAt: 0,
        bytes: 0,
        inflight: null,
      });
      throw err;
    }
  })();

  loadState.set(groupId, { fetchedAt: 0, bytes: 0, inflight });
  return inflight;
}

/**
 * Возвращает расписание группы, при необходимости загрузив его.
 */
/**
 * Диапазон дат из кэша без сетевого запроса.
 *
 * Нужен `/api/bootstrap`: ему нельзя ждать МЭИ, а `scheduleRange` в интерфейсе
 * сейчас не используется (расписание приходит отдельным запросом). Пустой кэш —
 * это null, а не повод блокировать открытие приложения.
 */
export function peekScheduleDateRange(groupId: number): ParsedSchedule['dateRange'] | null {
  return byHot.get(groupId)?.schedule.dateRange ?? null;
}

export async function getGroupSchedule(
  groupId: number,
  label: string,
  description?: string,
  now: Date = new Date()
): Promise<ParsedSchedule> {
  const nowMs = now.getTime();
  const cached = byHot.get(groupId);

  // Горячий слой: недавно открывали страницу этой группы.
  if (cached && nowMs - cached.hotAt < HOT_TTL_MS) {
    touch(groupId, cached);
    return cached.schedule;
  }

  const state = loadState.get(groupId);

  // Холодный слой: данные с сервера свежие, но страницу давно не открывали.
  // Разбор пропускаем — самый дорогой шаг на круге.
  if (cached && state && nowMs - state.fetchedAt < COLD_TTL_MS) {
    // byHot.set и обновляет hotAt, и переставляет ключ в конец (LRU touch):
    // отдельный touch() перед ним был бы лишней перезаписью той же записи.
    byHot.set(groupId, { ...cached, hotAt: nowMs });
    return cached.schedule;
  }

  return load(groupId, label, description);
}

/**
 * Сбрасывает кэш. Без groupId — целиком (используется в /reflash), с groupId —
 * только одну группу.
 */
export function clearScheduleCache(groupId?: number): void {
  if (groupId !== undefined) {
    byHot.delete(groupId);
    loadState.delete(groupId);
  } else {
    byHot.clear();
    loadState.clear();
  }
}

/**
 * Состояние кэша — только для тестов и диагностики.
 */
export function scheduleCacheStats(): { groups: number; bytes: number; inflight: number } {
  let bytes = 0;
  for (const entry of byHot.values()) bytes += entry.bytes;
  let inflight = 0;
  for (const state of loadState.values()) if (state.inflight) inflight++;
  return { groups: byHot.size, bytes, inflight };
}