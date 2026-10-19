/**
 * Календарь для быстрого перехода к дате.
 *
 * Свой лёгкий месячный вид вместо календарного фреймворка: нужен ровно один
 * экран — сетка Пн…Вс, листание месяцев и выбор даты. Тянуть ради этого
 * отдельный пакет (и его локали) смысла нет.
 *
 * ── Горизонт ±180 дней ─────────────────────────────────────────────────────
 *
 * Границы считаются от «сегодня» по МСК и передаются в календарь уже готовыми
 * датами в UTC-полуночи: арифметика идёт только через getUTCDate/setUTCDate,
 * поэтому результат одинаков в любой зоне устройства (см. lib/dates.ts).
 *
 * ── Две разные границы ─────────────────────────────────────────────────────
 *
 * Горизонт ±180 — это докуда календарь вообще листается (дальше даты
 * заблокированы). Окно загрузки расписания (minRaw…maxRaw, «−14…+90 дней» от
 * сервера) — другое: такие даты ВЫБРАТЬ можно, но пары за них ещё не выгружены.
 * Поэтому они не блокируются, а приглушаются, и решение о них принимает экран
 * расписания (показывает пояснение, а не пустую ленту).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { formatRawDate, parseRawDate } from '@/lib/dates';
import { haptic } from '@/lib/env';

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/** Месяцы в родительном падеже — для подписи кнопки дня. */
const MONTH_NAMES_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Горизонт листания: ±180 дней от «сегодня» по МСК. */
const HORIZON_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(date.getUTCDate() + days);
  return next;
}

/** Понедельник недели, в которую попадает дата (все методы — UTC). */
function mondayOf(date: Date): Date {
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return monday;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/** Разница в сутках (b − a) — только для UTC-полуночей. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export interface CalendarModalProps {
  open: boolean;
  onClose: () => void;
  /** День, от которого открывается месяц; он же подсвечен как выбранный. */
  anchor: string | null;
  /** Сегодня по МСК (YYYY.MM.DD). */
  today: string;
  /** Границы выгруженного расписания — по ним дни помечаются «не загружено». */
  minRaw: string | null;
  maxRaw: string | null;
  /** Даты, на которые есть пары: у них рисуется точка. */
  lessonDays: Set<string>;
  /** Выбор даты. Закрытие модалки — забота вызывающего экрана. */
  onPick: (raw: string) => void;
}

