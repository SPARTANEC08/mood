import { useState } from 'react';
import { ChevronRight, Clock, Hash, RefreshCw } from 'lucide-react';

import { Header } from '@/components/TabBar';
import { Page } from '@/components/Page';
import { Card, EmptyState, ListGroup, SkeletonCard, SkeletonLesson } from '@/components/ui';
import { useAppData } from '@/lib/dataContext';
import { gradeColor } from '@/lib/format';
import { haptic } from '@/lib/env';
import type { ApiSubjectGrade } from '@/types/api';

/**
 * Экран успеваемости.
 *
 * Ключевые блоки:
 *  - задолженности (двойки за КМ) и закрытые КМ — двумя квадратами рядом;
 *  - внутривузовский рейтинг — вторым квадратом в той же строке;
 *  - полоса распределения оценок: пятёрки, четвёрки, тройки, двойки;
 *  - дисциплины с прогрессом закрытия КМ.
 *
 * Средний балл сознательно убран из верхнего блока: он уже виден в каждой
 * дисциплине, а место в шапке отдано тому, что важнее для контроля —
 * задолженностям.
 */
export function GradesPage() {
  const {
    barsMore: more,
    grades,
    attendance,
    barsRefreshing,
    barsError,
    refreshBars,
  } = useAppData();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    haptic('light');
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const academic = more?.academic ?? null;
  const debts = academic?.debts ?? 0;
  const closed = academic?.closed ?? 0;
  const totalKm = academic?.total ?? 0;
  const distribution = academic?.distribution ?? null;

  const comprehensive = more?.rating?.comprehensive ?? null;
  const ratingValue = comprehensive?.semester ?? comprehensive?.total ?? null;

  // Скелетон — пока данных этой вкладки ещё нет вообще. Условие не завязано на
  // barsLoading: фоновое обновление (§22.5) его не поднимает, а без данных всё
  // равно нельзя показывать «0 задолженностей» — это ложь до первого ответа.
  // Если пришли данные, скелетон уступает контенту; если ошибка — экрану ошибки.
  if (!grades && !barsError) {
    return (
      <Page header={<Header title="Успеваемость" large />}>
        <div className="space-y-4">
          <SkeletonLesson />
          <div className="grid grid-cols-2 gap-2.5">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
          </div>
          <SkeletonLesson />
          <SkeletonLesson />
        </div>
      </Page>
    );
  }

  if (barsError && !grades) {
    return (
      <Page header={<Header title="Успеваемость" large />}>
        <EmptyState title={barsError} description="Проверьте сессию БАРС и попробуйте ещё раз." />
      </Page>
    );
  }

  return (
    <Page
      header={
        <Header
          title="Успеваемость"
          large
          subtitle={grades?.semesterName}
          right={
            <button
              type="button"
              aria-label="Обновить"
              onClick={() => {
                haptic('light');
                refreshBars();
              }}
              className="pressable rounded-full p-2 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <RefreshCw size={19} className={barsRefreshing ? 'spinner' : undefined} aria-hidden />
            </button>
          }
        />
      }
    >
      <div className="space-y-3">
        {/* Два квадрата рядом: задолженности и рейтинг */}
        <div className="grid grid-cols-2 gap-2.5">
          <StatCard
            label="Задолженности"
            value={debts}
            hint={totalKm > 0 ? `КМ ${closed} из ${totalKm}` : 'нет КМ'}
            tone={debts > 0 ? 'danger' : 'accent'}
          />
          <StatCard
            label="Рейтинг"
            value={ratingValue}
            hint={more?.rating?.period ?? 'за семестр'}
            tone="accent"
            decimal
          />
        </div>

        {/* Пропуски отдельной строкой — он не влезает в пару с рейтингом,
            иначе подписи сжимаются в нечитаемую кашу. */}
        {attendance ? (
          <Card className="flex items-center justify-between px-4 py-3.5">
            <div>
              <p className="text-[13px] text-[var(--text-secondary)]">Пропущено пар</p>
              <p className="mt-0.5 text-[24px] font-semibold leading-none tabular-nums">
                {attendance.totalMissedLessons}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[12px] text-[var(--text-tertiary)]">
                {attendance.totalMissedHours} ч · уважительных {attendance.totalExcusedLessons}
              </p>
            </div>
          </Card>
        ) : null}

        {/* Распределение оценок вместо полосы причин пропуска */}
        <DistributionBar distribution={distribution} />

        {/* Дисциплины */}
        <div className="pt-1">
          <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Дисциплины
          </h2>

          {grades && grades.subjects.length === 0 ? (
            <EmptyState title="Оценок пока нет" description="Данные появятся после первых контрольных." />
          ) : (
            <ListGroup>
              {grades?.subjects.map((subject) => (
                <SubjectRow
                  key={subject.discipline}
                  subject={subject}
                  isOpen={expanded.has(subject.discipline)}
                  onToggle={() => toggle(subject.discipline)}
                />
              ))}
            </ListGroup>
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * Распределение выставленных оценок.
 *
 * Полоска идёт в порядке убывания балла: пятёрки — зелёные, четвёрки —
 * оранжевые, тройки — жёлтые, двойки — красные. Ширина сегмента
 * пропорциональна количеству, поэтому видно, чего больше всего.
 *
 * Раньше здесь была полоса «уважительные / неуважительные пропуски». Она
 * дублировала соседний блок с числом пропусков и забирала место, которое
 * полезнее отдать распределению оценок.
 */
function DistributionBar({
  distribution,
}: {
  distribution: { fives: number; fours: number; threes: number; twos: number; total: number } | null;
}) {
  if (!distribution || distribution.total === 0) {
    return (
      <Card className="px-4 py-4">
        <p className="text-[13px] text-[var(--text-secondary)]">
          Оценок за контрольные пока нет — распределение появится после первых баллов.
        </p>
      </Card>
    );
  }

  const { fives, fours, threes, twos, total } = distribution;
  const pct = (n: number) => `${(n / total) * 100}%`;

  // Палитра из --grade-*: раньше «4» и «3» красились в один и тот же оранжевый
  // (--warning и --practice совпадают), и легенда была нечитаемой.
  const segments = [
    { label: '5', count: fives, color: 'var(--grade-5)' },
    { label: '4', count: fours, color: 'var(--grade-4)' },
    { label: '3', count: threes, color: 'var(--grade-3)' },
    { label: '2', count: twos, color: 'var(--grade-2)' },
  ].filter((s) => s.count > 0);

  return (
    <Card className="px-4 py-3.5">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] text-[var(--text-secondary)]">Распределение оценок</span>
        <span className="text-[12px] tabular-nums text-[var(--text-tertiary)]">
          всего {total}
        </span>
      </div>

      <div className="flex h-2.5 overflow-hidden rounded-full" role="img" aria-label="Распределение оценок">
        {segments.map((s) => (
          <div key={s.label} style={{ width: pct(s.count), background: s.color }} />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="tabular-nums font-medium" style={{ color: s.color }}>
              {s.label}
            </span>
            <span className="tabular-nums text-[var(--text-secondary)]">{s.count}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

/** Строка дисциплины с прогрессом и раскрываемым списком КМ. */
function SubjectRow({
  subject,
  isOpen,
  onToggle,
}: {
  subject: ApiSubjectGrade;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const average = subject.currentAverage;
  const progress = subject.totalWeight > 0 ? (subject.gradedWeight / subject.totalWeight) * 100 : 0;

  return (
    <div className="border-t border-[var(--separator-soft)] first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[15px] font-medium">{subject.discipline}</span>
            {subject.finalGrade ? (
              <span
                className="rounded-md px-1.5 py-0.5 text-[12px] font-semibold"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {subject.finalGrade}
              </span>
            ) : null}
            <span
              className="w-12 text-right text-[16px] font-semibold tabular-nums"
              style={{ color: average !== null ? gradeColor(average) : 'var(--text-tertiary)' }}
            >
              {average !== null ? average.toFixed(1).replace('.', ',') : '—'}
            </span>
          </div>

          {subject.attestation ? (
            <p className="mt-0.5 truncate text-[12px] text-[var(--text-secondary)]">
              {subject.attestation.charAt(0).toLocaleUpperCase('ru') + subject.attestation.slice(1)}
            </p>
          ) : null}

          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--separator-soft)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.min(progress, 100)}%`, background: 'var(--accent)' }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
              {subject.gradedCount}/{subject.totalCount}
            </span>
          </div>
        </div>

        <ChevronRight
          size={16}
          aria-hidden
          className="shrink-0 transition-transform duration-200"
          style={{ color: 'var(--text-tertiary)', transform: isOpen ? 'rotate(90deg)' : 'none' }}
        />
      </button>

      {isOpen ? (
        <div className="animate-fade bg-[var(--surface-grouped)]">
          {subject.controlPoints.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--text-secondary)]">
              Контрольные мероприятия не указаны
            </p>
          ) : (
            subject.controlPoints.map((point) => (
              <div
                key={point.number}
                className="flex items-start gap-3 border-t border-[var(--separator-soft)] px-4 py-2.5"
              >
                <span className="mt-0.5 shrink-0 text-[12px] font-medium text-[var(--text-tertiary)]">
                  КМ {point.number}
                </span>

                <div className="min-w-0 flex-1">
                  {point.title ? (
                    <p className="text-[13px] leading-snug">{point.title}</p>
                  ) : (
                    <p className="text-[13px] text-[var(--text-secondary)]">Без названия</p>
                  )}

                  <div className="mt-0.5 flex items-center gap-3 text-[11px] text-[var(--text-tertiary)]">
                    {typeof point.weight === 'number' ? (
                      <span className="inline-flex items-center gap-1">
                        <Hash size={10} aria-hidden />
                        {point.weight}%
                      </span>
                    ) : null}
                    {point.week ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} aria-hidden />
                        неделя {point.week}
                      </span>
                    ) : null}
                    {point.date ? <span>{point.date}</span> : null}
                  </div>
                </div>

                <span
                  className="shrink-0 text-[15px] font-semibold tabular-nums"
                  style={{ color: point.score !== null ? gradeColor(point.score) : 'var(--danger)' }}
                >
                  {point.score !== null ? point.score.toFixed(1).replace('.', ',') : '—'}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Квадрат со значением. */
function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  decimal,
}: {
  label: string;
  value: number | null;
  hint: string;
  tone?: 'default' | 'accent' | 'danger';
  decimal?: boolean;
}) {
  const valueColor =
    tone === 'danger' && (value ?? 0) > 0
      ? 'var(--danger)'
      : tone === 'accent' || tone === 'danger'
        ? 'var(--accent)'
        : 'var(--text-primary)';

  return (
    <Card className="px-4 py-3.5">
      <p className="truncate text-[12px] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums" style={{ color: valueColor }}>
        {value === null
          ? '—'
          : decimal
            ? value.toFixed(1).replace('.', ',')
            : String(value)}
      </p>
      <p className="mt-1 truncate text-[11px] text-[var(--text-tertiary)]">{hint}</p>
    </Card>
  );
}
