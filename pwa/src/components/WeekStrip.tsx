import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import { animate, motion, useMotionValue } from 'framer-motion';

import { haptic } from '@/lib/env';
import { formatRawDate, parseRawDate } from '@/lib/dates';
import { SwipePager } from './Pager';
import type { ApiScheduleDay } from '@/types/api';

/**
 * Листание расписания: неделя полосой дат, день — лентой пар.
 *
 * Обе линейки устроены одинаково — это постраничные карусели (SwipePager):
 * полоса дат листает недели, лента пар листает дни внутри текущей недели.
 * Механика пришла из прототипа расписания (pwa/test.tsx): страница уезжает за
 * пальцем на ширину целиком и защёлкивается, а не «тянется резинкой» до
 * порога. Из прежней реализации остались только ручная подсветка выбранного
 * дня и порог в долях ширины окна.
 *
 * Чего здесь нет и почему:
 *  - соседние дни не держатся в absolutely-позиционированных слоях: страницы
 *    смонтированы все, и у каждой своя прокрутка. Раньше окно ленты подгонялось
 *    под высоту текущего дня анимацией, и это был лишний ResizeObserver на
 *    каждое раскрытие домашнего задания;
 *  - свайп по ленте не перескакивает через границу недели: воскресенье —
 *    последняя страница, а неделя меняется свайпом по полосе дат. Иначе один
 *    жест означал бы сразу и смену дня, и смену недели, и переход читался бы
 *    как скачок на произвольную дату;
 *  - `layout`-анимации framer-motion не используются: они меряют геометрию и
 *    вызывают принудительные перерасчёты раскладки. Подсветка едет по треку
 *    через transform, всё считается один раз на смену дня, вне кадра отрисовки.
 */

const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Пружина подсветки выбранного дня.
 *
 * 420/34/0.7 — заметно быстрее содержимого, чтобы вести за пальцем: по
 * содержимому человек ориентируется, подсветка показывает, куда он придёт.
 * Масса меньше единицы, иначе на слабом телефоне подсветка доезжает заметно
 * позже содержимого.
 */
const PILL_SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 } as const;

/**
 * Пороги защёлкивания.
 *
 * Полоса недель ниже: она уже по высоте и ею целятся реже, а неделя — шаг
 * крупнее дня, поэтому и тянуть её можно дальше.
 */
const WEEK_THRESHOLD_RATIO = 0.22;
const DAY_THRESHOLD_PX = 56;

/** Настройки анимации с учётом «уменьшить движение». */
function motionConfig<T extends object>(config: T): T | { duration: 0 } {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return { duration: 0 };
  }
  return config;
}

/* ── полоса недель ────────────────────────────────────────────────────── */

export interface WeekStripProps {
  /** Понедельники доступных недель, по возрастанию. */
  weeks: string[];
  /** Индекс текущей недели в weeks. */
  activeWeek: number;
  onWeekChange: (index: number) => void;
  /** Все дни выгрузки расписания по дате — источник данных для клеток. */
  daysByRaw: Map<string, ApiScheduleDay>;
  /** Границы выгрузки: за ними клетки не рисуются. */
  minRaw: string | null;
  maxRaw: string | null;
  /** Выбранный день — он же подсвечивается в клетке. */
  selectedDate: string | null;
  today: string;
  onSelectDay: (rawDate: string) => void;
}

/**
 * Полоса дат: карусель недель, в каждой — семь клеток Пн…Вс.
 *
 * Неделя едет за пальцем целиком, поэтому смена недели видна как перелистывание
 * всей полосы, а не как подмена семи цифр на месте. Подсветка выбранного дня
 * рисуется только в активной неделе: на соседних страницах её нет, поэтому
 * перелёт через границу не ломается — на активной странице она и появляется,
 * и исчезает, ни одна не «переезжает» на другую.
 */
export function WeekStrip({
  weeks,
  activeWeek,
  onWeekChange,
  daysByRaw,
  minRaw,
  maxRaw,
  selectedDate,
  today,
  onSelectDay,
}: WeekStripProps) {
  return (
    <div className="shrink-0">
      <SwipePager
        count={weeks.length}
        index={activeWeek}
        onIndexChange={onWeekChange}
        thresholdRatio={WEEK_THRESHOLD_RATIO}
        thresholdPx={52}
        className="rounded-[14px]"
        pageClassName="px-0.5"
      >
        {(weekIndex) => (
          <WeekGrid
            mondayRaw={weeks[weekIndex]}
            isActive={weekIndex === activeWeek}
            daysByRaw={daysByRaw}
            minRaw={minRaw}
            maxRaw={maxRaw}
            selectedDate={selectedDate}
            today={today}
            onSelectDay={onSelectDay}
          />
        )}
      </SwipePager>
    </div>
  );
}

/**
 * Семь клеток одной недели.
 *
 * Даты считаются от понедельника недели, а не берутся из выгрузки: в БАРС есть
 * только будни, и сборка «из пришедших дней» обрезала неделю на четверге —
 * суббота и воскресенье исчезали вместе с правом открыть «свободный день».
 *
 * Дни за границами выгрузки клетку не занимают: показывать там «свободный
 * день» значило бы врать — расписание просто ещё не выгружено. Пустая клетка
 * держит сетку из семи колонок, поэтому подсветка ходит по равным шагам.
 */
