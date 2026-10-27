/**
 * Постоянный кэш разобранного расписания по группам.
 *
 * Парсинг ts.mpei.ru — самый дорогой внешний запрос приложения, а само
 * расписание меняется редко. Держим последнюю удачную копию в SQLite, чтобы
 * рестарт процесса и повторные заходы не приводили к новому парсингу. Свежесть
 * проверяет scheduleCache: по умолчанию — раз в неделю, в воскресенье 00:00 МСК.
 */

import type { ParsedSchedule } from '../../backend/parser/types.ts';
import { getDb } from '../sqlite.ts';

export interface CachedSchedule {
  schedule: ParsedSchedule;
  /** Когда данные реально пришли с ts.mpei.ru, ms. */
  fetchedAt: number;
}

interface CachedRow {
  fetched_at: number;
  data: string;
}

export const scheduleCacheStore = {
  get(groupId: number): CachedSchedule | undefined {
    const row = getDb()
      .prepare('SELECT fetched_at, data FROM schedule_cache WHERE group_id = ?')
      .get(String(groupId)) as CachedRow | undefined;

    if (!row) return undefined;

    try {
      const schedule = JSON.parse(row.data) as ParsedSchedule;
      if (!schedule || !Array.isArray(schedule.days)) return undefined;
      return { schedule, fetchedAt: Number(row.fetched_at) || 0 };
    } catch {
      // Битая строка не должна ронять расписание: считаем, что кэша нет.
      return undefined;
    }
  },

  put(groupId: number, schedule: ParsedSchedule, fetchedAt: number): void {
    try {
      getDb()
        .prepare(
          'INSERT INTO schedule_cache(group_id, fetched_at, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(group_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
        )
        .run(String(groupId), fetchedAt, JSON.stringify(schedule));
    } catch (err: unknown) {
      console.error(
        '[ScheduleCache] не удалось сохранить расписание группы:',
        err instanceof Error ? err.message : err,
      );
    }
  },

  delete(groupId?: number): void {
    if (groupId === undefined) {
      getDb().exec('DELETE FROM schedule_cache');
      return;
    }
    getDb().prepare('DELETE FROM schedule_cache WHERE group_id = ?').run(String(groupId));
  },

  /** Только для тестов/сброса. */
  reset(): void {
    getDb().exec('DELETE FROM schedule_cache');
  },
};
