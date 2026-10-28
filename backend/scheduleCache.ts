/**
 * Кэш расписания по группам.
 *
 * Расписание меняется редко, а парсинг ts.mpei.ru — самый дорогой внешний
 * запрос приложения. Поэтому:
 *
 * - свежесть календарная: данные, загруженные после последнего воскресенья
 *   00:00 МСК, считаются актуальными до следующего воскресенья;
 * - разобранное расписание хранится не только в памяти, но и в SQLite:
 *   рестарт сервера и повторные заходы не вызывают новый парсинг;
 * - параллельные запросы одной группы дедуплицируются одним промисом;
 * - память ограничена LRU-потолком, а устаревшая копия остаётся запасным
 *   вариантом, если МЭИ недоступен в момент недельного обновления.
 *
 * Ручной force-refresh обходит недельное правило и очищает постоянную копию.
 */

import { scheduleCacheStore } from '../db/storage/scheduleCacheStore.ts';
import { fetchScheduleFromMpei } from './parser/mpeiApi.ts';
import { parseSchedule } from './parser/scheduleParser.ts';
import type { ParsedSchedule } from './parser/types.ts';

/**
 * Расписание обновляется раз в неделю, в воскресенье 00:00 МСК.
 *
 * Это не «TTL 7 дней от загрузки», а календарная граница: все группы,
 * загруженные на прошедшей неделе, считаются свежими до ближайшего
 * воскресенья. В 00:00 кэш становится старым, и первый запрос группы
 * перезагружает её. Ручной force-refresh по-прежнему обходит это правило.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Потолок кэша по числу групп. При 0.24 МБ на группу 50 групп — это 12 МБ,
 * то есть потолок срабатывает раньше, чем память становится проблемой.
 * Стоит как защита от роста, а не как способ выиграть память.
 */
const MAX_GROUPS = 50;

interface CacheEntry {
  schedule: ParsedSchedule;
  /** Когда данные реально пришли с ts.mpei.ru. */
  fetchedAt: number;
  /** Приблизительный размер в байтах, для учёта лимита. */
  bytes: number;
}

/** Начало последнего воскресенья 00:00 МСК, ms. */
function lastSundayMidnightMsk(nowMs: number): number {
  const msk = new Date(nowMs + MSK_OFFSET_MS);
  const todayMsk = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - MSK_OFFSET_MS;
  // getUTCDay(): 0 — воскресенье, 1 — понедельник, ...
  return todayMsk - msk.getUTCDay() * DAY_MS;
}

/** Свежесть: загружено после последнего воскресного рубежа. */
function isFresh(fetchedAt: number, nowMs: number): boolean {
  return fetchedAt >= lastSundayMidnightMsk(nowMs);
}

/**
 * Пригодно ли расписание для кэша.
 *
 * Пустой ответ МЭИ — не «у группы нет пар», а сбой их API: для некоторых групп
 * широкий диапазон дат возвращает пустой массив, хотя без диапазона занятия
 * есть. Такой ответ нельзя ни отдавать как свежий, ни записывать поверх
 * хорошей копии — иначе расписание «пропадает» до следующего воскресенья.
 */