export function CalendarModal({
  open,
  onClose,
  anchor,
  today,
  minRaw,
  maxRaw,
  lessonDays,
  onPick,
}: CalendarModalProps) {
  const [cursor, setCursor] = useState<Date>(
    () => startOfMonth(parseRawDate(today) ?? new Date()),
  );
  const [focused, setFocused] = useState<string>(today);

  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** Кто был в фокусе до открытия: туда же возвращаем его после закрытия. */
  const prevFocusRef = useRef<Element | null>(null);

  // Открытие: месяц — по выбранному дню, курсор клавиатуры — на нём же.
  // Намеренно без сброса на каждое изменение anchor: пока модалка открыта,
  // листание месяцев и стрелки не должны откатываться к исходному дню.
  useEffect(() => {
    if (!open) return;
    const base = anchor ?? today;
    setFocused(base);
    setCursor(startOfMonth(parseRawDate(base) ?? parseRawDate(today) ?? new Date()));
  }, [open, anchor, today]);

  // Возврат фокуса после закрытия — до восстановления не трогаем ничего.
  useEffect(() => {
    if (open) {
      prevFocusRef.current = document.activeElement;
      return;
    }
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    if (prev instanceof HTMLElement && document.contains(prev)) prev.focus();
  }, [open]);

  // Фокус на активной клетке: стрелки ходят по сетке, а не по кнопкам шапки.
  useEffect(() => {
    if (!open) return;
    cellRefs.current.get(focused)?.focus();
  }, [open, focused]);

  const { cells, todayDate } = useMemo(() => {
    const base = parseRawDate(today) ?? new Date();
    const first = startOfMonth(cursor);
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const from = mondayOf(first);
    const weeks = Math.round((mondayOf(lastDay).getTime() - from.getTime()) / DAY_MS) / 7 + 1;

    return {
      cells: Array.from({ length: weeks * 7 }, (_, i) => addDays(from, i)),
      todayDate: base,
    };
  }, [cursor, today]);

  const horizonMin = addDays(todayDate, -HORIZON_DAYS);
  const horizonMax = addDays(todayDate, HORIZON_DAYS);

  const prevMonthLast = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 0));
  const nextMonthFirst = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  const canPrev = prevMonthLast >= horizonMin;
  const canNext = nextMonthFirst <= horizonMax;

  const shiftMonth = useCallback((delta: number) => {
    haptic('light');
    setCursor(
      (prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + delta, 1)),
    );
  }, []);

  const moveFocus = useCallback(
    (step: number) => {
      const base = parseRawDate(today);
      const current = parseRawDate(focused);
      if (!base || !current) return;

      const next = addDays(current, step);
      if (Math.abs(daysBetween(base, next)) > HORIZON_DAYS) return;

      setFocused(formatRawDate(next));
      setCursor((prev) => (isSameMonth(prev, next) ? prev : startOfMonth(next)));
    },
    [focused, today],
  );

  const pick = useCallback(
    (raw: string) => {
      haptic('light');
      onPick(raw);
    },
    [onPick],
  );

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      haptic('light');
      onClose();
      return;
    }

    if (event.key !== 'Tab') return;

    // Ловушка фокуса: пока модалка открыта, Tab не должен уходить на страницу
    // под ней. Простой цикл по первым и последним элементам — этого достаточно,
    // потому что в календаре нет вложенных диалогов и полей ввода.
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    if (!focusables || focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -7
            : event.key === 'ArrowDown'
              ? 7
              : 0;

    if (step === 0) return;
    event.preventDefault();
    moveFocus(step);
  };

  const todayWeekStart = formatRawDate(mondayOf(todayDate));
  const cursorTitle = `${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`;

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <motion.button
            type="button"
            aria-label="Закрыть календарь"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => {
              haptic('light');
              onClose();
            }}
            className="absolute inset-0 bg-black/40"
          />

          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Календарь"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
            onKeyDown={onDialogKeyDown}
            className="relative w-full max-w-[340px] rounded-[20px] px-3.5 pt-4 pb-[calc(14px+env(safe-area-inset-bottom))] sm:pb-4"
            style={{ background: 'var(--surface)' }}
          >
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h2 className="text-[17px] font-semibold">Календарь</h2>
              <span className="text-[12px] text-[var(--text-tertiary)]">
                доступно ±{HORIZON_DAYS} дней
              </span>
            </div>

            <div className="mb-1 flex items-center justify-between px-1">
              <button
                type="button"
                aria-label="Предыдущий месяц"
                disabled={!canPrev}
                onClick={() => shiftMonth(-1)}
                className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
                style={{ color: 'var(--accent)' }}
              >
                <ChevronLeft size={20} aria-hidden />
              </button>

              <span aria-live="polite" className="text-[15px] font-semibold">
                {cursorTitle}
              </span>

              <button
                type="button"
                aria-label="Следующий месяц"
                disabled={!canNext}
                onClick={() => shiftMonth(1)}
                className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
                style={{ color: 'var(--accent)' }}
              >
                <ChevronRight size={20} aria-hidden />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 px-1" aria-hidden>
              {WEEKDAY_SHORT.map((label) => (
                <span
                  key={label}
                  className="flex h-6 items-center justify-center text-[11px] font-medium text-[var(--text-tertiary)]"
                >
                  {label}
                </span>
              ))}
            </div>

            <div
              role="group"
              aria-label="Дни месяца"
              className="grid grid-cols-7 gap-1 px-1"
              onKeyDown={onGridKeyDown}
            >
              {cells.map((date) => {
                const raw = formatRawDate(date);
                const disabled = Math.abs(daysBetween(todayDate, date)) > HORIZON_DAYS;
                const inMonth = isSameMonth(date, cursor);
                const isToday = raw === today;
                const isSelected = raw === anchor;
                const hasLessons = lessonDays.has(raw);
                const loaded =
                  (minRaw === null || raw >= minRaw) && (maxRaw === null || raw <= maxRaw);

                const color = disabled
                  ? 'var(--text-tertiary)'
                  : isSelected
                    ? 'var(--accent-text)'
                    : isToday
                      ? 'var(--accent)'
                      : inMonth && loaded
                        ? 'var(--text-primary)'
                        : 'var(--text-tertiary)';

                return (
                  <button
                    key={raw}
                    ref={(node) => {
                      if (node) cellRefs.current.set(raw, node);
                      else cellRefs.current.delete(raw);
                    }}
                    type="button"
                    disabled={disabled}
                    tabIndex={raw === focused ? 0 : -1}
                    aria-pressed={isSelected}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={
                      `${date.getUTCDate()} ${MONTH_NAMES_GEN[date.getUTCMonth()]}` +
                      (isToday ? ', сегодня' : '') +
                      (hasLessons ? ', есть пары' : '') +
                      (loaded ? '' : ', расписание не загружено')
                    }
                    onClick={() => pick(raw)}
                    className="relative flex h-10 items-center justify-center rounded-[10px] text-[15px] tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] disabled:cursor-default"
                    style={{
                      background: isSelected ? 'var(--accent)' : 'transparent',
                      boxShadow:
                        !disabled && isToday && !isSelected
                          ? 'inset 0 0 0 1.5px var(--accent)'
                          : 'none',
                      color,
                      opacity: disabled ? 0.35 : inMonth ? 1 : 0.55,
                    }}
                  >
                    {date.getUTCDate()}

                    {hasLessons ? (
                      <span
                        aria-hidden
                        className="absolute bottom-[3px] h-1 w-1 rounded-full"
                        style={{ background: isSelected ? 'var(--accent-text)' : 'var(--accent)' }}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex gap-2 px-1">
              <button
                type="button"
                onClick={() => pick(today)}
                className="pressable flex-1 rounded-[12px] py-2 text-[14px] font-semibold active:pressable-active"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                Сегодня
              </button>
              <button
                type="button"
                aria-label="Текущая неделя, понедельник–воскресенье"
                onClick={() => pick(todayWeekStart)}
                className="pressable flex-1 rounded-[12px] py-2 text-[14px] font-semibold active:pressable-active"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                Эта неделя
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                onClose();
              }}
              className="pressable mt-2 w-full rounded-[12px] py-2.5 text-[15px] font-semibold active:pressable-active"
              style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}
            >
              Закрыть
            </button>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
