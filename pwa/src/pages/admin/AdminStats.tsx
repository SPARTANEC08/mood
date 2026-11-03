/**
 * Статистика в админке: живой день и история по дневным срезам.
 *
 * График один — активность по часам (для дня). Для недели и месяца важнее
 * список дней: по нему видно, где провал, без чтения столбиков.
 *
 * Обновление: при входе на экран, при смене периода и по кнопке в шапке.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminDayStats, AdminStatsPeriod, AdminStatsResponse } from '@/types/api';
import { AdminHeader, StatCard, errorText, formatBytes } from './shared';

const PERIODS: Array<{ id: AdminStatsPeriod; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'date', label: 'Дата' },
];

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}`;
}

export function AdminStats({ onBack }: { onBack: () => void }) {
  const today = useMemo(() => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10), []);
  const [period, setPeriod] = useState<AdminStatsPeriod>('today');
  const [date, setDate] = useState(today);
  const [data, setData] = useState<AdminStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);

      try {
        const response = await api.adminStats({
          period,
          ...(period === 'date' ? { date } : {}),
        });
        setData(response);
      } catch (err: unknown) {
        setError(errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [period, date],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const day: AdminDayStats | null = data?.days.length ? data.days[data.days.length - 1] : null;
  const latest = data?.latest ?? day;
  const active =
    period === 'today'
      ? data?.live?.today?.active ?? null
      : period === 'yesterday' || period === 'date'
        ? day?.active ?? null
        : null;
  const showActive = period === 'today' || period === 'yesterday' || period === 'date';
  const hours = data?.live?.requestsByHour ?? (period === 'date' || period === 'yesterday' ? day?.hours ?? null : null);
  const showDayList = period === 'week' || period === 'month';

  const totals = data?.totals;
  const requests = showDayList
    ? totals?.requests ?? 0
    : period === 'today'
      ? data?.live?.today?.requests ?? day?.requests ?? 0
      : day?.requests ?? 0;
  const visits = showDayList
    ? totals?.visits ?? 0
    : period === 'today'
      ? data?.live?.today?.visits ?? day?.visits ?? 0
      : day?.visits ?? 0;
  const maxOnline = showDayList ? totals?.maxOnline ?? 0 : day?.maxOnline ?? 0;
  const newSessions = showDayList ? totals?.newBarsSessions ?? 0 : day?.newBarsSessions ?? 0;

  const maxHour = Math.max(1, ...(hours ?? []).map((item) => item.value));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader
        title="Статистика"
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
          <div
            role="radiogroup"
            aria-label="Период"
            className="flex gap-1 rounded-[11px] p-1"
            style={{ background: 'var(--surface-grouped)' }}
          >
            {PERIODS.map((item) => {
              const active = period === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPeriod(item.id)}
                  className="pressable flex-1 rounded-[8px] py-1.5 text-[11px] font-semibold active:pressable-active"
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {period === 'date' ? (
            <input
              type="date"
              value={date}
              max={today}
              min={`${today.slice(0, 7)}-01`}
              onChange={(event) => setDate(event.target.value || today)}
              className="w-full rounded-[11px] px-3 py-2.5 text-[14px]"
              style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
            />
          ) : null}

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {loading && !data ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Считаем…
              </p>
            </Card>
          ) : null}

          {!loading && data && data.days.length === 0 ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                За этот период данных нет.
              </p>
            </Card>
          ) : null}

          {data && data.days.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {showActive ? (
                  <StatCard
                    label={period === 'today' ? 'Активных сегодня' : 'Активных за день'}
                    value={active ? active.total : '—'}
                    hint={
                      active
                        ? `${active.users} с БАРС · ${active.guests} гостей`
                        : 'нет данных'
                    }
                    tone="success"
                  />
                ) : null}
                <StatCard
                  label="Онлайн"
                  value={latest?.currentOnline ?? 0}
                  hint="±5 минут"
                  tone="success"
                />
                <StatCard label="Сессии БАРС" value={latest?.currentBars ?? 0} />
                <StatCard
                  label="Открытий"
                  value={visits}
                  hint="заходы в приложение"
                />
                <StatCard label="Запросов" value={requests} />
                <StatCard label="Макс. онлайн" value={maxOnline} hint="окно 5 минут" />
                <StatCard label="Новых сессий" value={newSessions} />
              </div>

              {hours && hours.length > 0 ? (
                <Card className="px-3 py-3">
                  <p className="px-1 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                    Активность по часам
                  </p>
                  <div className="mt-2 flex h-[96px] items-end gap-[3px]">
                    {hours.map((item) => (
                      <div
                        key={item.label}
                        className="flex-1 rounded-t-[3px]"
                        title={`${item.label} — ${item.value}`}
                        style={{
                          height: `${Math.max(2, Math.round((item.value / maxHour) * 100))}%`,
                          background: 'var(--accent)',
                          opacity: item.value === 0 ? 0.25 : 1,
                        }}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex gap-[3px] text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                    {hours.map((item) => (
                      <span key={item.label} className="flex-1 text-center">
                        {item.label.slice(0, 2)}
                      </span>
                    ))}
                  </div>
                </Card>
              ) : null}

              <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    ДЗ создано / удалено
                  </span>
                  <span className="text-[14px] font-semibold">
                    {showDayList
                      ? `${totals?.homeworkCreated ?? 0} / ${totals?.homeworkDeleted ?? 0}`
                      : `${day?.homework.created ?? 0} / ${day?.homework.deleted ?? 0}`}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    Важное создано / удалено
                  </span>
                  <span className="text-[14px] font-semibold">
                    {showDayList
                      ? `${totals?.importantCreated ?? 0} / ${totals?.importantDeleted ?? 0}`
                      : `${day?.important.created ?? 0} / ${day?.important.deleted ?? 0}`}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    Файлы
                  </span>
                  <span className="text-[14px] font-semibold">
                    {latest?.files.totalFiles ?? 0} · {formatBytes(latest?.files.totalBytes ?? 0)}
                  </span>
                </div>
              </Card>

              <Card className="px-4 py-3">
                <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  Платформы
                </p>
                <div className="mt-2 space-y-1.5">
                  {(
                    [
                      ['iOS', latest?.platforms.ios ?? 0],
                      ['Android', latest?.platforms.android ?? 0],
                      ['Web', latest?.platforms.web ?? 0],
                      ['Неизвестно', latest?.platforms.unknown ?? 0],
                    ] as const
                  ).map(([label, value]) => {
                    const total = Math.max(
                      1,
                      (latest?.platforms.ios ?? 0) +
                        (latest?.platforms.android ?? 0) +
                        (latest?.platforms.web ?? 0) +
                        (latest?.platforms.unknown ?? 0),
                    );
                    return (
                      <div key={label} className="flex items-center gap-2">
                        <span className="w-[86px] shrink-0 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {label}
                        </span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-grouped)' }}>
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${Math.round((value / total) * 100)}%`, background: 'var(--accent)' }}
                          />
                        </span>
                        <span className="w-7 shrink-0 text-right text-[12px] font-semibold">{value}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {showDayList ? (
                <Card className="overflow-hidden">
                  <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--separator-soft)' }}>
                    <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                      По дням
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {data.from} — {data.to}
                    </span>
                  </div>
                  {data.days.map((item) => (
                    <div
                      key={item.date}
                      className="flex items-center justify-between border-t px-4 py-2.5 first:border-t-0"
                      style={{ borderColor: 'var(--separator-soft)' }}
                    >
                      <span className="text-[13px] font-medium">{dayLabel(item.date)}</span>
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        {item.requests} запросов · {item.visits} заходов · онлайн {item.maxOnline}
                      </span>
                    </div>
                  ))}
                </Card>
              ) : null}

              <p className="px-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Срез: {data.from === data.to ? data.from : `${data.from} — ${data.to}`}
                {data.live ? ` · снято ${data.live.moscowNow.time} МСК` : ''}
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
