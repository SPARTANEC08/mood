/**
 * Диагностика производительности прямо на устройстве.
 *
 * Зачем она нужна. Замеры в Chrome давали 37 мс на переключение вкладки и
 * 16 мс на смену дня — то есть «всё быстро». На iPhone Safari при этом
 * интерфейс лагает. Значит, лаги порождает то, чего в Chrome нет: другой
 * композитинг, другие ограничения WebKit, реальная ширина канала. Угадывать
 * по этому нельзя, нужно померить на том устройстве, где тормозит.
 *
 * Поэтому здесь считается ровно то, что покажет, где именно теряется кадр:
 *   - частота кадров за последние секунды (главный признак лагов);
 *   - длинные задачи — сколько раз главный поток был занят дольше 50 мс;
 *   - худшая задача и суммарное занятие потока;
 *   - версия сборки, чтобы отличить свежую от закешированной в SW.
 *
 * Метрики standards-based, специально без выделения памяти: performance.memory
 * есть только в Chromium, а на iPhone его нет, и диагностика работала бы
 * ровно там, где нужнее всего.
 *
 * Включается адресом с ?debug=1. Ни на что обычное не влияет.
 */

interface Sample {
  at: number;
  frames: number;
  longTasks: number[];
}

let frames = 0;
let longTasks: number[] = [];

let observer: PerformanceObserver | null = null;
let rafId = 0;
const samples: Sample[] = [];
const subscribers = new Set<() => void>();

function resetCounters(): void {
  frames = 0;
  longTasks = [];
}

/** Раз в секунду: снимает счётчики и будит подписчиков. */
function tick(): void {
  frames++;
  rafId = requestAnimationFrame(tick);
}

function startWatchers(): void {
  resetCounters();

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push(Math.round(entry.duration));
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // В старых WebKit longtask нет — замер сойдётся к одному лишь FPS.
    observer = null;
  }

  rafId = requestAnimationFrame(tick);

  setInterval(() => {
    const now = performance.now();
    samples.push({ at: now, frames, longTasks: [...longTasks] });
    if (samples.length > 30) samples.shift();
    resetCounters();
    for (const fn of subscribers) fn();
  }, 1000);
}

export interface Diagnostics {
  /** Метрики за последние 5 секунд. */
  fps: number;
  /** Кадров в секунду за последнюю секунду. */
  fpsLast: number;
  /** Сколько длинных задач (>50 мс) за последние 5 секунд. */
  longTasksRecent: number;
  /** Худшая длинная задача, мс. */
  worstLongTask: number;
  /** Процент времени, когда главный поток был занят длинными задачами. */
  busyPercent: number;
  /** Всего замеров. */
  sampleCount: number;
}

export function getDiagnostics(): Diagnostics {
  const recent = samples.slice(-5);

  if (recent.length === 0) {
    return { fps: 0, fpsLast: 0, longTasksRecent: 0, worstLongTask: 0, busyPercent: 0, sampleCount: 0 };
  }

  const totalFrames = recent.reduce((a, s) => a + s.frames, 0);
  const totalTasks = recent.reduce((a, s) => a + s.longTasks.length, 0);
  const totalBusy = recent.reduce((a, s) => a + s.longTasks.reduce((x, y) => x + y, 0), 0);

  // Один замер — ровно одна секунда (интервал опроса), поэтому делим на число
  // секунд, а не на миллисекунды. Прежнее деление на recent.length * 1000
  // давало 0.6 вместо 60 — цифра выглядела как «лаги», хотя кадров было 60.
  const seconds = recent.length;

  return {
    fps: Math.round((totalFrames / seconds) * 10) / 10,
    fpsLast: recent[recent.length - 1].frames,
    longTasksRecent: totalTasks,
    worstLongTask: recent.reduce((a, s) => a + Math.max(0, ...s.longTasks), 0),
    busyPercent: Math.round((totalBusy / (seconds * 1000)) * 100),
    sampleCount: samples.length,
  };
}

/** Подписка на обновление раз в секунду. */
export function subscribeDiagnostics(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Сбрасывает накопленное — удобно перед конкретным действием. */
export function resetDiagnostics(): void {
  samples.length = 0;
  resetCounters();
  for (const fn of subscribers) fn();
}

let started = false;

/** Запускает счётчики. Идемпотентно: повторный вызов ничего не меняет. */
export function startDiagnostics(): void {
  if (started) return;
  started = true;
  startWatchers();
}

export function stopDiagnostics(): void {
  if (!started) return;
  started = false;
  observer?.disconnect();
  observer = null;
  cancelAnimationFrame(rafId);
}

/**
 * Версия Service Worker, какая реально отдаётся сервером.
 *
 * Метка __SW_VERSION__ из бандла приложения и версия внутри sw.js — разные
 * строки: бандл собирается в один момент, а sw.js подписывается следующим
 * скриптом. Поэтому версия из бандла показывала бы номер, которого в
 * Service Worker нет, и сравнивать их бесполезно.
 *
 * Здесь читается настоящий файл воркера — ровно то, что сейчас обслуживает
 * офлайн. Именно это и нужно назвать, чтобы понять, какую сборку телефон
 * видит на самом деле.
 */
export async function fetchSwVersion(): Promise<string> {
  try {
    const response = await fetch('/sw.js', { cache: 'no-store' });
    if (!response.ok) return 'не отдаётся';

    const text = await response.text();
    return /const VERSION = '([^']+)'/.exec(text)?.[1] ?? 'не найдена в sw.js';
  } catch {
    return 'не отдаётся';
  }
}

/** Метка сборки, зашитая в бандл. Для сравнения с версией Service Worker. */
export function buildStamp(): string {
  return __SW_VERSION__;
}
