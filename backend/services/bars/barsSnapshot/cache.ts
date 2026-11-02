/**
 * Кэш снимков БАРС+почты в памяти и стратегия stale-while-revalidate.
 *
 * Фоновый нотификатор уже ходит в БАРС раз в 20 минут, но его результат нигде
 * не сохранялся для PWA. Здесь общий слой: один поход на пользователя, из
 * которого читают и разделы БАРС, и почта.
 *
 * Чего здесь нет намеренно: записи на диск (снимок — производные данные,
 * переживёт не больше TTL) и вечных кредов.
 */

import type { BarsSnapshotResponse } from '../../../server/types.ts';
import { loadSnapshot } from './load.ts';

/**
 * Сколько живёт снимок.
 *
 * Ровно как период опроса нотификатора: если бы снимок жил дольше, данные на
 * экране незаметно расходились бы с тем, что реально показывает МЭИ, а если бы
 * короче — походы в БАРС шли чаще, чем его собственный фоновый круг.
 */
export const SNAPSHOT_TTL_MS = 20 * 60 * 1000;

/**
 * Потолок по числу пользователей.
 *
 * Снимок одного человека — это десятки килобайт, но пользователей у бота
 * сколько угодно, а память процесса ограничена. При превышении вытесняется
 * самый старый: он всё равно устарел и следующим запросом обновится.
 */
const MAX_SNAPSHOTS = 500;

export interface BarsSnapshotOptions {
  /** Пройти мимо TTL и кэша: так работает POST /api/bars/refresh. */
  force?: boolean;
}

interface StoredSnapshot {
  /** Момент загрузки в миллисекундах — для расчёта TTL. */
  at: number;
  /**
   * Снимок в том виде, в каком он уходит клиенту. Хранится уже готовым и
   * отдаётся тем же объектом: иначе каждый запрос раздела создавал бы копию
   * всего ответа только для того, чтобы отдать её и сразу забыть.
   */
  snapshot: BarsSnapshotResponse;
}

const snapshots = new Map<string, StoredSnapshot>();

/**
 * Загрузки, которые уже идут.
 *
 * Ключ — userId. Второй запрос того же раздела получает тот же промис: без
 * этого два параллельных входа на вкладку дали бы два похода в БАРС.
 */
const inflight = new Map<string, Promise<BarsSnapshotResponse>>();

/** Вытесняет самые старые снимки, пока память не уложится в потолок. */
function evictIfNeeded(): void {
  while (snapshots.size > MAX_SNAPSHOTS) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;

    for (const [key, entry] of snapshots) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }

    if (oldestKey === null) return;
    snapshots.delete(oldestKey);
  }
}

/**
 * Снимок данных БАРС и почты пользователя.
 *
 * Свежий снимок отдаётся сразу. Протухший — тоже сразу, но вместе с фоновым
 * обновлением (stale-while-revalidate): ждать ради того, чтобы показать то же
 * самое, что человек и так видит, незачем.
 *
 * Если снимка нет вовсе, придётся дождаться загрузки: показать тут же нечего,
 * а молча отдать пустые структуры значило бы отдать «нет задолженностей» на
 * вопрос, который даже не задавали.
 */
export async function getBarsSnapshot(
  userId: string,
  barsService: Parameters<typeof loadSnapshot>[0],
  mailClient: Parameters<typeof loadSnapshot>[1],
  opts: BarsSnapshotOptions = {},
): Promise<BarsSnapshotResponse> {
  const now = Date.now();
  const cached = snapshots.get(userId);

  if (!opts.force && cached && now - cached.at < SNAPSHOT_TTL_MS) {
    return cached.snapshot;
  }

  const pending = inflight.get(userId);
  if (pending) return pending;

  const promise = loadSnapshot(barsService, mailClient, {
    // Предыдущий снимок: его медленные разделы (приказы/стипендия/книги/рейтинг)
    // переиспользуются до 6 часов. Без этого зависшая на 30 секунд страница
    // приказов держала весь pull-to-refresh «Успеваемости» и «Кабинета».
    previous: cached?.snapshot,
    previousAt: cached?.at,
  })
    .then((snapshot) => {
      evictIfNeeded();
      snapshots.set(userId, { snapshot, at: Date.now() });
      return snapshot;
    })
    .finally(() => {
      // Обязательно сбрасывается: оставленный промис сделал бы пользователя
      // неработоспособным до перезапуска процесса — после сетевой ошибки
      // повторная попытка стала бы невозможной.
      inflight.delete(userId);
    });

  inflight.set(userId, promise);

  // Протухший снимок есть — отдаём его и обновляем в фоне. При force так
  // делать нельзя: там вызывающий явно попросил СВЕЖИЕ данные, и отдать ему
  // старый снимок значило бы солгать.
  if (cached && !opts.force) {
    // Ошибка фонового обновления никому не адресована: следующий запрос
    // просто попробует снова. Без обработчика она была бы unhandled rejection.
    void promise.catch(() => undefined);
    return cached.snapshot;
  }

  return promise;
}

/** Снимок из памяти без загрузки: для мест, где поход в БАРС недопустим. */
export function peekBarsSnapshot(userId: string): BarsSnapshotResponse | null {
  return snapshots.get(userId)?.snapshot ?? null;
}

/**
 * Забывает снимок пользователя.
 *
 * Вызывается при истечении сессии БАРС: держать в памяти данные, выбранные
 * чужой (уже недействительной) сессией, незачем — иначе после повторного входа
 * приложение продолжило бы показывать то, что было до сброса сессии.
 */
export function invalidateBarsSnapshot(userId: string): void {
  snapshots.delete(userId);
}

/** Счётчики кэша — только для тестов. */
export function barsSnapshotStats(): {
  users: number;
  inflight: number;
  oldestFetchedAt: number | null;
} {
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const entry of snapshots.values()) {
    if (entry.at < oldestAt) oldestAt = entry.at;
  }

  return {
    users: snapshots.size,
    inflight: inflight.size,
    oldestFetchedAt: Number.isFinite(oldestAt) ? oldestAt : null,
  };
}
