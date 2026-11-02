/**
 * Калькулятор оценок: предмет → порог автомата → что написать за оставшиеся КМ.
 *
 * Три блока, без лишнего:
 *   1. текущие баллы за КМ и один итог по формуле «Σ балл × вес / 100»;
 *   2. простой ползунок порога 2,0–5,0;
 *   3. план по оставшимся КМ: какой балл нужно написать.
 *
 * Все расчёты — в useMemo. Раньше они выполнялись на каждый рендер, в том
 * числе на каждое движение слайдера, отсюда и ощущение «тупит».
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Calculator, CheckCircle2 } from 'lucide-react';

import { BottomSheet, EmptyState } from '@/components/ui';
import {
  checkWeights,
  currentWeighted,
  earnedWeighted,
  maxPossible,
  minimumPlan,
  requiredAverage,
  weightSums,
} from '@/lib/gradeCalc';
import { formatScore } from '@/lib/gradeDetails';
import { haptic } from '@/lib/env';
import type { GradesResponse } from '@/types/api';

const MIN_SCALE = 2;
const MAX_SCALE = 5;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function GradeCalculatorSheet({
  open,
  onClose,
  grades,
}: {
  open: boolean;
  onClose: () => void;
  grades: GradesResponse | null;
}) {
  const subjects = grades?.subjects ?? [];

  const [discipline, setDiscipline] = useState('');
  const [target, setTarget] = useState(4.5);

  // При открытии выбираем предмет с незакрытыми КМ: для него и есть смысл
  // в плане. Если такого нет — первый в списке.
  useEffect(() => {
    if (!open || subjects.length === 0) return;

    setDiscipline((previous) => {
      if (subjects.some((subject) => subject.discipline === previous)) return previous;
      return (subjects.find((subject) => subject.pendingCount > 0) ?? subjects[0]!).discipline;
    });
    // subjects — производная от grades; зависим от листа, а не от массива.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, grades]);

  const subject =
    subjects.find((candidate) => candidate.discipline === discipline) ?? subjects[0] ?? null;

  const weights = useMemo(() => checkWeights(subject), [subject]);
  const maximum = useMemo(() => (subject ? maxPossible(subject) : null), [subject]);
  const required = useMemo(
    () => (subject ? requiredAverage(subject, target) : null),
    [subject, target],
  );
  const plan = useMemo(
    () => (subject ? minimumPlan(subject, target) : null),
    [subject, target],
  );

  /*
   * Один итоговый балл: ровно формула «балл × вес + … + балл × вес»,
   * приведённая к пятибалльной шкале делением на 100.
   */
  const totalScore = useMemo(() => {
    if (!subject) return null;
    return Math.round((earnedWeighted(subject) / 100) * 100) / 100;
  }, [subject]);

  const pending = useMemo(
    () =>
      (subject?.controlPoints ?? []).filter(
        (point) => point.score === null && typeof point.weight === 'number' && point.weight > 0,
      ),
    [subject],
  );

  const gradedPct = useMemo(() => {
    if (!subject) return 0;
    const sums = weightSums(subject);
    return sums.total > 0 ? Math.round((sums.graded / sums.total) * 100) : 0;
  }, [subject]);

  // При смене предмета порог встаёт на текущий средний: понятная точка старта.
  useEffect(() => {
    if (!subject) return;
    const now = currentWeighted(subject);
    setTarget(now !== null ? clamp(round1(now), MIN_SCALE, MAX_SCALE) : 4.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.discipline]);

  /** Заполненная часть трека до бегунка. */
  const pct = ((clamp(target, MIN_SCALE, MAX_SCALE) - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100;
  const sliderBackground = `linear-gradient(90deg,
    var(--accent) 0%,
    var(--accent) ${pct}%,
    var(--separator-soft) ${pct}%,
    var(--separator-soft) 100%)`;

  const unreachable = required !== null && required > 5.0001;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Калькулятор"
      closeLabel="Закрыть"
      height="min(700px, 88dvh)"
    >
      {!grades || subjects.length === 0 || !subject ? (
        <EmptyState
          title="Нет данных для расчёта"
          description="Оценки ещё не загрузились — вернитесь на экран успеваемости и обновите его."
        />
      ) : (
        <div className="space-y-6 pb-3">
          {/* Предмет: горизонтальные чипы. */}
          <div
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5"
            style={{ scrollbarWidth: 'none' }}
          >
            {subjects.map((item) => {
              const active = item.discipline === subject.discipline;
              return (
                <button
                  key={item.discipline}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    if (active) return;
                    haptic('light');
                    setDiscipline(item.discipline);
                  }}
                  className="pressable shrink-0 rounded-full border px-3.5 py-2 text-left transition-colors"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--separator-soft)',
                    background: active ? 'var(--accent)' : 'var(--surface)',
                    color: active ? 'var(--accent-text)' : 'var(--text-primary)',
                  }}
                >
                  <span className="block max-w-[190px] truncate text-[13px] font-semibold">
                    {item.discipline}
                  </span>
                  <span
                    className="mt-0.5 block text-[10px]"
                    style={{ color: active ? 'rgba(255,255,255,0.72)' : 'var(--text-tertiary)' }}
                  >
                    {item.pendingCount > 0
                      ? `${item.pendingCount} КМ осталось`
                      : item.finalGrade
                        ? `оценка ${item.finalGrade}`
                        : 'все КМ закрыты'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 1. Текущие баллы и один итог по весам. */}
          <section className="space-y-3">
            <div
              className="relative overflow-hidden rounded-[20px] px-4 py-4"
              style={{
                background:
                  'linear-gradient(135deg, var(--accent-soft), rgba(124,77,255,0.02) 72%)',
                border: '1px solid var(--separator-soft)',
              }}
            >
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                    Текущий балл
                  </p>
                  <p className="mt-1 text-[46px] font-bold leading-none tracking-[-0.02em] tabular-nums">
                    {formatScore(totalScore, 2)}
                  </p>
                </div>
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium"
                  style={{ background: 'var(--surface)', color: 'var(--text-tertiary)' }}
                >
                  Σ балл × вес
                </span>
              </div>

              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--separator-soft)]">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${gradedPct}%`, background: 'var(--accent)' }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
                закрыто {gradedPct}% веса
              </p>
            </div>

            <div className="overflow-hidden rounded-[16px] border border-[var(--separator-soft)]">
              {subject.controlPoints.map((point) => (
                <div
                  key={point.number}
                  className="flex items-center gap-3 border-t border-[var(--separator-soft)] px-3.5 py-2.5 first:border-t-0"
                >
                  <span className="w-9 shrink-0 text-[11px] font-medium tabular-nums text-[var(--text-tertiary)]">
                    КМ {point.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {point.title ?? 'Без названия'}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                    {formatScore(point.weight, 0)}%
                  </span>
                  <span
                    className="w-9 shrink-0 text-right text-[15px] font-semibold tabular-nums"
                    style={{
                      color:
                        point.score === null
                          ? 'var(--text-tertiary)'
                          : point.score <= 2
                            ? 'var(--danger)'
                            : 'var(--text-primary)',
                    }}
                  >
                    {point.score === null ? '—' : formatScore(point.score, 1)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* 2. Простой ползунок порога. */}
          <section
            className="rounded-[20px] px-4 py-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--separator-soft)' }}
          >
            <div className="flex items-end justify-between gap-3">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                Порог автомата
              </span>
              <span
                className="text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums"
                style={{ color: 'var(--accent)' }}
              >
                {formatScore(target, 1)}
              </span>
            </div>

            <div className="relative mt-3 h-10">
              <div
                className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
                style={{ background: sliderBackground }}
                aria-hidden
              />
              <input
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.1}
                value={target}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) {
                    setTarget(clamp(round1(value), MIN_SCALE, MAX_SCALE));
                  }
                }}
                aria-label="Порог автомата, средний балл"
                className="mood-range absolute inset-0 h-10 w-full cursor-pointer"
              />
            </div>
          </section>

          {/* 3. Что написать за оставшиеся КМ. */}
          {weights.reason !== 'ok' ? (
            <WarningCard reason={weights.reason} sum={weights.sum} />
          ) : subject.finalGrade ? (
            <InfoCard
              icon={<CheckCircle2 size={18} aria-hidden />}
              title={`Оценка уже выставлена: ${subject.finalGrade}`}
              text="Пересчёт по КМ больше не меняет итог — оценка стоит в БАРС."
              tone="success"
            />
          ) : pending.length === 0 ? (
            <InfoCard
              icon={<CheckCircle2 size={18} aria-hidden />}
              title="Все КМ закрыты"
              text={`Итоговый балл — ${formatScore(totalScore, 2)}. Изменить его новыми баллами уже нельзя.`}
              tone="success"
            />
          ) : unreachable ? (
            <InfoCard
              icon={<AlertCircle size={18} aria-hidden />}
              title={`До ${formatScore(target, 1)} не дотянуть`}
              text={`Даже пятёрки за всё оставшееся дают максимум ${formatScore(maximum, 2)}.`}
              tone="warning"
            />
          ) : required !== null && required <= 0 ? (
            <InfoCard
              icon={<CheckCircle2 size={18} aria-hidden />}
              title={`Порог ${formatScore(target, 1)} уже взят`}
              text="Баллы за оставшиеся КМ можно не добирать."
              tone="success"
            />
          ) : (
            <section
              className="overflow-hidden rounded-[20px] px-4 py-4"
              style={{
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-fade-3) 100%)',
                color: 'var(--accent-text)',
              }}
            >
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <p className="text-[12px] font-semibold opacity-80">Что написать</p>
                <span className="text-[11px] tabular-nums opacity-70">
                  {pending.length} КМ
                </span>
              </div>
              <div className="space-y-2">
                {plan?.items.map((item) => (
                  <div
                    key={item.point.number}
                    className="flex items-center gap-3 rounded-[14px] px-3 py-2.5"
                    style={{ background: 'rgba(255,255,255,0.14)' }}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold tabular-nums"
                      style={{ background: 'rgba(255,255,255,0.2)' }}
                    >
                      {item.point.number}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">
                        {item.point.title ?? 'Без названия'}
                      </p>
                      <p className="mt-0.5 text-[11px] tabular-nums opacity-70">
                        вес {formatScore(item.point.weight, 0)}%
                      </p>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-3 py-1.5 text-[13px] font-bold tabular-nums"
                      style={{ background: 'var(--accent-text)', color: 'var(--accent)' }}
                    >
                      ≥ {formatScore(item.score, 0)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            <Calculator size={13} className="mt-0.5 shrink-0" aria-hidden />
            Расчёт по весам КМ из БАРС. Итоговую оценку выставляет преподаватель.
          </p>
        </div>
      )}
    </BottomSheet>
  );
}

function WarningCard({
  reason,
  sum,
}: {
  reason: 'empty' | 'missing' | 'sum';
  sum: number;
}) {
  const title =
    reason === 'missing'
      ? 'У части КМ не указан вес'
      : reason === 'sum'
        ? 'Веса КМ неполные'
        : 'В БАРС нет контрольных мероприятий';

  const text =
    reason === 'missing'
      ? 'БАРС не прислал вес хотя бы одной контрольной точки, поэтому прогноз был бы неверным.'
      : reason === 'sum'
        ? `Сумма весов ${formatScore(sum, 0)}% вместо 100%. Расчёт отключён, чтобы не показывать ложные баллы.`
        : 'В снимке успеваемости нет КМ с весами.';

  return (
    <InfoCard
      icon={<AlertCircle size={18} aria-hidden />}
      title={title}
      text={text}
      tone="warning"
    />
  );
}

function InfoCard({
  icon,
  title,
  text,
  tone,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  tone: 'success' | 'warning';
}) {
  const color = tone === 'success' ? 'var(--success)' : 'var(--warning)';
  const soft = tone === 'success' ? 'rgba(52, 199, 89, 0.12)' : 'rgba(255, 149, 0, 0.12)';

  return (
    <div className="flex items-start gap-3 rounded-[16px] px-3.5 py-3" style={{ background: soft }}>
      <span className="mt-0.5 shrink-0" style={{ color }}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-snug">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">{text}</p>
      </div>
    </div>
  );
}