export function isUsableSchedule(schedule: ParsedSchedule | undefined): schedule is ParsedSchedule {
  return Boolean(schedule && Array.isArray(schedule.days) && schedule.days.length > 0);
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
 * Держит память под потолком по LRU. Устаревшие записи не выбрасываем: они
 * остаются запасным вариантом, если МЭИ недоступен в момент недельного
 * обновления. Постоянная копия всё равно лежит в SQLite.
 */
function evict(): void {
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
      /*
       * Сначала широкий диапазон. Если МЭИ вернул пустой массив — это не
       * «нет пар», а особенность их API для части групп: без диапазона те же
       * занятия приходят нормально. Повторяем без дат, прежде чем что-то
       * записывать.
       */
      let rawLessons = await fetchScheduleFromMpei(groupId, getScheduleDateRange());

      if (rawLessons.length === 0) {
        console.warn(
          `[ScheduleCache] МЭИ вернул пусто по диапазону для группы ${groupId}, повторяю без диапазона`,
        );
        rawLessons = await fetchScheduleFromMpei(groupId);
      }

      const parsed = parseSchedule(rawLessons, { id: groupId, label, description });

      /*
       * Пустое расписание не кэшируем. Если была хорошая копия — считаем это
       * сбоем и отдаём её (catch ниже); если копии нет, возвращаем пусто, но
       * не пишем на диск, чтобы следующий запрос попробовал снова.
       */
      if (!isUsableSchedule(parsed)) {
        const previous = byHot.get(groupId)?.schedule ?? scheduleCacheStore.get(groupId)?.schedule;
        if (isUsableSchedule(previous)) {
          throw new Error('МЭИ вернул пустое расписание');
        }

        loadState.set(groupId, { fetchedAt: 0, bytes: 0, inflight: null });
        return parsed;
      }

      const bytes = estimateBytes(parsed);
      const fetchedAt = Date.now();

      // Сначала диск: если процесс упадёт между шагами, свежая копия всё
      // равно переживёт рестарт.
      scheduleCacheStore.put(groupId, parsed, fetchedAt);
      loadState.set(groupId, { fetchedAt, bytes, inflight: null });
      byHot.set(groupId, { schedule: parsed, fetchedAt, bytes });
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

  // Свежая память: до ближайшего воскресенья 00:00 МСК. Пустую копию
  // игнорируем — это след сбоя, а не реальное расписание.
  if (cached && isFresh(cached.fetchedAt, nowMs) && isUsableSchedule(cached.schedule)) {
    touch(groupId, cached);
    return cached.schedule;
  }

  // Память пуста или устарела — смотрим постоянную копию. Это главный путь
  // после рестарта сервера и для гостей, которые заходят в группу впервые.
  const persisted = scheduleCacheStore.get(groupId);
  if (persisted && isFresh(persisted.fetchedAt, nowMs) && isUsableSchedule(persisted.schedule)) {
    const bytes = estimateBytes(persisted.schedule);
    loadState.set(groupId, { fetchedAt: persisted.fetchedAt, bytes, inflight: null });
    byHot.set(groupId, { schedule: persisted.schedule, fetchedAt: persisted.fetchedAt, bytes });
    evict();
    return persisted.schedule;
  }

  try {
    return await load(groupId, label, description);
  } catch (err: unknown) {
    /*
     * Недельное обновление не должно оставлять человека без расписания:
     * если МЭИ недоступен, показываем последнюю удачную копию. Следующий
     * запрос снова попробует обновить её.
     */
    const fallback = isUsableSchedule(cached?.schedule)
      ? cached
      : isUsableSchedule(persisted?.schedule)
        ? persisted
        : null;

    if (fallback) {
      console.warn(
        `[ScheduleCache] обновление группы ${groupId} не удалось, отдаю кэш от ${new Date(fallback.fetchedAt).toISOString()}:`,
        err instanceof Error ? err.message : err,
      );
      const bytes = estimateBytes(fallback.schedule);
      loadState.set(groupId, { fetchedAt: fallback.fetchedAt, bytes, inflight: null });
      byHot.set(groupId, { schedule: fallback.schedule, fetchedAt: fallback.fetchedAt, bytes });
      evict();
      return fallback.schedule;
    }
    throw err;
  }
}

/**
 * Сбрасывает кэш. Без groupId — целиком (используется в /reflash), с groupId —
 * только одну группу.
 */
export function clearScheduleCache(groupId?: number): void {
  if (groupId !== undefined) {
    byHot.delete(groupId);
    loadState.delete(groupId);
    scheduleCacheStore.delete(groupId);
  } else {
    byHot.clear();
    loadState.clear();
    scheduleCacheStore.delete();
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