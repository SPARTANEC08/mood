/**
 * Диагностика: состояние сервисов, принудительный прогон и журнал действий.
 *
 * Цифры те же, что были на /dev/, но без отдельной страницы: всё внутри PWA.
 */

import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminDiagnostics as Diagnostics } from '@/types/api';
import {
  AdminHeader,
  ProgressBar,
  StatCard,
  errorText,
  formatBytes,
  formatRelative,
  formatStamp,
  useAdminJob,
} from './shared';

const ACTION_LABELS: Record<string, string> = {
  broadcast_all: 'Рассылка всем',
  broadcast_personal: 'Личная рассылка',
  user_delete: 'Удаление аккаунта',
  user_reset_sessions: 'Сброс сессий',
  announcement_create: 'Объявление',
  announcement_delete: 'Удаление объявления',
  maintenance: 'Обслуживание',
  registration_toggle: 'Регистрация',
  admin_add: 'Назначен админ',
  admin_remove: 'Снят админ',
  notifier_run: 'Обновление данных',
};

export function AdminDiagnostics({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { job, start, reset } = useAdminJob();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await api.adminDiagnostics());
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока задача идёт — подтягиваем и диагностику, чтобы статус не отставал.
  useEffect(() => {
    if (job?.status !== 'running') return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [job, load]);

  async function runNotifier(): Promise<void> {
    try {
      const response = await api.adminRunNotifier();
      start(response.jobId);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }

  const running = job?.status === 'running';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader
        title="Диагностика"
        onBack={onBack}
        right={
          <button
            type="button"
            aria-label="Обновить"
            onClick={() => void load(true)}
            className="pressable rounded-full p-2 active:pressable-active"
            style={{ color: 'var(--accent)' }}
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        }
      />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {!data ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {loading ? 'Собираем состояние…' : 'Нет данных.'}
              </p>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Аптайм" value={formatUptime(data.uptimeSec)} />
                <StatCard label="Память RSS" value={formatBytes(data.memory.rss)} />
                <StatCard
                  label="Диск свободно"
                  value={data.disk ? formatBytes(data.disk.freeBytes) : '—'}
                  hint={data.disk ? `занято ${Math.round(data.disk.usedRatio * 100)}%` : undefined}
                  tone={data.disk && data.disk.usedRatio > 0.8 ? 'danger' : undefined}
                />
                <StatCard label="Пользователей" value={data.users.total} hint={`гостей: ${data.users.guests}`} />
                <StatCard label="БАРС" value={data.users.barsAuthorized} hint="авторизованы" />
                <StatCard
                  label="Push"
                  value={data.users.withPush}
                  hint={`${data.pushDevices} устройств`}
                />
              </div>

              <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    Нотификатор
                  </span>
                  <span className="text-[13px] font-semibold">
                    {data.notifier.running
                      ? 'идёт прогон'
                      : data.notifier.lastCycleFinishedAt
                        ? `последний ${formatRelative(data.notifier.lastCycleFinishedAt)}`
                        : 'ещё не запускался'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    Активное окно
                  </span>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: data.notifier.activeWindow ? 'var(--success)' : 'var(--text-tertiary)' }}
                  >
                    {data.notifier.activeWindow ? '08:00–23:00' : 'закрыто'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    Регистрация
                  </span>
                  <span className="text-[13px] font-semibold">
                    {data.registrationOpen ? 'открыта' : 'закрыта'}
                  </span>
                </div>
              </Card>

              <button
                type="button"
                onClick={() => void runNotifier()}
                disabled={running}
                className="pressable flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                <Play size={16} aria-hidden />
                {running ? 'Прогон идёт…' : 'Обновить данные'}
              </button>

              {job ? (
                <Card className="px-4 py-3">
                  <p className="text-[13px] font-semibold">
                    {job.status === 'running'
                      ? 'Проверяем пользователей…'
                      : job.status === 'failed'
                        ? 'Ошибка прогона'
                        : 'Прогон завершён'}
                  </p>
                  <ProgressBar done={job.done} total={job.total} />
                  {job.message ? (
                    <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {job.message}
                    </p>
                  ) : null}
                  {job.error ? (
                    <p className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                      {job.error}
                    </p>
                  ) : null}
                  {job.status !== 'running' ? (
                    <button
                      type="button"
                      onClick={reset}
                      className="pressable mt-2 rounded-full px-3 py-1.5 text-[12px] font-medium active:pressable-active"
                      style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
                    >
                      Скрыть
                    </button>
                  ) : null}
                </Card>
              ) : null}

              <Card className="overflow-hidden">
                <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--separator-soft)' }}>
                  <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                    Последние действия
                  </span>
                </div>

                {data.audit.length === 0 ? (
                  <p className="px-4 py-4 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                    Пока пусто.
                  </p>
                ) : (
                  data.audit.map((entry) => (
                    <div
                      key={entry.id}
                      className="border-t px-4 py-2.5 first:border-t-0"
                      style={{ borderColor: 'var(--separator-soft)' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium">
                          {ACTION_LABELS[entry.action] ?? entry.action}
                        </span>
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {formatStamp(Date.parse(entry.at))}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {entry.adminName}
                        {entry.target ? ` · ${entry.target}` : ''}
                        {entry.details ? ` · ${entry.details}` : ''}
                      </p>
                    </div>
                  ))
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86400)} дн`;
}
