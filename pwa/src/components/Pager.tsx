import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { haptic } from '@/lib/env';

/**
 * Постраничный свайп: лента едет за пальцем и защёлкивается на соседней
 * странице целиком.
 *
 * Механика взята из прототипа расписания (pwa/test.tsx) и отличается от
 * прежней реализации листания расписания принципиально:
 *
 * - смонтированы ВСЕ страницы сразу, а не «текущая плюс два соседа»;
 *   соседей приходилось держать в absolutely-позиционированных слоях и
 *   отдельно анимировать высоту ленты под текущий день, иначе под коротким
 *   днём оставалась пустая «тень» от чужих карточек. Здесь у каждой страницы
 *   своя прокрутка, поэтому высота ленты равна высоте окна и ничего не зависит
 *   от содержимого соседей;
 * - страница смещается на ШИРИНУ ЦЕЛОМ (`translateX(-index * 100%)`), то есть
 *   это пейджер, а не «резинка с подсказкой», как было раньше: палец тянет
 *   настоящую следующую страницу, а не её край;
 * - защёлкивание задаётся CSS-переходом с одним и тем же ease для всех
 *   страниц, поэтому дни и недели защёлкиваются одинаково;
 * - у краёв ленты сопротивление: страниц дальше нет, и тянуть некуда, но
 *   полоса всё равно слегка идёт за пальцем — так жест читается как граница,
 *   а не как залипание;
 * - жест по горизонтали наш, вертикальная прокрутка остаётся за страницей
 *   (touch-action: pan-y), поэтому список пар по-прежнему листается вверх.
 *
 * Чего здесь сознательно нет: инерции после отпускания. На iOS она добавляла
 * лишние 100–150 мс, и страница успевала доехать не туда.
 */

/** Насколько лента идёт за пальцем на краях, где страниц дальше нет. */
const EDGE_RESISTANCE = 0.25;

/**
 * Порог защёлкивания: доля ширины окна плюс нижняя граница в пикселях.
 *
 * Доля нужна, чтобы жест одинаково читался на любом экране, а нижняя граница
 * — чтобы на узком экране несколько пикселей случайного дрожания не
 * переключали день. Скорость в расчёт не входит намеренно: на iOS короткое
 * движение при попытке прокрутить список даёт ложные срабатывания.
 */
const DEFAULT_THRESHOLD_RATIO = 0.18;
const DEFAULT_THRESHOLD_PX = 56;

/**
 * Ease защёлкивания.
 *
 * Один и тот же для дней и недель: страницы одинаковые, и разный ease читался
 * бы как разное качество элементов.
 */
const SNAP_TRANSITION = 'transform 0.34s cubic-bezier(0.25, 1, 0.5, 1)';

/** Уважаем системную настройку «уменьшить движение»: страница меняется сразу. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface SwipePagerProps {
  /** Сколько страниц в ленте. */
  count: number;
  /** Активная страница. */
  index: number;
  /** Защёлкивание дошло до соседней страницы. */
  onIndexChange: (index: number) => void;
  /**
   * Можно ли листать в сторону.
   *
   * Отдельные флаги нужны не всегда: страниц может быть 7, а доступно 4, и
   * сопротивление должно появляться на фактическом краю доступного диапазона,
   * а не на краю ленты.
   */
  canPrev?: boolean;
  canNext?: boolean;
  /** Доля ширины окна, которую нужно преодолеть для переключения страницы. */
  thresholdRatio?: number;
  /** Нижняя граница порога в пикселях. */
  thresholdPx?: number;
  /** Классы корня: размеры, скругление, отступы. */
  className?: string;
  /** Классы прокручиваемой области страницы. */
  pageClassName?: string;
  /** Содержимое страницы по индексу. Вызывается для всех смонтированных. */
  children: (index: number) => ReactNode;
}

