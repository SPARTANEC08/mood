/**
 * Публичный вход в кэш снимков БАРС+почты.
 *
 * Файл оставлен как тонкая точка входа: импорты (`getBarsSnapshot`,
 * `peekBarsSnapshot`, `invalidateBarsSnapshot`, `SNAPSHOT_TTL_MS`,
 * `BarsSnapshotOptions`) не меняются, а логика разложена по подмодулям:
 *
 *   - barsSnapshot/load.ts      — сборка одного снимка (БАРС + почта);
 *   - barsSnapshot/summarize.ts — задолженности и распределение оценок;
 *   - barsSnapshot/cache.ts     — кэш в памяти, TTL, in-flight, SWR.
 */

export {
  getBarsSnapshot,
  peekBarsSnapshot,
  invalidateBarsSnapshot,
  barsSnapshotStats,
  SNAPSHOT_TTL_MS,
  type BarsSnapshotOptions,
} from './barsSnapshot/cache.ts';

