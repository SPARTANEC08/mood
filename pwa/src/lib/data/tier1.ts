/**
 * Tier 1 — критический путь приложения: расписание, домашние задания и
 * «Важное», а также мгновенный старт из localStorage (SWR).
 *
 * Здесь живут операции и помощники первого уровня, а состояние (useState/useRef)
 * держит провайдер в data/context.tsx — это разделение «операции ↔ состояние»
 * сохраняет поведение и один-единственный владелец состояния на всё приложение.
 *
 * Ключи localStorage и момент синхронного чтения кэша (в инициализаторе useState,
 * до первого рендера) не менялись: иначе расписание мигнуло бы пустым состоянием.
 */

import type { Dispatch, SetStateAction } from 'react';

import { ApiError, api } from '@/lib/api';
import { shiftRawDate, todayRawMoscow } from '@/lib/dates';
import type { ApiHomework, ApiImportant, ScheduleResponse } from '@/types/api';

/** Через сколько минут тихо перезапрашивать данные после возврата к приложению. */
export const VISIBILITY_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Насколько назад запрашивать ДЗ.
 *
 * Расписание показывает окно −14…+90 дней (см. getScheduleDateRange на сервере),
 * и задания из расписания приходят за ВЕСЬ этот диапазон — включая прошедшие
 * дни. Полные записи (с вложениями) нужны каждому заданию на экране, поэтому и
 * список ДЗ берётся от той же границы.
 *
 * Раньше запрос шёл без `from`, то есть «сегодня и дальше»: задания расписания
 * за прошедшие две недели оставались без полной записи, и карточка пары
 * навсегда показывала «Файлы загружаются…».
 */
const HOMEWORK_LOOKBACK_DAYS = 14;

/** С какой даты брать ДЗ, чтобы покрыть окно расписания целиком. */
function homeworkFrom(): string {
  return shiftRawDate(todayRawMoscow(), -HOMEWORK_LOOKBACK_DAYS);
}

/**
 * Ключи хранилища.
 *
 * userId входит в ключ данных намеренно: на одном телефоне могут входить разные
 * люди, и кэш одного не должен подмешиваться к другому.
 */
export const CACHE_KEYS = {
  profile: 'mood_cache_profile',
  schedule: 'mood_cache_schedule',
  homework: 'mood_cache_homework',
  important: 'mood_cache_important',
} as const;

export interface PersistedCore {
  schedule: ScheduleResponse | null;
  homework: ApiHomework[];
  important: ApiImportant[];
  savedAt: number;
}

export type Tier1Core = {
  schedule: ScheduleResponse | null;
  homework: ApiHomework[];
  important: ApiImportant[];
};

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Приватный режим Safari, отключённое хранилище или битый JSON: молча
    // работаем без кэша, это не повод не открывать приложение.
    return null;
  }
}

/**
 * Верхняя граница одной записи в localStorage.
 *
 * Расписание за окно −14…+90 дней может весить мегабайты. Без потолка одна
 * запись способна съесть всю квоту (в Safari ~5 МБ на origin), и тогда молча
 * перестанут писаться ДЗ и «Важное». Слишком большой кэш просто не сохраняем:
 * приложение работает, но стартует из сети.
 */
const MAX_ENTRY_BYTES = 3 * 1024 * 1024;

export function writeJson(key: string, value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_ENTRY_BYTES) {
      console.warn(`[cache] ${key} слишком большой для localStorage (${serialized.length} Б) — пропускаю`);
      return;
    }
    window.localStorage.setItem(key, serialized);
  } catch {
    // Квота исчерпана или хранилище недоступно. Приложение работает и без кэша.
  }
}

/**
 * Полный сброс локального кэша данных.
 *
 * Зовётся при ЯВНОМ выходе (кнопка «Выйти»), но НЕ при закрытии вкладки: тогда
 * следующее открытие должно взять расписание из кэша мгновенно. Стираются и
 * общие данные Tier 1, и запомненный день расписания — иначе на экране входа
 * следующего человека остался бы чужой день.
 */
