/**
 * Центр уведомлений: вся история в одном листе.
 *
 * Лента собирается сервером из двух источников — событий нотификатора и
 * объявлений администратора. Здесь только история и фильтры.
 *
 * Отметок прочитанного в интерфейсе нет: новое уведомление и так показывается
 * полноэкранно, а затемнение старых карточек только мешало читать. Служебная
 * отметка на сервере осталась ради полноэкранной очереди — она не даёт
 * показывать одно и то же событие повторно.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { BottomSheet, EmptyState, SkeletonList } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoscowDayLabel, moscowRawDate } from '@/lib/dates';
import { haptic } from '@/lib/env';
import type { AppNotification, AppNotificationKind } from '@/types/api';
import { NotificationActions, NotificationContent, notificationAccent } from './NotificationContent';

type Filter = 'all' | AppNotificationKind;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'grade', label: 'Оценки' },
  { id: 'mail', label: 'Почта' },
  { id: 'order', label: 'Приказы' },
  { id: 'scholarship', label: 'Стипендия' },
  { id: 'broadcast', label: 'Объявления' },
];

interface DayGroup {
  key: string;
  label: string;
  items: AppNotification[];
}

export function NotificationsSheet({
  open,
  onClose,
  revision,
}: {
  open: boolean;
  onClose: () => void;
  /** Меняется, когда полноэкранная модалка показала новое уведомление. */
  revision: number;
}) {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await api.notificationsFeed();
      setItems(data.items);
    } catch {
      setError('Не удалось загрузить уведомления. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, revision, load]);

  const filtered = useMemo(
    () => (items ?? []).filter((item) => filter === 'all' || item.kind === filter),
    [items, filter],
  );

  const groups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();

    for (const item of filtered) {
      const key = moscowRawDate(item.createdAt);
      const group = map.get(key);
      if (group) {
        group.items.push(item);
      } else {
        map.set(key, {
          key,
          label: formatMoscowDayLabel(item.createdAt),
          items: [item],
        });
      }
    }

    return [...map.values()];
  }, [filtered]);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Уведомления"
      closeLabel="Закрыть"
      // Высота зафиксирована: иначе при смене фильтра список становится короче,
      // и всё окно прыгает вверх-вниз. Внутри лента прокручивается сама.
      height="min(720px, 85dvh)"
    >
      <div className="scroll-hidden -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map((entry) => {
          const active = filter === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                haptic('light');
                setFilter(entry.id);
              }}
              className="pressable shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold active:pressable-active"
              style={{
                background: active ? 'var(--accent-soft)' : 'var(--surface-grouped)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="py-6 text-center">
          <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="pressable mt-3 rounded-[12px] px-4 py-2 text-[13px] font-semibold active:pressable-active"
            style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
          >
            Повторить
          </button>
        </div>
      ) : loading && items === null ? (
        <SkeletonList count={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={items && items.length > 0 ? 'В этом разделе пусто' : 'Пока нет уведомлений'}
          description={
            items && items.length > 0
              ? 'Выберите другой раздел или «Все».'
              : 'Здесь появятся новые оценки, письма, приказы и объявления.'
          }
        />
      ) : (
        <div className="space-y-4 pb-2">
          {groups.map((group) => (
            <section key={group.key}>
              <h4
                className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {group.label}
              </h4>

              <div className="space-y-2">
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-[14px] border p-3"
                    style={{
                      background: 'var(--surface-grouped)',
                      borderColor: 'var(--separator-soft)',
                      borderLeft: `3px solid ${notificationAccent(item.kind)}`,
                    }}
                  >
                    <NotificationContent item={item} />
                    <NotificationActions item={item} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}
