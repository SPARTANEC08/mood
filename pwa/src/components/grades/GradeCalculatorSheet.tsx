/**
 * Калькулятор оценок: «что нужно, чтобы выйти на цель».
 *
 * Лист открывается поверх «Успеваемости» и работает только с уже полученным
 * снимком БАРС. Сервер не участвует: веса КМ и баллы приходят вместе с
 * оценками, а расчёт — чистая функция из `lib/gradeCalc`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Calculator, CheckCircle2 } from 'lucide-react';

import { BottomSheet, EmptyState } from '@/components/ui';
import { plural } from '@/lib/dates';
import {
  checkWeights,
  currentWeighted,
  formatRequiredAverage,
  maxPossible,
  minimumPlan,
  predictGrade,
  requiredAverage,
  simulateAverage,
  type GradeThresholds,
} from '@/lib/gradeCalc';
import { formatScore } from '@/lib/gradeDetails';
import { haptic } from '@/lib/env';
import type { GradesResponse } from '@/types/api';

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
  const [target, setTarget] = useState(4);
  const [thresholds, setThresholds] = useState({ five: '', four: '', three: '' });
  /** Введённые баллы за оставшиеся КМ: ключ — номер КМ. */
  const [simulation, setSimulation] = useState<Record<number, string>>({});

  // При открытии выбираем предмет с незакрытыми КМ: именно для него есть
  // смысл в прогнозе. Если такого нет — первый в списке.
  useEffect(() => {
    if (!open || subjects.length === 0) return;

    setDiscipline((previous) => {
      if (subjects.some((subject) => subject.discipline === previous)) return previous;
      return (subjects.find((subject) => subject.pendingCount > 0) ?? subjects[0]!).discipline;
    });
    // subjects — производная от grades; пересоздаётся при обновлении снимка,
    // поэтому зависим от самого листа, а не от массива.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, grades]);

  const subject =
    subjects.find((candidate) => candidate.discipline === discipline) ?? subjects[0] ?? null;

  // Смена предмета сбрасывает цель и сценарий: чужие значения здесь опасны.
  useEffect(() => {
    if (!subject) return;

    const current = currentWeighted(subject);
    setTarget(current !== null ? Math.min(5, Math.max(2, round1(current))) : 4);
    setSimulation({});
    setThresholds({ five: '', four: '', three: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.discipline]);

  const weights = checkWeights(subject);
  const current = subject ? currentWeighted(subject) : null;
  const required = subject ? requiredAverage(subject, target) : null;
  const plan = subject ? minimumPlan(subject, target) : null;
  const maximum = subject ? maxPossible(subject) : null;

  const pending = useMemo(
    () =>
      (subject?.controlPoints ?? []).filter(
        (point) => point.score === null && typeof point.weight === 'number' && point.weight > 0,
      ),
    [subject],
  );

  const planByPoint = new Map(plan?.items.map((item) => [item.point.number, item.score]) ?? []);

  const simulationScores = useMemo(() => {
    const result: Record<number, number | null> = {};
    for (const point of pending) {
      const raw = simulation[point.number];
      if (raw === undefined || raw.trim() === '') {
        result[point.number] = planByPoint.get(point.number) ?? 0;
        continue;
      }

      const parsed = Number(raw);
      result[point.number] =
        Number.isFinite(parsed) ? Math.min(5, Math.max(0, parsed)) : null;
    }
    return result;
  }, [pending, simulation, planByPoint]);

  const simulatedAverage = subject ? simulateAverage(subject, simulationScores) : null;
  const gradeThresholds: GradeThresholds = {
    five: parseThreshold(thresholds.five),
    four: parseThreshold(thresholds.four),
    three: parseThreshold(thresholds.three),
  };
  const predicted = predictGrade(simulatedAverage, gradeThresholds);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Калькулятор оценок"
      closeLabel="Закрыть"
      height="min(720px, 85dvh)"
    >
      {!grades || subjects.length === 0 || !subject ? (
        <EmptyState
          title="Нет данных для расчёта"
          description="Оценки ещё не загрузились — вернитесь на экран успеваемости и обновите его."
        />
      ) : (
        <div className="space-y-4 pb-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
              Предмет
            </span>
            <select
              value={subject.discipline}
              onChange={(event) => {
                haptic('light');
                setDiscipline(event.target.value);
              }}
              className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              {subjects.map((item) => (
                <option key={item.discipline} value={item.discipline}>
                  {item.discipline}
                  {item.pendingCount > 0 ? ` · ${item.pendingCount} КМ` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <SummaryTile
              label="Наш средний"
              value={current}
              hint="по весам КМ"
            />
            <SummaryTile
              label="БАРС"
              value={subject.barsAverage}
              hint="балл из личного кабинета"
            />
          </div>

          <section>
            <h4 className="mb-1.5 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
              Контрольные мероприятия
            </h4>
            <div className="overflow-hidden rounded-[14px] border border-[var(--separator-soft)]">
              {subject.controlPoints.map((point) => (
                <div
                  key={point.number}
                  className="flex items-center gap-3 border-t border-[var(--separator-soft)] px-3.5 py-2.5 first:border-t-0"
                >
                  <span className="w-10 shrink-0 text-[11px] font-medium text-[var(--text-tertiary)]">
                    КМ {point.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {point.title ?? 'Без названия'}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                    {typeof point.weight === 'number' ? `${point.weight}%` : 'вес —'}
                  </span>
                  <span
                    className="w-10 shrink-0 text-right text-[14px] font-semibold tabular-nums"
                    style={{
                      color:
                        point.score === null
                          ? 'var(--text-tertiary)'
                          : point.score <= 2
                            ? 'var(--danger)'
                            : 'var(--text-primary)',
                    }}
                  >
                    {point.score === null ? '—' : formatScore(point.score)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {weights.reason !== 'ok' ? (
            <WarningCard weights={weights.reason} sum={weights.sum} />
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
              text={`Итоговый средний — ${formatScore(current)}. Изменить его новыми баллами уже нельзя.`}
              tone="success"
            />
          ) : (
            <>
              <section
                className="rounded-[16px] px-4 py-4"
                style={{ background: 'var(--accent-soft)' }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                    Цель за семестр
                  </span>
                  <span
                    className="text-[20px] font-semibold tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {formatScore(target, 1)}
                  </span>
                </div>

                <input
                  type="range"
                  min={2}
                  max={5}
                  step={0.1}
                  value={target}
                  onChange={(event) => setTarget(Number(event.target.value))}
                  aria-label="Целевой средний балл"
                  className="mt-2 w-full accent-[var(--accent)]"
                />

                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={2}
                    max={5}
                    step={0.1}
                    value={target}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        setTarget(Math.min(5, Math.max(2, round1(value))));
                      }
                    }}
                    className="w-24 rounded-[10px] border border-[var(--separator-soft)] bg-[var(--surface)] px-2.5 py-1.5 text-[14px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-secondary)]">
                    вручную, шаг 0,1
                  </span>
                </div>
              </section>

              {required === null ? null : required <= 0 ? (
                <InfoCard
                  icon={<CheckCircle2 size={18} aria-hidden />}
                  title="Цель уже достигнута"
                  text={`Текущий средний ${formatScore(current)} — можно не добирать баллы.`}
                  tone="success"
                />
              ) : !plan?.feasible ? (
                <WarningCard
                  weights="unreachable"
                  sum={0}
                  maximum={maximum}
                  target={target}
                />
              ) : (
                <section>
                  <div
                    className="rounded-[16px] px-4 py-3.5"
                    style={{ background: 'var(--surface-grouped)' }}
                  >
                    <p className="text-[12px] text-[var(--text-secondary)]">
                      Нужно в среднем за оставшиеся {pending.length}{' '}
                      {plural(pending.length, 'КМ', 'КМ', 'КМ')}
                    </p>
                    <p
                      className="mt-1 text-[26px] font-semibold leading-none tabular-nums"
                      style={{ color: 'var(--accent)' }}
                    >
                      {formatRequiredAverage(required)}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                      Точное значение — {formatScore(required, 2)}
                    </p>
                  </div>

                  <h4 className="mb-1.5 mt-3 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
                    Минимальные баллы
                  </h4>
                  <div className="overflow-hidden rounded-[14px] border border-[var(--separator-soft)]">
                    {plan?.items.map((item) => (
                      <div
                        key={item.point.number}
                        className="flex items-center gap-3 border-t border-[var(--separator-soft)] px-3.5 py-2.5 first:border-t-0"
                      >
                        <span className="w-10 shrink-0 text-[11px] font-medium text-[var(--text-tertiary)]">
                          КМ {item.point.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {item.point.title ?? 'Без названия'}
                        </span>
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold tabular-nums"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                        >
                          ≥ {item.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h4 className="mb-1.5 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
                  А если получу
                </h4>
                <div className="space-y-2">
                  {pending.map((point) => (
                    <label
                      key={point.number}
                      className="flex items-center gap-3 rounded-[12px] px-3 py-2"
                      style={{ background: 'var(--surface-grouped)' }}
                    >
                      <span className="w-10 shrink-0 text-[11px] font-medium text-[var(--text-tertiary)]">
                        КМ {point.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {point.title ?? 'Без названия'}
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={5}
                        step={0.1}
                        inputMode="decimal"
                        placeholder={String(planByPoint.get(point.number) ?? 0)}
                        value={simulation[point.number] ?? ''}
                        onChange={(event) =>
                          setSimulation((previous) => ({
                            ...previous,
                            [point.number]: event.target.value,
                          }))
                        }
                        className="w-16 shrink-0 rounded-[9px] border border-[var(--separator-soft)] bg-[var(--surface)] px-2 py-1 text-right text-[14px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                  ))}
                </div>

                <div className="mt-2 flex items-center justify-between gap-3 px-1">
                  <span className="text-[12px] text-[var(--text-secondary)]">
                    Итог: {formatScore(simulatedAverage, 2)}
                    {predicted ? ` · оценка ${predicted}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light');
                      setSimulation({});
                    }}
                    className="pressable text-[12px] font-semibold active:pressable-active"
                    style={{ color: 'var(--accent)' }}
                  >
                    Подставить минимум
                  </button>
                </div>
              </section>

              <section>
                <h4 className="mb-1.5 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
                  Пороги для прогноза оценки
                </h4>
                <p className="mb-2 px-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                  Вводятся вручную: у разных преподавателей пороги автомата разные.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <ThresholdInput
                    label="5 от"
                    value={thresholds.five}
                    onChange={(value) =>
                      setThresholds((previous) => ({ ...previous, five: value }))
                    }
                  />
                  <ThresholdInput
                    label="4 от"
                    value={thresholds.four}
                    onChange={(value) =>
                      setThresholds((previous) => ({ ...previous, four: value }))
                    }
                  />
                  <ThresholdInput
                    label="3 от"
                    value={thresholds.three}
                    onChange={(value) =>
                      setThresholds((previous) => ({ ...previous, three: value }))
                    }
                  />
                </div>
              </section>

              <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                <Calculator size={13} className="mt-0.5 shrink-0" aria-hidden />
                Расчёт по весам КМ. Итоговую оценку выставляет преподаватель,
                а пороги автомата зависят от предмета.
              </p>
            </>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint: string;
}) {
  return (
    <div className="surface-grouped rounded-[14px] px-3.5 py-3">
      <p className="text-[11px] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-none tabular-nums">
        {formatScore(value, 1)}
      </p>
      <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{hint}</p>
    </div>
  );
}

function ThresholdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">{label}</span>
      <input
        type="number"
        min={0}
        max={5}
        step={0.1}
        inputMode="decimal"
        placeholder="—"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[10px] border border-[var(--separator-soft)] bg-[var(--surface)] px-2.5 py-1.5 text-right text-[14px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
    </label>
  );
}

function WarningCard({
  weights,
  sum,
  maximum,
  target,
}: {
  weights: 'empty' | 'missing' | 'sum' | 'unreachable';
  sum: number;
  maximum?: number | null;
  target?: number;
}) {
  const title =
    weights === 'unreachable'
      ? 'Цель недостижима'
      : weights === 'missing'
        ? 'У части КМ не указан вес'
        : weights === 'sum'
          ? 'Веса КМ неполные'
          : 'В БАРС нет контрольных мероприятий';

  const text =
    weights === 'unreachable'
      ? `Даже пятёрки за всё оставшееся дают максимум ${formatScore(maximum)} — до цели ${formatScore(target)} не дотянуть.`
      : weights === 'missing'
        ? 'БАРС не прислал вес хотя бы одной контрольной точки, поэтому прогноз был бы неверным.'
        : weights === 'sum'
          ? `Сумма весов ${formatScore(sum)}% вместо 100%. Расчёт отключён, чтобы не показывать ложные баллы.`
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
    <div className="flex items-start gap-3 rounded-[14px] px-3.5 py-3" style={{ background: soft }}>
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

function parseThreshold(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
