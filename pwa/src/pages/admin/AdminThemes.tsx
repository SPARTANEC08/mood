/**
 * Админка тем: скрыть, вернуть или удалить опубликованную пользователем тему.
 *
 * Автор намеренно не показывается: сервер не отдаёт его даже администратору,
 * чтобы ПДн не утекали через интерфейс. Для модерации достаточно названия,
 * превью и статуса.
 */

import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';

import { Card, EmptyState, SkeletonCard } from '@/components/ui';
import { ThemePreview } from '@/components/profile/ThemeSheet';
import { api } from '@/lib/api';
import type { AdminTheme } from '@/types/api';
import { AdminHeader, ConfirmDialog, errorText, formatStamp } from './shared';

type Filter = 'all' | 'published' | 'hidden';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'published', label: 'Опубликованные' },
  { id: 'hidden', label: 'Скрытые' },
];

export function AdminThemes({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<AdminTheme[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminTheme | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.adminThemes('all');
      setItems(response.items);
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (items ?? []).filter((item) => filter === 'all' || item.status === filter);

  async function setHidden(id: string, hidden: boolean): Promise<void> {
    if (busyId) return;
    setBusyId(id);
    try {
      if (hidden) await api.adminHideTheme(id);
      else await api.adminUnhideTheme(id);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(): Promise<void> {
    if (!confirmDelete || busyId) return;
    setBusyId(confirmDelete.id);
    try {
      await api.adminDeleteTheme(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Темы" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          <div className="scroll-hidden flex gap-1.5 overflow-x-auto pb-1">
            {FILTERS.map((entry) => {
              const active = filter === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(entry.id)}
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

          {items === null ? (
            <div className="space-y-2">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              title="Тем пока нет"
              description="Пользовательские темы появятся здесь после публикации."
            />
          ) : (
            <div className="space-y-2">
              {visible.map((theme) => (
                <Card key={theme.id} className="flex items-center gap-3 p-3">
                  <ThemePreview
                    theme={{ ...theme, official: false }}
                    variant={theme.variants.dark ? 'dark' : 'light'}
                    className="h-20 w-20 shrink-0 overflow-hidden rounded-[12px]"
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{theme.name}</p>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {formatStamp(Date.parse(theme.createdAt))} ·{' '}
                      {theme.variants.light && theme.variants.dark
                        ? '2 версии'
                        : theme.variants.dark
                          ? 'только тёмная'
                          : 'только светлая'}
                    </p>
                    <span
                      className="mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        background:
                          theme.status === 'published'
                            ? 'rgba(52,199,89,0.12)'
                            : 'rgba(255,149,0,0.14)',
                        color: theme.status === 'published' ? 'var(--success)' : 'var(--warning)',
                      }}
                    >
                      {theme.status === 'published' ? 'опубликована' : 'скрыта'}
                    </span>
                  </div>

                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      disabled={busyId === theme.id}
                      onClick={() => void setHidden(theme.id, theme.status === 'published')}
                      className="pressable flex items-center gap-1 rounded-[9px] px-2 py-1.5 text-[11px] font-semibold active:pressable-active disabled:opacity-40"
                      style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
                    >
                      {theme.status === 'published' ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
                      {theme.status === 'published' ? 'Скрыть' : 'Вернуть'}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === theme.id}
                      onClick={() => setConfirmDelete(theme)}
                      className="pressable flex items-center gap-1 rounded-[9px] px-2 py-1.5 text-[11px] font-semibold active:pressable-active disabled:opacity-40"
                      style={{ background: 'rgba(255,59,48,0.1)', color: 'var(--danger)' }}
                    >
                      <Trash2 size={12} aria-hidden />
                      Удалить
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Удалить тему?"
        message={
          confirmDelete
            ? `«${confirmDelete.name}» исчезнет из общего списка. Автор не сможет её восстановить.`
            : undefined
        }
        confirmLabel="Удалить"
        danger
        busy={Boolean(busyId)}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