function WeekGrid({
  mondayRaw,
  isActive,
  daysByRaw,
  minRaw,
  maxRaw,
  selectedDate,
  today,
  onSelectDay,
}: {
  mondayRaw: string;
  isActive: boolean;
  daysByRaw: Map<string, ApiScheduleDay>;
  minRaw: string | null;
  maxRaw: string | null;
  selectedDate: string | null;
  today: string;
  onSelectDay: (rawDate: string) => void;
}) {
  const cells = useMemo(() => {
    const monday = parseRawDate(mondayRaw);
    if (!monday) return [];

    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + i);
      const raw = formatRawDate(date);
      const inRange = (minRaw === null || raw >= minRaw) && (maxRaw === null || raw <= maxRaw);

      return { raw, inRange, day: inRange ? daysByRaw.get(raw) : undefined };
    });
  }, [mondayRaw, daysByRaw, minRaw, maxRaw]);

  const activeIndex = cells.findIndex((cell) => cell.raw === selectedDate);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pillX = useMotionValue(0);
  const pillWidth = useMotionValue(0);
  /** Первое позиционирование подсветки делаем мгновенно, без «проезда». */
  const placedRef = useRef(false);

  useLayoutEffect(() => {
    if (!isActive) return;

    const track = trackRef.current;
    const cell = cellRefs.current[activeIndex];

    if (!track || !cell) {
      pillWidth.set(0);
      return;
    }

    const trackBox = track.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    const targetX = cellBox.left - trackBox.left;

    // На монтировании подсветка иначе анимированно ехала от нулевой клетки к
    // выбранному дню — лишняя ложная анимация при входе и смене вкладки.
    if (!placedRef.current) {
      placedRef.current = true;
      pillX.set(targetX);
      pillWidth.set(cellBox.width);
      return;
    }

    animate(pillX, targetX, motionConfig(PILL_SPRING));

    // Ширина у всех клеток одинакова, но при повороте экрана она меняется —
    // тогда анимируем её сразу, иначе подсветка осталась бы прежней ширины.
    if (Math.abs(pillWidth.get() - cellBox.width) > 0.5) {
      animate(pillWidth, cellBox.width, motionConfig(PILL_SPRING));
    }
  }, [isActive, activeIndex, mondayRaw, pillX, pillWidth]);

  return (
    // Трек — сама сетка: у него есть собственная граница, относительно которой
    // и меряется положение подсветки. Обёртка с display:contents для этого
    // не годится — у неё нет бокса, getBoundingClientRect вернёт нули.
    <div ref={trackRef} className="relative grid grid-cols-7 gap-1.5">
      {/* Подсветка выбранного дня едет под клетками и не пересоздаётся на каждый
          тап: одна transform-анимация вместо перерисовки семи клеток. */}
      {isActive ? (
        <motion.span
          aria-hidden
          className="absolute top-0 bottom-0 left-0 rounded-[12px]"
          style={{ x: pillX, width: pillWidth, background: 'var(--accent)' }}
        />
      ) : null}

      {cells.map((cell, index) => (
        <DateCell
          key={cell.raw}
          raw={cell.raw}
          weekdayLabel={WEEKDAY_LABELS[index]}
          day={cell.day}
          inRange={cell.inRange}
          selectedDate={selectedDate}
          today={today}
          onSelectDay={onSelectDay}
          registerRef={(node) => {
            cellRefs.current[index] = node;
          }}
        />
      ))}
    </div>
  );
}

/**
 * Прямоугольник одного дня.
 *
 * День без пар рисуется: у выходных занятий не бывает, но студенту нужно видеть,
 * что день существует, и нажать его, чтобы получить «свободный день» вместо
 * исчезновения клетки.
 */
