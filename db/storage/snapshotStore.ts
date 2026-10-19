import { JsonStore } from '../jsonStore.ts';

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

/** Есть ли несохранённые изменения, ждущие flush. */
let dirty = false;

export const snapshotStore = {
  /**
   * Снимок по userId, а не по Telegram ID.
   *
   * Уведомления ходят в Telegram, но состояние БАРС общее для обоих клиентов,
   * и ключ по телеграму приводил к тому, что один и тот же человек, вошедший
   * и в бота, и в PWA, числился двумя разными проверяемыми. Снимок по userId
   * закрывает это: один человек — один снимок, одна проверка за круг.
   */
  get(userId: string): UserSnapshot | undefined {
    return store.get(userId);
  },

  save(userId: string, snapshot: UserSnapshot): void {
    store.set(userId, snapshot);
    dirty = false;
  },

  /**
   * Кладёт снимок в память без записи на диск.
   *
   * Нотификатор за круг проверяет всех студентов подряд, и на каждого раньше
   * приходился полный JSON.stringify + rename файла. Данные от этого не терялись,
   * но на 50 пользователях это 50 одинаковых записей одного и того же файла.
   * Теперь изменения копятся в памяти, а на диск сбрасываются одним flush()
   * в конце круга (см. barsNotifier.runCycle).
   */
  stage(userId: string, snapshot: UserSnapshot): void {
    store.stage(userId, snapshot);
    dirty = true;
  },

  /** Сбрасывает накопленные изменения на диск одним save(). */
  flush(): void {
    if (!dirty) return;
    store.save();
    dirty = false;
  },

  remove(userId: string): UserSnapshot | undefined {
    const removed = store.remove(userId);
    dirty = false;
    return removed;
  },

  /** Есть ли несохранённые изменения — нужно для проверок и аварийного сохранения. */
  hasPendingChanges(): boolean {
    return dirty;
  },

  /**
   * Возвращает снимки всех пользователей, у которых есть хотя бы одна проверка.
   */
  checked(): Map<string, UserSnapshot> {
    const out = new Map<string, UserSnapshot>();
    for (const [key, value] of Object.entries(store.all())) {
      if (value && value.lastCheckedAt) {
        out.set(key, value);
      }
    }
    return out;
  },
};