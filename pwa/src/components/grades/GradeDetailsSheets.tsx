/**
 * Нижние листы с деталями «Успеваемости».
 *
 * Три карточки на странице (задолженности, рейтинг, пропуски) раньше были
 * только цифрами. Теперь по тапу открывается тот же BottomSheet, что и у
 * уведомлений: человек остаётся на вкладке, а подробности не превращают
 * основной экран в простыню.
 */

import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';

import { BottomSheet, EmptyState } from '@/components/ui';
import { plural } from '@/lib/dates';
import {
  attendanceRows,
  collectDebts,
  formatScore,
  hasRatingValues,
  ratingRows,
  type DebtItem,
} from '@/lib/gradeDetails';
import type {
  AttendanceResponse,
  BarsMoreResponse,
  GradesResponse,
} from '@/types/api';

export type GradeDetailSheet = 'debts' | 'rating' | 'attendance';

export function GradeDetailsSheets({
  sheet,
  onClose,
  grades,
  more,
  attendance,
}: {
  sheet: GradeDetailSheet | null;
  onClose: () => void;
  grades: GradesResponse | null;
  more: BarsMoreResponse | null;
  attendance: AttendanceResponse | null;
}) {
  const debts = useMemo(() => collectDebts(grades), [grades]);
  const debtGroups = useMemo(() => {
    const map = new Map<string, DebtItem[]>();
    for (const item of debts) {
      const group = map.get(item.discipline);
      if (group) group.push(item);
      else map.set(item.discipline, [item]);
    }
    return [...map.entries()];
  }, [debts]);

  const rows = useMemo(() => ratingRows(more?.rating), [more]);
  const ratingAvailable = useMemo(() => hasRatingValues(more?.rating), [more]);
  const subjectAttendance = useMemo(() => attendanceRows(attendance), [attendance]);

  return (
    <>
      <BottomSheet
        open={sheet === 'debts'}
        onClose={onClose}
        title={debts.length > 0 ? `Задолженности · ${debts.length}` : 'Задолженности'}
        closeLabel="Закрыть"
        height="min(680px, 85dvh)"
      >
        {debts.length === 0 ? (
          <EmptyState
            title="Задолженностей нет"
            description="Двоек за контрольные мероприятия в БАРС нет."
          />
        ) : (
          <div className="space-y-4 pb-2">
            {debtGroups.map(([discipline, items]) => (
              <section key={discipline}>
                <h4 className="mb-1.5 px-1 text-[12px] font-semibold leading-snug text-[var(--text-secondary)]">
                  {discipline}
                </h4>

                <div className="space-y-2">
                  {items.map((item) => (
                    <div
                      key={item.key}
                      className="surface-grouped rounded-[14px] px-3.5 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium leading-snug">
                            КМ {item.point}
                            {item.title ? ` · ${item.title}` : ''}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
                            {[
                              item.weight !== undefined ? `вес ${item.weight}%` : '',
                              item.week ?? '',
                              item.date ?? '',
                            ]
                              .filter(Boolean)
                              .join(' · ') || 'Без дополнительных данных'}
                          </p>
                        </div>

                        <span
                          className="shrink-0 text-[17px] font-semibold leading-none tabular-nums"
                          style={{ color: 'var(--danger)' }}
                        >
                          {formatScore(item.score)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </BottomSheet>

      <BottomSheet
        open={sheet === 'rating'}
        onClose={onClose}
        title="Внутривузовский рейтинг"
        closeLabel="Закрыть"
        height="min(680px, 85dvh)"
      >
        {!ratingAvailable || !more?.rating ? (
          <EmptyState
            title="Данных рейтинга пока нет"
            description="БАРС не вернул баллы за текущий период."
          />
        ) : (
          <div className="space-y-4 pb-2">
            <div
              className="rounded-[16px] px-4 py-4"
              style={{ background: 'var(--accent-soft)' }}
            >
              <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                Комплексный балл
              </p>
              <p
                className="mt-1 text-[32px] font-semibold leading-none tabular-nums"
                style={{ color: 'var(--accent)' }}
              >
                {formatScore(
                  more.rating.comprehensive?.semester ??
                    more.rating.comprehensive?.total,
                )}
              </p>
              <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                {more.rating.period ?? 'за семестр'}
              </p>
            </div>

            <div className="overflow-hidden rounded-[14px] border border-[var(--separator-soft)]">
              <div
                className="grid grid-cols-[1fr_64px_64px] gap-2 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  background: 'var(--surface-grouped)',
                  color: 'var(--text-tertiary)',
                }}
              >
                <span>Раздел</span>
                <span className="text-right">Семестр</span>
                <span className="text-right">Всего</span>
              </div>

              {rows.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[1fr_64px_64px] gap-2 border-t border-[var(--separator-soft)] px-3.5 py-2.5"
                >
                  <span className="min-w-0 text-[13px] leading-snug">{row.title}</span>
                  <span className="text-right text-[13px] tabular-nums">
                    {formatScore(row.semester)}
                  </span>
                  <span className="text-right text-[13px] tabular-nums text-[var(--text-secondary)]">
                    {formatScore(row.total)}
                  </span>
                </div>
              ))}
            </div>

            <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
              Баллы приходят из БАРС и обновляются вместе с остальным снимком
              личного кабинета.
            </p>
          </div>
        )}
      </BottomSheet>

      <BottomSheet
        open={sheet === 'attendance'}
        onClose={onClose}
        title="Пропуски"
        closeLabel="Закрыть"
        height="min(680px, 85dvh)"
      >
        {!attendance ? (
          <EmptyState
            title="Нет данных о пропусках"
            description="БАРС не вернул раздел пропусков — попробуйте обновить экран."
          />
        ) : (
          <div className="space-y-4 pb-2">
            <div className="grid grid-cols-2 gap-2.5">
              <SummaryTile label="Пропущено пар" value={attendance.totalMissedLessons} />
              <SummaryTile label="Всего часов" value={attendance.totalMissedHours} />
              <SummaryTile label="Уважительных" value={attendance.totalExcusedLessons} />
              <SummaryTile label="Неуважительных" value={attendance.totalUnexcusedLessons} />
            </div>

            {subjectAttendance.length === 0 ? (
              <EmptyState
                title="Разбивки по предметам нет"
                description="В БАРС указаны только общие цифры пропусков."
              />
            ) : (
              <section>
                <h4 className="mb-1.5 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
                  По предметам
                </h4>

                <div className="space-y-2">
                  {subjectAttendance.map((row) => (
                    <div
                      key={row.key}
                      className="surface-grouped rounded-[14px] px-3.5 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug">
                          {row.discipline}
                        </p>
                        <span className="shrink-0 text-[15px] font-semibold tabular-nums">
                          {row.missedLessons}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                        {plural(row.missedLessons, 'пара', 'пары', 'пар')} ·{' '}
                        {row.totalMissedHours} ч · уваж. {row.excusedLessons} ·
                        неуваж. {row.unexcusedLessons}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </BottomSheet>
    </>
  );
}

/** Квадрат с общей цифрой пропусков. */
function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="surface-grouped rounded-[14px] px-3.5 py-3">
      <p className="text-[11px] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-none tabular-nums">{value}</p>
    </div>
  );
}
