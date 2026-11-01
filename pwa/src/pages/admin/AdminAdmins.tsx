/**
 * Администраторы: env-список (только чтение) и назначенные из PWA.
 *
 * Назначать можно только существующего пользователя: по логину вслепую —
 * источник ошибок, а найти человека через поиск занимает секунду.
 */

import { useCallback, useEffect, useState } from 'react';
import { Search, ShieldCheck, Trash2, UserPlus } from 'lucide-react';

import { api } from '@/lib/api';
import { Card, ListGroup } from '@/components/ui';
import type { AdminAdminsResponse, AdminUserSummary } from '@/types/api';
import { AdminHeader, ConfirmDialog, SectionRow, errorText, formatStamp } from './shared';

export function AdminAdmins({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<AdminAdminsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.adminAdmins());
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!adding || query.trim().length < 2) {
      setUsers([]);
      return;
    }

    const timer = window.setTimeout(() => {
      void api
        .adminUsers(query.trim(), 20)
        .then((result) => setUsers(result.users.filter((user) => !user.isGuest)))
        .catch(() => setUsers([]));
    }, 250);

    return () => window.clearTimeout(timer);
  }, [adding, query]);

  async function add(user: AdminUserSummary): Promise<void> {
    setBusy(true);
    try {
      await api.adminAddAdmin(user.id);
      setAdding(false);
      setQuery('');
      setUsers([]);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    try {
      await api.adminRemoveAdmin(removing);
      setRemoving(null);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Администраторы" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          <Card className="px-4 py-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Env-админы
            </p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Логинов БАРС: {data?.env.barsHashes ?? 0} (сами логины не показываются)
            </p>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Снять из приложения нельзя — меняется только в .env.
            </p>
          </Card>

          <ListGroup>
            <SectionRow
              icon={UserPlus}
              title={adding ? 'Отмена' : 'Назначить админа'}
              subtitle="Из существующих пользователей"
              onClick={() => {
                setAdding((value) => !value);
                setQuery('');
                setUsers([]);
              }}
            />
          </ListGroup>

          {adding ? (
            <>
              <div className="flex items-center gap-2 rounded-[11px] px-3" style={{ background: 'var(--surface-grouped)' }}>
                <Search size={16} style={{ color: 'var(--text-tertiary)' }} aria-hidden />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Имя или группа"
                  className="min-w-0 flex-1 bg-transparent py-2.5 text-[14px] outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
              </div>

              {users.length > 0 ? (
                <Card className="overflow-hidden">
                  {users.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void add(user)}
                      className="pressable flex w-full items-center justify-between border-t px-4 py-2.5 text-left first:border-t-0 active:pressable-active disabled:opacity-50"
                      style={{ borderColor: 'var(--separator-soft)' }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium">{user.name}</span>
                        <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {user.group || 'без группы'}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent)' }}>
                        {user.isAdmin ? 'уже админ' : 'назначить'}
                      </span>
                    </button>
                  ))}
                </Card>
              ) : query.trim().length >= 2 ? (
                <p className="px-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Никого не нашли.
                </p>
              ) : null}
            </>
          ) : null}

          <Card className="overflow-hidden">
            <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--separator-soft)' }}>
              <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                Назначенные из PWA
              </span>
            </div>

            {!data || data.assigned.length === 0 ? (
              <p className="px-4 py-4 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Пока никого.
              </p>
            ) : (
              data.assigned.map((admin) => (
                <div
                  key={admin.userId}
                  className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0"
                  style={{ borderColor: 'var(--separator-soft)' }}
                >
                  <ShieldCheck size={16} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{admin.name}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {admin.group || 'без группы'} · {formatStamp(Date.parse(admin.addedAt))}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Снять"
                    onClick={() => setRemoving(admin.userId)}
                    className="pressable shrink-0 rounded-full p-1.5 active:pressable-active"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Снять админа?"
        message="Доступ к админке пропадёт сразу. Env-админов это не касается."
        confirmLabel="Снять"
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
