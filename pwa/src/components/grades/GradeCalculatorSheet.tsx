/**
 * Калькулятор оценок: «что нужно, чтобы выйти на цель».
 *
 * Лист открывается поверх «Успеваемости» и работает только с уже полученным
 * снимком БАРС. Сервер не участвует: веса КМ и баллы приходят вместе с
 * оценками, а расчёт — чистая функция из `lib/gradeCalc`.
 *
 * Дизайн намеренно короткий: предмет → цель 3/4/5 → ответ. Никаких сценариев
 * «а если получу» и ручных порогов — они превращали лист в анкету и заставляли
 * пересчитывать всё на каждое движение слайдера.
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

/** Нижняя и верхняя границы шкалы порога. */
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
  const [target, setTarget] = useState<number>(4);

  // При открытии выбираем предмет с незакрытыми КМ: именно для него есть
  // смысл в прогнозе. Если такого нет — первый в списке.
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

  /*
   * Все расчёты — в useMemo. Раньше они выполнялись на каждый рендер, в том
   * числе на каждое движение слайдера цели: отсюда и ощущение «тупит».
   */
  const weights = useMemo(() => checkWeights(subject), [subject]);
  const current = useMemo(() => (subject ? currentWeighted(subject) : null), [subject]);
  const maximum = useMemo(() => (subject ? maxPossible(subject) : null), [subject]);
  const sums = useMemo(() => (subject ? weightSums(subject) : null), [subject]);
  const required = useMemo(
    () => (subject ? requiredAverage(subject, target) : null),
    [subject, target],
  );
  const plan = useMemo(
    () => (subject ? minimumPlan(subject, target) : null),
    [subject, target],
  );

  const pending = useMemo(
    () =>
      (subject?.controlPoints ?? []).filter(
        (point) => point.score === null && typeof point.weight === 'number' && point.weight > 0,
      ),
    [subject],
  );

  const minPossible = useMemo(() => {
    if (!subject || !sums || sums.total <= 0) return null;
    return Math.round((earnedWeighted(subject) / sums.total) * 100) / 100;
  }, [subject, sums]);

  // При смене предмета порог встаёт на текущий средний: человек сразу видит,
  // где он сейчас, и двигает ползунок от этой точки.
  useEffect(() => {
    if (!subject) return;
    const now = currentWeighted(subject);
    setTarget(now !== null ? clamp(round1(now), MIN_SCALE, MAX_SCALE) : 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.discipline]);

  const progress = sums && sums.total > 0 ? Math.min(1, sums.graded / sums.total) : 0;
  const reachable = maximum === null || maximum + 1e-6 >= target;

  /** Положение значения на шкале 2–5 в процентах. */
  const pct = (value: number): number => {
    const clamped = clamp(value, MIN_SCALE, MAX_SCALE);
    return ((clamped - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100;
  };

  /*
   * Трек ползунка показывает три зоны:
   *   серый  — ниже минимума (такого среднего уже не получить);
   *   зелёный — от минимума до текущего (порог уже взят);
   *   акцент — от текущего до максимума (сюда ещё можно дотянуть);
   *   красный — выше максимума (даже пятёрки не хватит).
   */
  const currentPos = pct(current ?? minPossible ?? MIN_SCALE);
  const maxPos = pct(maximum ?? MAX_SCALE);
  const minPos = pct(minPossible ?? MIN_SCALE);
  const trackBackground = `linear-gradient(90deg,
    var(--separator-soft) 0%,
    var(--separator-soft) ${minPos}%,
    var(--success) ${minPos}%,
    var(--success) ${currentPos}%,
    var(--accent) ${currentPos}%,
    var(--accent) ${maxPos}%,
    rgba(255, 59, 48, 0.35) ${maxPos}%,
    rgba(255, 59, 48, 0.35) 100%)`;

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
        <div className="space-y-5 pb-3">
          {/* Предмет: горизонтальные чипы вместо выпадающего списка. */}
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

          {/* Текущий балл и прогресс семестра. */}
          <section
            className="rounded-[20px] px-4 py-4"
            style={{
              background:
                'linear-gradient(135deg, var(--accent-soft), rgba(124,77,255,0.02) 72%)',
              border: '1px solid var(--separator-soft)',
            }}
          >
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  Средний сейчас
                </p>
                <p className="mt-1 text-[42px] font-bold leading-none tracking-[-0.02em] tabular-nums">
                  {formatScore(current, 2)}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p className="text-[11px] text-[var(--text-tertiary)]">БАРС</p>
                <p className="mt-1 text-[22px] font-semibold leading-none tabular-nums text-[var(--text-secondary)]">
                  {formatScore(subject.barsAverage, 1)}
                </p>
              </div>
            </div>

            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--separator-soft)]">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.round(progress * 100)}%`, background: 'var(--accent)' }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
              Закрыто {Math.round(progress * 100)}% веса
              {sums && sums.pending > 0 ? ` · осталось ${formatScore(sums.pending, 0)}%` : ''}
            </p>
          </section>

          {/* Порог автомата: свободный ползунок с зонами достижимости. */}
          <section>
            <div className="mb-2 flex items-end justify-between gap-3 px-1">
              <span className="text-[12px] font-semibold text-[var(--text-secondary)]">
                Порог автомата
              </span>
              <span
                className="text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums"
                style={{ color: 'var(--accent)' }}
              >
                {formatScore(target, 1)}
              </span>
            </div>

            <div className="relative h-9">
              <div
                className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
                style={{ background: trackBackground }}
                aria-hidden
              />
              {/* Где человек сейчас — тонкая метка на треке. */}
              <div
                className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full"
                style={{
                  left: `calc(${currentPos}% - 1px)`,
                  background: 'var(--text-primary)',
                  opacity: 0.45,
                }}
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
                className="mood-range absolute inset-0 h-9 w-full cursor-pointer"
              />
            </div>

            <div className="mt-1 flex items-center justify-between px-0.5 text-[10px] tabular-nums text-[var(--text-tertiary)]">
              <span>мин {formatScore(minPossible, 2)}</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                сейчас {formatScore(current, 2)}
              </span>
              <span>макс {formatScore(maximum, 2)}</span>
            </div>
          </section>

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
              text={`Итоговый средний — ${formatScore(current, 2)}. Изменить его новыми баллами уже нельзя.`}
              tone="success"
            />
          ) : !reachable ? (
            <InfoCard
              icon={<AlertCircle size={18} aria-hidden />}
              title={`До ${target} не дотянуть`}
              text={`Даже пятёрки за всё оставшееся дают максимум ${formatScore(maximum, 2)}.`}
              tone="warning"
            />
          ) : required !== null && required <= 0 ? (
            <InfoCard
              icon={<CheckCircle2 size={18} aria-hidden />}
              title={`Цель ${target} уже достигнута`}
              text={`Текущий средний ${formatScore(current, 2)} — баллы можно не добирать.`}
              tone="success"
            />
          ) : (
            <>
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                  <p className="text-[12px] font-semibold text-[var(--text-secondary)]">
                    Что написать за оставшиеся КМ
                  </p>
                  <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
                    {pending.length} КМ
                  </span>
                </div>
                <div className="space-y-2">
                  {plan?.items.map((item) => (
                    <div
                      key={item.point.number}
                      className="flex items-center gap-3 rounded-[14px] px-3.5 py-3"
                      style={{ background: 'var(--surface-grouped)' }}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        {item.point.number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px]">
                          {item.point.title ?? 'Без названия'}
                        </p>
                        <p className="mt-0.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                          вес {formatScore(item.point.weight, 0)}%
                        </p>
                      </div>
                      <span
                        className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums"
                        style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
                      >
                        ≥ {formatScore(item.score, 0)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </>
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
