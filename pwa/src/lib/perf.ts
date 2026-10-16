/**
 * Замеры времени на клиенте.
 *
 * Зачем. Проблема «первый вход очень долгий» не решается чтением кода: нужен
 * фактический порядок и длительность запросов на том устройстве, где тормозит.
 * Всё, что здесь есть, — только console.log: ничего не отправляется на сервер,
 * ничего не собирается и не сохраняется.
 *
 * Как включить на телефоне. Добавить к адресу параметр `?perf=1`:
 *
 *   https://<домен>/?perf=1
 *
 * Либо один раз выполнить в консоли на телефоне:
 *
 *   localStorage.setItem('hub_perf', '1')
 *
 * Флаг держится до перезагрузки страницы: `?perf=1` действует только на текущий
 * заход, ключ в localStorage — до явной отмены
 * (`localStorage.removeItem('hub_perf')`).
 *
 * Почему не всегда включено. В обычном режиме логов нет вовсе: консоль на
 * телефоне всё равно не видна, а лишние строки на каждый запрос — это шум в
 * отладке и лишняя работа на слабом устройстве.
 */

const STORAGE_KEY = 'hub_perf';

/** Разбор флага один раз: он не меняется в течение сессии. */
const enabled = ((): boolean => {
  try {
    if (new URLSearchParams(window.location.search).get('perf') === '1') return true;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Приватный режим и отключённое хранилище — замеры просто выключены.
    return false;
  }
})();

/** Включены ли замеры: компоненты, которые логируют по условию, зовут это. */
export function isPerfEnabled(): boolean {
  return enabled;
}

/**
 * Одна строка замера.
 *
 * Формат `[perf] <что> <сколько>мс` выбран такой, чтобы вывод консоли можно было
 * выделить одним фильтром и прочитать построчно — именно его и присылают на
 * разбор.
 */
export function perfLog(stage: string, ms?: number): void {
  if (!enabled) return;

  if (ms === undefined) {
    console.log(`[perf] ${stage}`);
    return;
  }

  console.log(`[perf] ${stage} ${ms}ms`);
}

/**
 * Замер участка кода: возвращает его результат и печатает время.
 *
 * Функция, а не просто счётчик, потому что почти все нужные замеры — это
 * «обернуть await и узнать, сколько он длился», а писать это руками в каждом
 * месте значит забыть в одном из них.
 */
export async function perfTimed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  perfLog(`${stage} start`);

  try {
    return await fn();
  } finally {
    perfLog(`${stage} done`, Date.now() - startedAt);
  }
}