export function clearPersistedData(): void {
  try {
    const keys: string[] = [];

    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith('mood_cache_') || key.startsWith('mood_last_day:'))) {
        keys.push(key);
      }
    }

    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Хранилище недоступно — стирать нечего.
  }
}

/** Синхронно поднимает сохранённые данные: чтение идёт в useState-инициализаторе. */
export function readPersisted(userId: string): PersistedCore | null {
  const persisted = readJson<PersistedCore>(`${CACHE_KEYS.schedule}:${userId}`);
  if (!persisted) return null;

  return {
    schedule: persisted.schedule ?? null,
    homework: readJson<ApiHomework[]>(`${CACHE_KEYS.homework}:${userId}`) ?? [],
    important: readJson<ApiImportant[]>(`${CACHE_KEYS.important}:${userId}`) ?? [],
    savedAt: typeof persisted.savedAt === 'number' ? persisted.savedAt : 0,
  };
}

/** Сегодня по Москве — тем же способом, что и остальной клиент. */
export function todayMoscow(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow' }).format(new Date());
}

/**
 * Ставит фоновую загрузку файлов верхних записей.
 *
 * Вызывается после того, как списки уже применены, и намеренно без await:
 * предзагрузка — это подарок следующему тапу, а не условие показа экрана.
 * Качаются ПРЕВЬЮ, а не оригиналы: в ленте видно только их.
 */
export function warmFiles(homework: ApiHomework[], important: ApiImportant[]): void {
  const files = [...homework, ...important].flatMap((item) => item.files ?? []);

  // Не-изображения (PDF, документы) превью не имеют: предзагрузка была бы вхолостую.
  const ids = files.filter((f) => f.mimeType.startsWith('image/')).map((f) => f.fileId);
  if (ids.length > 0) void prefetchPreviews(ids);
}

/**
 * Кэш превью.
 *
 * Отдельный от fileCache и намеренно: у fileCache потолок 80 МБ с вытеснением по
 * возрасту, и полные фотографии вытеснили бы из него превью, на которых держится
 * лента. Здесь своя карта и скромный потолок.
 */
const previewBlobs = new Map<string, string>();
const PREVIEW_CACHE_LIMIT = 120;

/** Сколько превью берём из одного списка — как и в fileCache. */
const MAX_PREFETCH_PER_LIST = 20;

function storePreview(fileId: string, url: string): void {
  if (previewBlobs.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = previewBlobs.keys().next();
    if (!oldest.done) {
      const stale = previewBlobs.get(oldest.value);
      if (stale) URL.revokeObjectURL(stale);
      previewBlobs.delete(oldest.value);
    }
  }

  previewBlobs.set(fileId, url);
}

/**
 * Предзагружает превью изображений.
 *
 * Промис никогда не отклоняется: это фон без наблюдателя. Ошибка здесь не
 * должна ломать ленту — превью просто подтянется при следующем открытии.
 */
