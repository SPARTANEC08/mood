/**
 * Общие кирпичи админки: шапка, строки-разделы, карточки, подтверждение,
 * прогресс фоновой задачи.
 *
 * Отдельный файл, чтобы экраны админки не тащили по копии одинаковой разметки
 * и чтобы «назад» вёл себя одинаково во всех разделах.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, type LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { AdminJob } from '@/types/api';

export function AdminHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}) {
  return (
    <header
      className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]"
      style={{ background: 'var(--app-bg)' }}
    >
      <div className="mx-auto flex max-w-[560px] items-center gap-2">
        <button
          type="button"
          aria-label="Назад"
          onClick={() => {
            haptic('light');
            onBack();
          }}
          className="pressable -ml-1 shrink-0 rounded-full p-1.5 active:pressable-active"
          style={{ color: 'var(--accent)' }}
        >
          <ArrowLeft size={22} aria-hidden />
        </button>

        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</span>
        {right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
      </div>
    </header>
  );
}

export function SectionRow({
  icon: Icon,
  title,
  subtitle,
  onClick,
  right,
  danger,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  onClick?: () => void;
  right?: ReactNode;
  danger?: boolean;
}) {
  const content = (
    <>
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
        style={{
          background: danger ? 'rgba(255,59,48,0.12)' : 'var(--accent-soft)',
          color: danger ? 'var(--danger)' : 'var(--accent)',
        }}
        aria-hidden
      >
        <Icon size={18} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-snug">{title}</span>
        {subtitle ? (
          <span className="mt-0.5 block text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {subtitle}
          </span>
        ) : null}
      </span>

      {right ?? (onClick ? (
        <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
      ) : null)}
    </>
  );

  if (!onClick) {
    return <div className="flex items-center gap-3 px-4 py-3.5">{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className="pressable flex w-full items-center gap-3 px-4 py-3.5 text-left active:pressable-active"
    >
      {content}
    </button>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'accent' | 'success' | 'danger';
}) {
  const color =
    tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text-primary)';

  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </p>
      <p className="mt-1 text-[22px] font-semibold leading-tight" style={{ color }}>
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {hint}
        </p>
      ) : null}
    </Card>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        haptic('light');
        onChange(!checked);
      }}
      className="pressable relative h-[25px] w-[42px] shrink-0 rounded-full transition-colors active:pressable-active disabled:opacity-50"
      style={{ background: checked ? 'var(--accent)' : 'var(--separator)' }}
    >
      <span
        className="absolute left-[2px] top-[2px] h-[21px] w-[21px] rounded-full bg-white shadow-sm transition-transform duration-200"
        style={{ transform: checked ? 'translateX(17px)' : 'translateX(0)' }}
      />
    </button>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Подтвердить',
  danger,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
      <div className="surface w-full max-w-[420px] overflow-hidden rounded-[18px] p-4">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {message ? (
          <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {message}
          </p>
        ) : null}
        {children}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: danger ? 'var(--danger)' : 'var(--accent)' }}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-grouped)' }}>
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${percent}%`, background: 'var(--accent)' }}
        />
      </div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        {done} из {total} · {percent}%
      </p>
    </div>
  );
}

/**
 * Опрос фоновой задачи раз в секунду.
 *
 * Возвращает текущее состояние и функцию запуска. После завершения polling
 * останавливается сам: лишние запросы к админскому API ни к чему.
 */
export function useAdminJob() {
  const [job, setJob] = useState<AdminJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status !== 'running') return;

    const timer = window.setInterval(() => {
      void api
        .adminJob(job.id)
        .then(setJob)
        .catch(() => setError('Не удалось получить прогресс.'));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [job]);

  const start = useCallback((jobId: string) => {
    setError(null);
    void api
      .adminJob(jobId)
      .then(setJob)
      .catch(() => setError('Не удалось получить задачу.'));
  }, []);

  const reset = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);

  return { job, error, start, reset };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} ГБ`;
}

/** «19.10, 14:32» по Москве. */
export function formatStamp(ms: number | null | undefined): string {
  if (!ms) return '—';
  const date = new Date(ms + 3 * 60 * 60 * 1000);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}, ${hh}:${mi}`;
}

/** «5 минут назад» / «19.10, 14:32». */
export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'только что';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} мин назад`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / 3_600_000)} ч назад`;
  return formatStamp(ms);
}

export function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Ошибка запроса.';
}
