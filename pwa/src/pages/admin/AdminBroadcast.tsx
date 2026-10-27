/**
 * Рассылка: всем или одному человеку.
 *
 * Каналы не выбираются: у каждого пользователя берутся все доступные — лента в
 * приложении, Web Push и Telegram. Явные отказы (выключенные push/TG) уважаются.
 */

import { useEffect, useState } from 'react';
import { Search, Send } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminUserSummary } from '@/types/api';
import {
  AdminHeader,
  ConfirmDialog,
  ProgressBar,
  SectionRow,
  errorText,
  formatRelative,
  useAdminJob,
} from './shared';

export function AdminBroadcast({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<'all' | 'one'>('all');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [target, setTarget] = useState<AdminUserSummary | null>(null);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, start, reset } = useAdminJob();

  useEffect(() => {
    if (mode !== 'one' || query.trim().length < 2) {
      setUsers([]);
      return;
    }

    const timer = window.setTimeout(() => {
      void api
        .adminUsers(query.trim(), 20)
        .then((result) => setUsers(result.users))
        .catch(() => setUsers([]));
    }, 250);

    return () => window.clearTimeout(timer);
  }, [mode, query]);

  async function send(): Promise<void> {
    if (!text.trim()) {
      setError('Введите текст.');
      return;
    }
    if (mode === 'one' && !target) {
      setError('Выберите получателя.');
      return;
    }

    setSending(true);
    setError(null);

    try {
      const response = await api.adminBroadcast({
        text: text.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(mode === 'one' && target ? { userId: target.id } : {}),
      });
      setConfirmOpen(false);
      start(response.jobId);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  const running = job?.status === 'running';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Рассылка" onBack={onBack} />

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
                      {target.group || 'без группы'} · {formatRelative(target.lastSeenAt)}
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
              placeholder="Текст рассылки"
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

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {job ? (
            <Card className="px-4 py-3">
              <p className="text-[13px] font-semibold">
                {job.status === 'running'
                  ? 'Рассылаем…'
                  : job.status === 'failed'
                    ? 'Ошибка'
                    : 'Готово'}
              </p>
              <ProgressBar done={job.done} total={job.total} />
              <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                лента {job.progress.feed ?? 0} · push {job.progress.push ?? 0} · telegram{' '}
                {job.progress.telegram ?? 0} · ошибок {job.progress.failed ?? 0}
              </p>
              {job.error ? (
                <p className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                  {job.error}
                </p>
              ) : null}
              {job.status !== 'running' ? (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setText('');
                    setUrl('');
                    setTarget(null);
                  }}
                  className="pressable mt-2 rounded-full px-3 py-1.5 text-[12px] font-medium active:pressable-active"
                  style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
                >
                  Новая рассылка
                </button>
              ) : null}
            </Card>
          ) : null}

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={running || sending}
            className="pressable flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            <Send size={16} aria-hidden />
            Отправить
          </button>

          <SectionRow
            icon={Send}
            title="Каналы"
            subtitle="Лента + push + Telegram, у кого что включено"
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={mode === 'one' ? 'Отправить лично?' : 'Отправить всем?'}
        message={
          mode === 'one' && target
            ? `${target.name} получит сообщение во все доступные каналы.`
            : 'Сообщение уйдёт всем пользователям во все доступные каналы.'
        }
        confirmLabel="Отправить"
        busy={sending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void send()}
      />
    </div>
  );
}