function DateCell({
  raw,
  weekdayLabel,
  day,
  inRange,
  selectedDate,
  today,
  onSelectDay,
  registerRef,
}: {
  raw: string;
  weekdayLabel: string;
  day: ApiScheduleDay | undefined;
  inRange: boolean;
  selectedDate: string | null;
  today: string;
  onSelectDay: (rawDate: string) => void;
  registerRef: (node: HTMLButtonElement | null) => void;
}) {
  const date = parseRawDate(raw);
  const isToday = raw === today;
  const selected = raw === selectedDate;
  const isDayOff = (day?.slots?.length ?? 0) === 0;

  return (
    <button
      ref={registerRef}
      type="button"
      // Дата за пределами выгрузки остаётся местом в сетке, но не нажимается:
      // за ней нет ни расписания, ни «свободного дня».
      disabled={!inRange || !date}
      onClick={() => {
        if (!inRange) return;
        haptic('light');
        onSelectDay(raw);
      }}
      aria-label={`${date ? date.getUTCDate() : '—'} ${date ? MONTHS[date.getUTCMonth()] : ''}`}
      aria-pressed={selected}
      className={`relative z-10 flex h-[54px] flex-col items-center justify-center rounded-[12px] ${
        inRange ? 'pressable active:pressable-active' : ''
      }`}
      style={{
        // Заливку выбранного дня рисует подсветка под клеткой, поэтому здесь
        // фон прозрачный: иначе при ездящей анимации клетка «уезжала» бы от
        // своей заливки и тянула цвет за собой.
        background: 'transparent',
        // Обводка приоритетнее заливки: выбранный сегодняшний день фиолетовый
        // целиком, иначе на одной клетке оказалось бы два акцента.
        boxShadow: !inRange
          ? 'none'
          : isToday && !selected
            ? 'inset 0 0 0 1.5px var(--accent)'
            : 'inset 0 0 0 1px var(--separator-soft)',
        color: !inRange
          ? 'var(--text-tertiary)'
          : selected
            ? 'var(--accent-text)'
            : isDayOff
              ? 'var(--text-tertiary)'
              : 'var(--text-primary)',
        cursor: inRange ? undefined : 'default',
      }}
    >
      {inRange && date ? (
        <>
          <span className="text-[17px] font-semibold leading-none tabular-nums">
            {date.getUTCDate()}
          </span>
          <span
            className="mt-0.5 text-[10px] leading-none"
            style={{
              color: selected ? 'var(--accent-text)' : 'var(--text-tertiary)',
              opacity: selected ? 0.75 : 1,
            }}
          >
            {MONTHS[date.getUTCMonth()]}
          </span>
        </>
      ) : (
        <span className="text-[10px] leading-none" aria-hidden>
          {weekdayLabel}
        </span>
      )}
    </button>
  );
}

/* ── лента дней ───────────────────────────────────────────────────────── */

export interface DayPagerProps {
  /** Дни текущей недели, попавшие в выгрузку. */
  days: ApiScheduleDay[];
  /** Выбранный день внутри days. */
  index: number;
  onIndexChange: (index: number) => void;
  className?: string;
  pageClassName?: string;
  /**
   * Растёт, когда экран сам просит показать выбранный день (кнопка «К сегодня»).
   * По этому сигналу активная страница прокручивается к началу — смена дня
   * свайпом по-прежнему сохраняет позицию скролла, как в списках писем.
   */
  revealSignal?: number;
  /**
   * Уведомляет о DOM-узле активной страницы.
   *
   * Нужен pull-to-refresh: прокручивается не экран, а страница дня, и жесту
   * требуется именно её scrollTop. Уведомление приходит не на каждой
   * перерисовке, а только когда страница действительно сменилась (index/count).
   */
  onActiveNode?: (node: HTMLDivElement | null) => void;
  /** Содержимое дня. Вызывается для всех дней недели. */
  children: (day: ApiScheduleDay) => ReactNode;
}

/**
 * Лента пар: карусель дней текущей недели.
 *
 * Каждый день — отдельная прокручиваемая страница. Так высота ленты не
 * зависит от содержимого соседних дней: у короткого дня под лентой не остаётся
 * пустой «тени» от чужих карточек, и пересчитывать высоту ленты при
 * раскрытии домашнего задания больше не нужно.
 *
 * Прокрутка каждого дня своя, поэтому у скролла есть минус: вернувшись на день,
 * человек оказывается там, где остановился. Это плюс — как в списках писем.
 */
export function DayPager({
  days,
  index,
  onIndexChange,
  className,
  pageClassName,
  revealSignal,
  onActiveNode,
  children,
}: DayPagerProps) {
  /** Узлы страниц по индексу: нужны, чтобы прокрутить активный день к началу. */
  const pageNodes = useRef<(HTMLDivElement | null)[]>([]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const revealMountedRef = useRef(false);

  /**
   * Подписчик на активный узел — через ref: сам колбэк приходит из страницы на
   * каждом рендере, а эффект ниже обязан зависеть только от index/count.
   */
  const onActiveNodeRef = useRef(onActiveNode);
  onActiveNodeRef.current = onActiveNode;

  useEffect(() => {
    onActiveNodeRef.current?.(pageNodes.current[indexRef.current] ?? null);
  }, [index, days.length]);

  useEffect(() => {
    // Первый прогон — монтирование: прокручивать нечего и не от чего.
    if (!revealMountedRef.current) {
      revealMountedRef.current = true;
      return;
    }
    if (revealSignal === undefined) return;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    pageNodes.current[indexRef.current]?.scrollTo({
      top: 0,
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [revealSignal]);

  return (
    <SwipePager
      count={days.length}
      index={index}
      onIndexChange={onIndexChange}
      thresholdPx={DAY_THRESHOLD_PX}
      className={className}
      // touch-pan-y дублирует намерение явно: вертикальный скролл — браузеру,
      // горизонталь забирает пейджер (см. Pager.tsx).
      pageClassName={`scroll-hidden touch-pan-y overflow-y-auto overscroll-contain ${pageClassName ?? ''}`}
      pageRef={(pageIndex, node) => {
        pageNodes.current[pageIndex] = node;
      }}
    >
      {(pageIndex) => children(days[pageIndex])}
    </SwipePager>
  );
}