async function prefetchPreviews(fileIds: string[]): Promise<void> {
  const queue = [...new Set(fileIds)]
    .slice(0, MAX_PREFETCH_PER_LIST)
    .filter((id) => !previewBlobs.has(id));

  const CONCURRENCY = 3;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      try {
        const url = await api.previewUrl(id);
        storePreview(id, url);
      } catch {
        // Превью не получилось — лента покажет заглушку, а при тапе приложение
        // попробует ещё раз.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

/** Забывает превью при смене аккаунта: в них видно изображение чужого задания. */
export function clearPreviewCache(): void {
  for (const url of previewBlobs.values()) URL.revokeObjectURL(url);
  previewBlobs.clear();
}

/* ─────────────────────────────── операции ─────────────────────────────── */

export interface Tier1Refs {
  coreRef: { current: Tier1Core };
  tier1At: { current: number };
  dayAt: { current: string };
}

export interface Tier1Setters {
  setSchedule: Dispatch<SetStateAction<ScheduleResponse | null>>;
  setHomework: Dispatch<SetStateAction<ApiHomework[]>>;
  setImportant: Dispatch<SetStateAction<ApiImportant[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Пишет расписание и списки в localStorage.
 *
 * В JSON-сторе «в лоб» было бы два дорогих шага на главном потоке: сериализация
 * всех трёх записей (расписание за окно −14…+90 дней — это до мегабайтов, свой
 * же предел записи — 3 МБ) и синхронный `localStorage.setItem`. Делать это в
 * кадре жеста нельзя: палец ещё тянет ленту, а браузер уже stringify-ит мегабайты.
 *
 * Поэтому значения снимаются сразу (пока они актуальны), а запись уходит в idle:
 *   - последняя запланированная побеждает (промежуточные версии не нужны);
 *   - `timeout` гарантирует запись даже на занятом потоке;
 *   - если страницу закрыли раньше — потеряется только кэш, данные придут из сети.
 */
export function persistCore(cacheUserId: string, coreRef: { current: Tier1Core }): void {
  if (!cacheUserId) return;

  const core = coreRef.current;
  const userId = cacheUserId;
  const schedule = core.schedule;
  const homework = core.homework;
  const important = core.important;

  scheduleIdleWrite(() => {
    // Расписание меняется раз в неделю, ДЗ и «Важное» — чаще. Раньше при
    // каждом обновлении заново сериализовались все три записи, включая
    // мегабайтное расписание. Сравниваем ссылки: сеттер провайдера всегда
    // кладёт новый объект/массив, поэтому неизменённая ссылка означает
    // неизменённые данные.
    if (lastPersisted?.userId !== userId) lastPersisted = null;
    const previous = lastPersisted;

    if (!previous || previous.schedule !== schedule) {
      writeJson(`${CACHE_KEYS.schedule}:${userId}`, { schedule, savedAt: Date.now() });
    }
    if (!previous || previous.homework !== homework) {
      writeJson(`${CACHE_KEYS.homework}:${userId}`, homework);
    }
    if (!previous || previous.important !== important) {
      writeJson(`${CACHE_KEYS.important}:${userId}`, important);
    }

    lastPersisted = { userId, schedule, homework, important };
  });
}

/** Что уже лежит в localStorage — для пропуска неизменившихся записей. */
let lastPersisted: {
  userId: string;
  schedule: Tier1Core['schedule'];
  homework: Tier1Core['homework'];
  important: Tier1Core['important'];
} | null = null;

/** Отложенная запись: одна за раз, последняя версия побеждает. */
let pendingWrite: (() => void) | null = null;
let writeScheduled = false;

function runPendingWrite(): void {
  writeScheduled = false;
  const job = pendingWrite;
  pendingWrite = null;
  try {
    job?.();
  } catch {
    // Запись в кэш не должна ломать приложение ни при каких обстоятельствах.
  }
}

function scheduleIdleWrite(job: () => void): void {
  pendingWrite = job;
  if (writeScheduled) return;
  writeScheduled = true;

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(runPendingWrite, { timeout: 2000 });
  } else {
    window.setTimeout(runPendingWrite, 0);
  }
}

/**
 * Tier 1: расписание, ДЗ и «Важное».
 *
 * `silent` — фоновое обновление: состояние `loading` не трогается, человек
 * продолжает видеть старые (свежие для него) данные до ответа.
 */
export async function loadTier1(
  opts: { silent: boolean; forceSchedule?: boolean; guest?: boolean },
  refs: Tier1Refs,
  setters: Tier1Setters,
  persist: () => void,
): Promise<void> {
  if (opts.silent) setters.setRefreshing(true);
  else setters.setLoading(true);
  setters.setError(null);

  /*
   * Гость видит только расписание. ДЗ, «Важное», оценки и почта для него
   * закрыты на сервере, поэтому даже не пытаемся их запрашивать: иначе каждый
   * вход гостя давал бы три лишних 401 и мигал бы ошибками.
   */
  if (opts.guest) {
    const [scheduleRes] = await Promise.allSettled([
      api.schedule(opts.forceSchedule ? { force: true } : undefined),
    ]);

    if (scheduleRes.status === 'fulfilled') {
      refs.coreRef.current.schedule = scheduleRes.value;
      setters.setSchedule(scheduleRes.value);
    } else if (refs.coreRef.current.schedule === null) {
      setters.setError(
        scheduleRes.reason instanceof ApiError
          ? scheduleRes.reason.message
          : 'Не удалось загрузить расписание.',
      );
    }

    refs.coreRef.current.homework = [];
    refs.coreRef.current.important = [];
    setters.setHomework([]);
    setters.setImportant([]);

    persist();
    refs.tier1At.current = Date.now();
    refs.dayAt.current = todayMoscow();
    setters.setLoading(false);
    setters.setRefreshing(false);
    return;
  }

  // Запросы идут параллельно и независимо: у каждого свой блок в интерфейсе.
  const [scheduleRes, homeworkRes, importantRes] = await Promise.allSettled([
    api.schedule(opts.forceSchedule ? { force: true } : undefined),
    api.homework({ from: homeworkFrom() }),
    api.important(),
  ]);

  if (scheduleRes.status === 'fulfilled') {
    refs.coreRef.current.schedule = scheduleRes.value;
    setters.setSchedule(scheduleRes.value);
  } else if (refs.coreRef.current.schedule === null) {
    // Ошибкой считаем только провал расписания: без него приложение пустое.
    // Если расписание уже есть на экране, ошибку не показываем.
    setters.setError(
      scheduleRes.reason instanceof ApiError
        ? scheduleRes.reason.message
        : 'Не удалось загрузить расписание.',
    );
  }

  if (homeworkRes.status === 'fulfilled') {
    refs.coreRef.current.homework = homeworkRes.value.items;
    setters.setHomework(homeworkRes.value.items);
  }

  if (importantRes.status === 'fulfilled') {
    refs.coreRef.current.important = importantRes.value.items;
    setters.setImportant(importantRes.value.items);
  }

  // Файлы верхних записей уходят в фон уже после применения списков.
  warmFiles(
    homeworkRes.status === 'fulfilled' ? homeworkRes.value.items : [],
    importantRes.status === 'fulfilled' ? importantRes.value.items : [],
  );

  persist();

  refs.tier1At.current = Date.now();
  refs.dayAt.current = todayMoscow();
  setters.setLoading(false);
  setters.setRefreshing(false);
}

export interface ReloadListsSetters {
  setHomework: Dispatch<SetStateAction<ApiHomework[]>>;
  setImportant: Dispatch<SetStateAction<ApiImportant[]>>;
}

/**
 * Перезапрашивает только списки ДЗ и важного (без БАРС и IMAP).
 *
 * Возвращает текст ошибки или null. Списки грузятся независимо, поэтому
 * «упало одно из двух» — это всё ещё частичный успех: то, что пришло, уже
 * применено, а сообщение говорит только о неудавшейся половине.
 */
export async function reloadLists(
  coreRef: { current: Tier1Core },
  setters: ReloadListsSetters,
): Promise<string | null> {
  const [hw, imp] = await Promise.allSettled([
    api.homework({ from: homeworkFrom() }),
    api.important(),
  ]);

  // coreRef обновляется здесь же: иначе следующая запись в localStorage вернула
  // бы на диск старые списки, а на экране были бы новые.
  if (hw.status === 'fulfilled') {
    coreRef.current.homework = hw.value.items;
    setters.setHomework(hw.value.items);
  }
  if (imp.status === 'fulfilled') {
    coreRef.current.important = imp.value.items;
    setters.setImportant(imp.value.items);
  }

  // Списки обновились — догоняем файлы новых записей в фоне.
  warmFiles(
    hw.status === 'fulfilled' ? hw.value.items : [],
    imp.status === 'fulfilled' ? imp.value.items : [],
  );

  const hwFailed = hw.status === 'rejected';
  const impFailed = imp.status === 'rejected';
  if (!hwFailed && !impFailed) return null;

  const reason = hwFailed ? (hw as PromiseRejectedResult).reason : (imp as PromiseRejectedResult).reason;
  const what = hwFailed && impFailed ? 'задания и «Важное»' : hwFailed ? 'задания' : '«Важное»';

  // Серверный текст информативнее общего («503»), но он есть не всегда.
  return reason instanceof ApiError ? reason.message : `Не удалось обновить ${what}.`;
}

/**
 * Принудительное обновление расписания (pull-to-refresh на «Расписании»).
 *
 * Форсит только расписание: поход в БАРС из-за обновления списков — это лишняя
 * нагрузка на МЭИ. Списки ДЗ и «Важного» перезапрашиваются отдельно в конце.
 *
 * Возвращает текст ошибки или null при успехе. Раньше ошибка оседала только в
 * состоянии (`setError`) и лишь тогда, когда расписания не было вовсе: человек
 * с уже показанным расписанием не видел, что обновление не удалось. Теперь
 * вызывающий код решает сам — например, показывает тост, не убирая ленту.
 */
/**
 * Идущее обновление расписания — для дедупликации.
 *
 * `force=1` обходит серверный кэш вместе с его single-flight, поэтому два жеста
 * подряд (или жест во время возврата в приложение) означали два полных похода в
 * МЭИ. Пока запрос в пути, повторный вызов возвращает тот же промис: спиннер и
 * текст ошибки получают оба вызывающих, а сеть работает один раз.
 */
let scheduleRefreshInFlight: Promise<string | null> | null = null;

export function refreshSchedule(
  refs: Tier1Refs,
  setters: Pick<Tier1Setters, 'setRefreshing' | 'setError' | 'setSchedule'>,
  onReloadLists: () => Promise<unknown>,
  persist: () => void,
): Promise<string | null> {
  if (scheduleRefreshInFlight) return scheduleRefreshInFlight;

  scheduleRefreshInFlight = refreshScheduleOnce(refs, setters, onReloadLists, persist).finally(
    () => {
      scheduleRefreshInFlight = null;
    },
  );

  return scheduleRefreshInFlight;
}

async function refreshScheduleOnce(
  refs: Tier1Refs,
  setters: Pick<Tier1Setters, 'setRefreshing' | 'setError' | 'setSchedule'>,
  onReloadLists: () => Promise<unknown>,
  persist: () => void,
): Promise<string | null> {
  setters.setRefreshing(true);
  setters.setError(null);

  let message: string | null = null;

  try {
    const fresh = await api.schedule({ force: true });
    refs.coreRef.current.schedule = fresh;
    setters.setSchedule(fresh);
  } catch (err: unknown) {
    message = err instanceof ApiError ? err.message : 'Не удалось обновить расписание.';
    // Фатальной ошибка остаётся только когда расписание показывать нечем:
    // пустой экран с текстом лучше пустого экрана без него.
    if (refs.coreRef.current.schedule === null) setters.setError(message);
  } finally {
    refs.tier1At.current = Date.now();
    refs.dayAt.current = todayMoscow();
  }

  try {
    await onReloadLists();
    persist();
  } finally {
    // Спиннер живёт до конца обновления целиком, а не до ответа по расписанию:
    // иначе он гаснет, пока списки ещё в пути, и жест выглядит оборванным.
    setters.setRefreshing(false);
  }

  return message;
}