export function SwipePager({
  count,
  index,
  onIndexChange,
  canPrev = true,
  canNext = true,
  thresholdRatio = DEFAULT_THRESHOLD_RATIO,
  thresholdPx = DEFAULT_THRESHOLD_PX,
  className,
  pageClassName,
  children,
}: SwipePagerProps) {
  const [dragging, setDraggingState] = useState(false);

  /**
   * Жест держится в ref, а не в React-состоянии.
   *
   * Комментарий про замыкания остаётся в силе, но главное здесь другое: offset
   * НЕ должен быть состоянием. setState на каждом pointermove перерисовывал бы
   * весь трек — все страницы карусели — каждый кадр жеста. Офсет живёт в ref, а
   * transform пишется в DOM императивно; реактивное состояние меняется только на
   * входе и выходе из жеста (переключение курсора и will-change).
   */
  const offsetRef = useRef(0);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const movedRef = useRef(0);
  const widthRef = useRef(0);
  /** DOM-узел трека: transform пишется напрямую, минуя ререндер. */
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** Запланированный кадр записи transform — батчит частые pointermove. */
  const rafRef = useRef<number | null>(null);

  /** Актуальный индекс для обработчиков указателя. */
  const indexRef = useRef(index);
  indexRef.current = index;

  /**
   * Пишет позицию трека в DOM. offset — сдвиг в пикселях, animate — включать ли
   * CSS-переход защёлкивания. Вызывается только вне рендера (жест и layout-эффект).
   */
  const writeTransform = useCallback((offsetPx: number, animate: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = animate && !prefersReducedMotion() ? SNAP_TRANSITION : 'none';
    el.style.transform = `translateX(calc(${-indexRef.current * 100}% + ${offsetPx}px))`;
  }, []);

  /**
   * Смена индекса извне (тап по полосе, кнопка в шапке) или приход нового
   * индекса ПОСЛЕ жеста — трек встаёт на страницу с анимацией защёлкивания.
   * Во время жеста не мешаем: позицию пишет pointermove.
   *
   * ПЕРВАЯ установка позиции и смена числа страниц — БЕЗ анимации. На монтировании
   * трек ещё стоит на нулевой странице, и анимировать от неё к, скажем, третьей
   * неделе — это и был «контент приезжает слева сам по себе» при каждом входе и
   * переключении вкладки. Когда приходит расписание, count меняется с 0 на N —
   * тут анимация тоже была бы ложной. Анимируем только смену индекса при уже
   * установленном count, то есть реальный жест или тап.
   */
  const positionedRef = useRef(false);
  const countRef = useRef(count);

  useLayoutEffect(() => {
    if (draggingRef.current) return;

    const countChanged = countRef.current !== count;
    const instant = !positionedRef.current || countChanged;

    writeTransform(0, !instant);

    positionedRef.current = true;
    countRef.current = count;
  }, [index, count, writeTransform]);

  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Жест не начинается, если страница всего одна: тянуть некуда, а эластичность
    // без цели движения читается как «прилипание».
    if (count <= 1 || (index === 0 && !canPrev) || (index === count - 1 && !canNext)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    startXRef.current = event.clientX;
    movedRef.current = 0;
    widthRef.current = event.currentTarget.getBoundingClientRect().width;
    offsetRef.current = 0;
    cancelRaf();

    draggingRef.current = true;
    // Переход выключается сразу: до первого pointermove трек должен стоять ровно
    // на текущей странице, без анимации из прошлого положения.
    writeTransform(0, false);
    setDraggingState(true);

    // Захват указателя на самом контейнере, а не на event.target: под пальцем
    // может оказаться карточка пары, и без захвата жест рассыпался бы на
    // обработчики разных элементов при выходе за их границы.
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;

    const diff = event.clientX - startXRef.current;
    movedRef.current = diff;

    const atStart = indexRef.current === 0 || !canPrev;
    const atEnd = indexRef.current === count - 1 || !canNext;

    // На краях доступного диапазона лента идёт за пальцем вчетверо медленнее.
    offsetRef.current =
      (atStart && diff > 0) || (atEnd && diff < 0) ? diff * EDGE_RESISTANCE : diff;

    // Запись в DOM батчится по кадру: pointermove приходит чаще, чем рисуется
    // кадр, и без rAF мы бы писали transform вхолостую.
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        writeTransform(offsetRef.current, false);
      });
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;

    cancelRaf();
    draggingRef.current = false;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const diff = movedRef.current;
    const width = widthRef.current || 1;
    const threshold = Math.max(thresholdPx, width * thresholdRatio);
    const current = indexRef.current;

    let target = current;
    if (diff <= -threshold && canNext && current < count - 1) {
      target = current + 1;
    } else if (diff >= threshold && canPrev && current > 0) {
      target = current - 1;
    }

    offsetRef.current = 0;
    setDraggingState(false);

    if (target !== current) {
      haptic('light');
      // Новый index придёт пропом; useLayoutEffect поставит трек на него с
      // анимацией — досчитывать позицию вручную не нужно.
      onIndexChange(target);
    } else {
      // Индекс не меняется, React трек не перерисует — возвращаем на место сами.
      writeTransform(0, true);
    }
  }

  if (count <= 0) return null;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`touch-pan-y select-none overflow-hidden ${className ?? ''}`}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
      <div
        ref={trackRef}
        className="flex h-full"
        // transform и transition пишутся императивно (writeTransform): React их
        // не трогает, иначе ререндер сбрасывал бы позицию жеста. willChange
        // включается только на время жеста — постоянный композитный слой на
        // большом треке держал бы лишнюю память весь сеанс.
        style={{ willChange: dragging ? 'transform' : 'auto' }}
      >
        {Array.from({ length: count }, (_, pageIndex) => (
          <div key={pageIndex} className={`h-full w-full shrink-0 ${pageClassName ?? ''}`}>
            {children(pageIndex)}
          </div>
        ))}
      </div>
    </div>
  );
}
