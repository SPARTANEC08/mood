import { JsonStore } from '../utils/jsonStore.ts';

/**
 * Снимок состояния студента на момент последней успешной проверки.
 * Используется для расчёта диффа и отсечения повторных уведомлений.
 */
export interface UserSnapshot {
  /** Баллы по контрольным точкам: { "Математический анализ_КТ1": 4.5 } */
  gradesHash: Record<string, number | null>;
  /** UID последнего обработанного письма ОСЭП */
  lastSeenMailUid: number;
  /** Количество известных приказов */
  ordersCount: number;
  /** Статус стипендии */
  scholarshipStatus: string;
  /** Дата последней проверки (ISO) */
  lastCheckedAt: string;
}

/**
 * Признак того, что пользователь ещё ни разу не проверялся.
 * По такому снимку уведомления не отправляются — он становится базовой линией.
 */
export function isBaselineSnapshot(snapshot: UserSnapshot | undefined): boolean {
  if (!snapshot) return true;
  return !snapshot.lastCheckedAt;
}

const store = new JsonStore<UserSnapshot>('bars_snapshots.json');

export const snapshotStore = {
  get(telegramId: number): UserSnapshot | undefined {
    return store.get(telegramId);
  },

  save(telegramId: number, snapshot: UserSnapshot): void {
    store.set(telegramId, snapshot);
  },

  remove(telegramId: number): UserSnapshot | undefined {
    return store.delete(telegramId);
  },

  /**
   * Возвращает снимки всех пользователей, у которых есть хотя бы одна проверка.
   */
  checked(): Map<number, UserSnapshot> {
    const out = new Map<number, UserSnapshot>();
    for (const [key, value] of Object.entries(store.all())) {
      if (value && value.lastCheckedAt) {
        out.set(Number(key), value);
      }
    }
    return out;
  },
};