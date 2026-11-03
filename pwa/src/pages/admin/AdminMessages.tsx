/**
 * Сообщения: лента в приложении и Web Push в одном экране.
 *
 * Раньше «Объявления» и «Рассылка» были двумя экранами с одинаковой лентой.
 * Теперь один композер: получатели, каналы, текст и история отправленного.
 * Telegram здесь нет: им занимается внешний агент, не админка.
 */

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Search, Send, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminAnnouncement, AdminUserSummary } from '@/types/api';
import {
  AdminHeader,
  ConfirmDialog,
  ProgressBar,
  Toggle,
  errorText,
  formatStamp,
  useAdminJob,
} from './shared';

export function AdminMessages({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<'all' | 'one'>('all');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [target, setTarget] = useState<AdminUserSummary | null>(null);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [feed, setFeed] = useState(true);
  const [push, setPush] = useState(true);
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [removing, setRemoving] = useState<AdminAnnouncement | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job, start, reset } = useAdminJob();

  const load = useCallback(async () => {
    try {
      const result = await api.adminAnnouncements();
      setItems(result.items);
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== 'one' || query.trim().length < 2) {
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
  }, [mode, query]);

  useEffect(() => {
    if (job?.status !== 'done') return;
    setSuccess(`Отправлено: ${job.total} получателей.`);
    void load();
  }, [job?.status, job?.total, load]);

  async function send(): Promise<void> {
    if (!text.trim()) {
      setError('Введите текст.');
      return;
    }
    if (!feed && !push) {
      setError('Выберите хотя бы один канал.');
      return;
    }
    if (url.trim() && !/^https?:\/\//i.test(url.trim())) {
      setError('Ссылка должна начинаться с http:// или https://');
      return;
    }
    if (mode === 'one' && !target) {
      setError('Выберите получателя.');
      return;
    }

    setSending(true);
    setError(null);
    setSuccess(null);
    reset();

    try {
      const response = await api.adminSendMessage({
        text: text.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(mode === 'one' && target ? { userId: target.id } : {}),
        channels: { feed, push },
      });
      start(response.jobId);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  async function remove(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    try {
      await api.adminDeleteAnnouncement(removing.id);
      setRemoving(null);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const running = job?.status === 'running';
  const canSend = Boolean(text.trim()) && (feed || push) && !sending && !running;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Сообщения" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          <div
            role="radiogroup"
            aria-label="Получатели"
            className="flex gap-1 rounded-[11px] p-1"
            style={{ background: 'var(--surface-grouped)' }}
          >
            {(
              [
                ['all', 'Всем'],
                ['one', 'Лично'],
              ] as const
            ).map(([id, label]) => {
              const active = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setMode(id);
                    setTarget(null);
                    setError(null);
                  }}
                  className="pressable flex-1 rounded-[8px] py-1.5 text-[12px] font-semibold active:pressable-active"
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {mode === 'one' ? (
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

              {target ? (
                <Card className="flex items-center justify-between px-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold">{target.name}</span>
                    <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {target.group || 'без группы'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setTarget(null)}
                    className="pressable shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium active:pressable-active"
                    style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
                  >
                    Сменить
                  </button>
                </Card>
              ) : users.length > 0 ? (
                <Card className="overflow-hidden">
                  {users.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => {
                        setTarget(user);
                        setQuery('');
                        setUsers([]);
                      }}
                      className="pressable flex w-full items-center justify-between border-t px-4 py-2.5 text-left first:border-t-0 active:pressable-active"
                      style={{ borderColor: 'var(--separator-soft)' }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium">{user.name}</span>
                        <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {user.group || 'без группы'}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        push {user.push}
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
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Текст сообщения"
              rows={5}
              maxLength={4000}
              className="w-full resize-none bg-transparent px-4 py-3 text-[14px] outline-none"
              style={{ color: 'var(--text-primary)' }}
            />
            <div className="border-t px-4 py-2.5" style={{ borderColor: 'var(--separator-soft)' }}>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Ссылка (необязательно)"
                className="w-full bg-transparent text-[13px] outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--separator-soft)' }}>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">Лента в приложении</span>
                <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  Модалка и центр уведомлений
                </span>
              </span>
              <Toggle checked={feed} onChange={setFeed} label="Лента в приложении" />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">Push-уведомления</span>
                <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  Только у кого включены уведомления
                </span>
              </span>
              <Toggle checked={push} onChange={setPush} label="Push-уведомления" />
            </div>
          </Card>

          {text.trim() ? (
            <Card className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                Предпросмотр
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed">{text}</p>
              {url.trim() ? (
                <p className="mt-1 truncate text-[12px]" style={{ color: 'var(--accent)' }}>
                  {url}
                </p>
              ) : null}
            </Card>
          ) : null}

          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className="pressable flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            <Send size={17} aria-hidden />
            {running ? 'Отправляем…' : 'Отправить'}
          </button>

          {job ? (
            <Card className="px-4 py-3">
              <p className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {job.status === 'done' ? 'Готово' : job.status === 'failed' ? 'Ошибка' : 'Отправка'}
              </p>
              {job.status === 'running' ? <ProgressBar done={job.done} total={job.total} /> : null}
              {job.message ? (
                <p className="mt-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  {job.message}
                </p>
              ) : null}
            </Card>
          ) : null}

          {success ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--success)' }}>
                {success}
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

          <div className="flex items-center justify-between px-1 pt-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              История
            </h2>
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {items.length}
            </span>
          </div>

          {items.length === 0 ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Сообщений ещё не было.
              </p>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0"
                  style={{ borderColor: 'var(--separator-soft)' }}
                >
                  <Megaphone size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{item.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      <span>{formatStamp(Date.parse(item.createdAt))}</span>
                      <span>·</span>
                      <span>{item.targetUserId ? 'лично' : 'всем'}</span>
                      <span
                        className="rounded-full px-1.5 py-0.5"
                        style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}
                      >
                        {item.channels?.feed === false ? 'push' : item.channels?.push ? 'лента + push' : 'лента'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Удалить"
                    onClick={() => setRemoving(item)}
                    className="pressable shrink-0 rounded-full p-1.5 active:pressable-active"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Удалить сообщение?"
        message={removing?.text}
        confirmLabel="Удалить"
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
