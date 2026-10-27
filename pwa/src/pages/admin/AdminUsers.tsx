/**
 * Пользователи: поиск, карточка, сброс сессий, удаление.
 *
 * Удаление требует ввода слова УДАЛИТЬ: случайный тап не должен стирать
 * аккаунт вместе с файлами и записями.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Search, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Card, ListGroup } from '@/components/ui';
import type { AdminUserDetails, AdminUserSummary } from '@/types/api';
import {
  AdminHeader,
  ConfirmDialog,
  SectionRow,
  errorText,
  formatRelative,
  formatStamp,
} from './shared';

export function AdminUsers({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AdminUserDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.adminUsers(query.trim(), 50);
      setUsers(result.users);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openUser(id: string): Promise<void> {
    setDetailsLoading(true);
    setError(null);
    setMessage(null);
    try {
      setSelected(await api.adminUser(id));
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setDetailsLoading(false);
    }
  }

  async function resetSessions(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      await api.adminResetSessions(selected.id);
      setMessage('Сессии БАРС и OWA сброшены.');
      setConfirm(null);
      await openUser(selected.id);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(): Promise<void> {
    if (!selected || word.trim() !== 'УДАЛИТЬ') return;
    setBusy(true);
    try {
      await api.adminDeleteUser(selected.id, word.trim());
      setSelected(null);
      setConfirm(null);
      setWord('');
      setMessage('Аккаунт удалён.');
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AdminHeader title="Пользователь" onBack={() => setSelected(null)} />

        <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
            <Card className="px-4 py-4">
              <p className="text-[18px] font-semibold leading-tight">{selected.name}</p>
              <p className="mt-0.5 text-[13px]" style={{ color: 'var(--accent)' }}>
                {selected.group || 'без группы'}
              </p>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                {selected.isGuest ? 'гостевой профиль · только расписание' : selected.faculty || 'факультет не указан'}
                {selected.recordBookNumber ? ` · зачётка ${selected.recordBookNumber}` : ''}
              </p>
            </Card>

            <ListGroup>
              <SectionRow
                icon={Search}
                title="Последний вход"
                subtitle={formatRelative(selected.lastSeenAt)}
              />
              <SectionRow
                icon={Search}
                title="Платформа"
                subtitle={`${selected.platform} · PWA-токенов: ${selected.pwaTokens}`}
              />
              <SectionRow
                icon={Search}
                title="БАРС"
                subtitle={
                  selected.barsAuthedAt
                    ? `${selected.sessionValid ? 'активна' : 'истекла'} · ${formatStamp(Date.parse(selected.barsAuthedAt))}`
                    : 'вход не выполнялся'
                }
              />
              <SectionRow
                icon={Search}
                title="Каналы"
                subtitle={`Telegram: ${selected.telegram ? 'да' : 'нет'} · push: ${selected.push} (${selected.pushEnabled ? 'вкл' : 'выкл'})`}
              />
              <SectionRow
                icon={Search}
                title="Права"
                subtitle={selected.isAdmin ? 'администратор' : 'обычный пользователь'}
              />
            </ListGroup>

            {message ? (
              <Card className="px-4 py-3">
                <p className="text-[13px]" style={{ color: 'var(--success)' }}>
                  {message}
                </p>
              </Card>
            ) : null}

            {error ? (
              <Card className="px-4 py-3">
                <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              </Card>
            ) : null}

            <ListGroup>
              <SectionRow
                icon={ArrowLeft}
                title="Сбросить сессии"
                subtitle="БАРС и OWA · аккаунт останется"
                onClick={() => setConfirm('reset')}
              />
              <SectionRow
                icon={Trash2}
                title="Удалить аккаунт"
                subtitle="Файлы, записи и подписки тоже удалятся"
                danger
                onClick={() => {
                  setWord('');
                  setConfirm('delete');
                }}
              />
            </ListGroup>
          </div>
        </div>

        <ConfirmDialog
          open={confirm === 'reset'}
          title="Сбросить сессии?"
          message="Человеку придётся заново войти в БАРС. Аккаунт и данные останутся."
          confirmLabel="Сбросить"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void resetSessions()}
        />

        <ConfirmDialog
          open={confirm === 'delete'}
          title="Удалить аккаунт?"
          message="Действие необратимо: удалятся файлы, записи, уведомления и подписки."
          confirmLabel="Удалить"
          danger
          busy={busy}
          disabled={word.trim() !== 'УДАЛИТЬ'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteUser()}
        >
          <input
            value={word}
            onChange={(event) => setWord(event.target.value)}
            placeholder="Введите УДАЛИТЬ"
            className="mt-3 w-full rounded-[11px] px-3 py-2.5 text-[14px] outline-none"
            style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
          />
        </ConfirmDialog>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Пользователи" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
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

          {message ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--success)' }}>
                {message}
              </p>
            </Card>
          ) : null}

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {loading && users.length === 0 ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Ищем…
              </p>
            </Card>
          ) : users.length === 0 ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Никого не нашли.
              </p>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {users.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => void openUser(user.id)}
                  disabled={detailsLoading}
                  className="pressable flex w-full items-center justify-between border-t px-4 py-2.5 text-left first:border-t-0 active:pressable-active disabled:opacity-60"
                  style={{ borderColor: 'var(--separator-soft)' }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">{user.name}</span>
                    <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {user.group || 'без группы'} · {formatRelative(user.lastSeenAt)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold">
                    {user.isGuest ? (
                      <span className="rounded-full px-2 py-0.5" style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}>
                        гость
                      </span>
                    ) : null}
                    {user.isAdmin ? (
                      <span className="rounded-full px-2 py-0.5" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        админ
                      </span>
                    ) : null}
                    <span style={{ color: user.bars === 'active' ? 'var(--success)' : 'var(--text-tertiary)' }}>
                      БАРС
                    </span>
                  </span>
                </button>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
