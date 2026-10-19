/**
 * Pull-to-refresh: потянуть ленту вниз, когда она в самом верху.
 *
 * Используется на «Расписании» (лента пар внутри карусели дней), а также на
 * «Заданиях», «Успеваемости» и в «Кабинете» — там роль узла играет единственный
 * скролл-контейнер страницы (его отдаёт Page).
 *
 * ── Почему жест навешен на сам прокручиваемый узел ─────────────────────────
 *
 * Слушатели вешаются на узел, который отдаёт вызывающий экран. Тогда «в самом
 * верху» — это ровно `node.scrollTop === 0`, без догадок про ближайший
 * прокручиваемый родитель.
 *
 * ── Почему это не ломает свайпы недель и дней ───────────────────────────────
 *
 * Жест забирает себе только вертикальное движение ВНИЗ при scrollTop === 0:
 *
 * - пока палец не ушёл на SLOP_PX, ничего не происходит;
 * - если смещение вбок больше вертикального — это свайп карусели расписания, и
 *   мы сразу отпускаем жест (SwipePager работает на pointer-событиях и не
 *   конфликтует);
 * - preventDefault зовётся лишь когда жест уже наш, поэтому нативная прокрутка
 *   ленты вверх остаётся браузеру.
 *
 * Нативная «резинка» iOS гасится тем же preventDefault, а на прокручиваемых
 * узлах уже стоит `overscroll-contain`, так что двойного отскока нет.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'framer-motion';
import { ArrowDown, LoaderCircle } from 'lucide-react';

import { haptic } from '@/lib/env';

/** Порог, после которого отпускание запускает обновление. */
export const REFRESH_THRESHOLD_PX = 88;

/** Дальше этого лента не идёт: жест упирается в «резинку». */
const MAX_PULL_PX = 132;

/** Сопротивление: палец проходит вдвое больше, чем едет лента. */
const RESISTANCE = 0.55;

/** Насколько лента остаётся сдвинутой, пока идёт обновление. */
const REFRESHING_OFFSET_PX = 56;

/**
 * Высота индикатора вместе с верхним отступом (mt-2 + h-9).
 *
 * Из неё считается позиция: кружок центрируется в ОТКРЫТОЙ жестом полосе, чтобы
 * целиком в неё влезать. Раньше он ехал ровно вдвое от ленты (y = pull/2) и на
 * рабочей высоте (56 px) нижним краем залезал на первую карточку — на «Кабинете»
 * это выглядело как кружок поверх блока пользователя.
 */
const INDICATOR_BOX_PX = 44;

/**
 * Сколько верхний индикатор молчит после жеста.
 *
 * Обновление, запущенное пальцем, уже показано спиннером жеста: если в это же
 * время в фоне шёл ещё какой-то запрос (заход на вкладку по TTL, возврат в
 * приложение), верхний индикатор включался следом и читался как его дубль.
 */
const BACKGROUND_SILENCE_MS = 1500;

/** До этого смещения жест «не выбран»: ни направление, ни владелец неясны. */
const SLOP_PX = 10;

/** Пружина довода и возврата ленты. */
const PULL_SPRING = { type: 'spring', stiffness: 420, damping: 38, mass: 0.8 } as const;

/** Сколько минимум держим спиннер, чтобы на быстром ответе он не мигнул. */
const MIN_SPINNER_MS = 400;

export type PullStatus = 'idle' | 'pulling' | 'armed' | 'refreshing';

export interface PullToRefreshHandle {
  /** Подписаться на узел активной прокручиваемой страницы. */
  attach: (node: HTMLDivElement | null) => void;
  /** На сколько сдвинуть ленту (px). Пишется в transform, без ререндера. */
  pullY: MotionValue<number>;
  /** 0…1 — прогресс до порога: для масштаба и прозрачности индикатора. */
  progress: MotionValue<number>;
  /** Фаза жеста: idle → pulling → armed → refreshing → idle. */
  status: PullStatus;
  /**
   * Идёт жест или он только что закончился.
   *
   * Верхний индикатор фонового обновления обязан в это время молчать: свои
   * обновления человек уже видит спиннером жеста, и второй кружок в шапке
   * читается как его копия.
   */
  suppressBackground: boolean;
}

interface DragState {
  active: boolean;
  pulling: boolean;
  startX: number;
  startY: number;
  armedHaptic: boolean;
}

function idleDrag(): DragState {
  return { active: false, pulling: false, startX: 0, startY: 0, armedHaptic: false };
}

/**
 * @param onRefresh Обновление данных. Промис нужен, чтобы спиннер жил ровно
 *   столько, сколько идёт запрос; отклонение не роняет жест (тост показывает
 *   вызывающий код).
 */
export function usePullToRefresh({
  enabled,
  onRefresh,
}: {
  enabled: boolean;
  onRefresh: () => Promise<unknown>;
}): PullToRefreshHandle {
  const pullY = useMotionValue(0);
  const progress = useMotionValue(0);
  const [status, setStatus] = useState<PullStatus>('idle');
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  // Колбэки и фаза читаются из ref: слушатели навешиваются один раз на узел и не
  // должны пересобираться на каждый ререндер страницы.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const statusRef = useRef<PullStatus>(status);
  statusRef.current = status;

  const dragRef = useRef<DragState>(idleDrag());

  /** Пауза после жеста: пока она идёт, верхний индикатор не показывается. */
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimerRef = useRef<number | null>(null);

  const startCooldown = useCallback(() => {
    setCooldown(true);
    if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setTimeout(() => {
      cooldownTimerRef.current = null;
      setCooldown(false);
    }, BACKGROUND_SILENCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
    },
    [],
  );

  /**
   * Подписка на узел активной страницы.
   *
   * setNode с тем же значением React отбрасывает, поэтому повторные вызовы из
   * DayPager (перерисовка карусели — это в том числе повторный вызов ref-колбэков)
   * не приводят к лишним циклам.
   */
  const attach = useCallback((next: HTMLDivElement | null) => {
    setNode((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    if (!node) return;

    /** Возврат ленты на место: с анимацией или мгновенно (сброс без жеста). */
    const settle = (animateBack: boolean) => {
      progress.set(0);
      if (animateBack) animate(pullY, 0, PULL_SPRING);
      else pullY.set(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      dragRef.current = idleDrag();

      if (!enabledRef.current) return;
      if (statusRef.current === 'refreshing') return;
      // Мультитач (щипок) и уже прокрученная лента — не наш жест.
      if (event.touches.length !== 1) return;
      if (node.scrollTop > 0) return;

      dragRef.current.active = true;
      dragRef.current.startX = event.touches[0].clientX;
      dragRef.current.startY = event.touches[0].clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag.active || event.touches.length !== 1) return;

      const dy = event.touches[0].clientY - drag.startY;

      // Лента ушла из верха или палец пошёл вверх: жест больше не наш, ленту
      // отпускаем обратно и отдаём прокрутку браузеру.
      if (dy <= 0 || node.scrollTop > 0) {
        if (drag.pulling) {
          drag.pulling = false;
          setStatus('idle');
          settle(true);
        }
        if (node.scrollTop > 0) drag.active = false;
        return;
      }

      if (!drag.pulling) {
        const dx = Math.abs(event.touches[0].clientX - drag.startX);
        // Ждём, пока направление определится: короткое дрожание не считается.
        if (dy < SLOP_PX) return;
        // Смещение вбок больше — это свайп дней/недель, а не наше обновление.
        if (dx > dy) {
          drag.active = false;
          return;
        }
      }

      drag.pulling = true;
      // Только теперь: пока жест не подтверждён, нативную прокрутку не трогаем.
      if (event.cancelable) event.preventDefault();

      const pull = Math.min(MAX_PULL_PX, dy * RESISTANCE);
      pullY.set(pull);
      progress.set(Math.min(1, pull / REFRESH_THRESHOLD_PX));

      const armed = pull >= REFRESH_THRESHOLD_PX;
      if (armed && !drag.armedHaptic) {
        drag.armedHaptic = true;
        haptic('light');
      } else if (!armed) {
        drag.armedHaptic = false;
      }

      setStatus(armed ? 'armed' : 'pulling');
    };

    const finish = (shouldRefresh: boolean) => {
      const drag = dragRef.current;
      if (!drag.active) return;

      const pulling = drag.pulling;
      dragRef.current = idleDrag();

      if (!shouldRefresh || !pulling) {
        setStatus('idle');
        settle(true);
        startCooldown();
        return;
      }

      setStatus('refreshing');
      animate(pullY, REFRESHING_OFFSET_PX, PULL_SPRING);

      const startedAt = Date.now();
      void Promise.resolve(onRefreshRef.current())
        .catch(() => undefined)
        .then(() => {
          const left = Math.max(0, MIN_SPINNER_MS - (Date.now() - startedAt));
          window.setTimeout(() => {
            setStatus('idle');
            settle(true);
            // Пауза стартует ПОСЛЕ спиннера жеста: иначе фоновый индикатор
            // успел бы включиться ровно в момент, когда первый гаснет.
            startCooldown();
          }, left);
        });
    };

    const onTouchEnd = () => finish(pullY.get() >= REFRESH_THRESHOLD_PX);
    const onTouchCancel = () => finish(false);

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    // passive: false обязателен: из touchmove нужен preventDefault, иначе
    // вместе с нашей лентой поедет нативная «резинка» iOS.
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd);
    node.addEventListener('touchcancel', onTouchCancel);

    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchCancel);
      // Сменился день (или экран закрылся): незавершённый жест сбрасываем, но
      // уже запущенное обновление не трогаем — его спиннер вернётся сам.
      if (dragRef.current.pulling) settle(false);
      dragRef.current = idleDrag();
    };
  }, [node, progress, pullY, startCooldown]);

  return {
    attach,
    pullY,
    progress,
    status,
    suppressBackground: status !== 'idle' || cooldown,
  };
}

/**
 * Кружок с индикатором поверх ленты.
 *
 * Держится на motion-value, а не на состоянии: палец двигается чаще, чем
 * рисуется кадр, и ререндер страницы на каждое движение был бы лишним.
 */
export function PullIndicator({
  pullY,
  progress,
  status,
  label = 'Обновление данных',
}: {
  pullY: MotionValue<number>;
  progress: MotionValue<number>;
  status: PullStatus;
  /** Что объявить скринридеру, пока идёт обновление. */
  label?: string;
}) {
  const y = useTransform(pullY, (value) => Math.max(0, (value - INDICATOR_BOX_PX) / 2));
  const opacity = useTransform(progress, [0, 0.15, 1], [0, 0.35, 1]);
  const scale = useTransform(progress, [0, 1], [0.7, 1]);
  const rotate = useTransform(progress, [0, 1], [0, 180]);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
      >
        <motion.div
          style={{
            y,
            opacity,
            scale,
            background: 'var(--surface)',
            borderColor: 'var(--separator-soft)',
            color: 'var(--accent)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.16)',
          }}
          className="mt-2 flex h-9 w-9 items-center justify-center rounded-full border"
        >
          {status === 'refreshing' ? (
            <LoaderCircle size={18} className="spinner" />
          ) : (
            // Стрелка разворачивается по мере натяжения: на пороге смотрит вверх,
            // то есть «отпускай».
            <motion.span className="flex" style={{ rotate }}>
              <ArrowDown size={18} />
            </motion.span>
          )}
        </motion.div>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {status === 'refreshing' ? label : ''}
      </span>
    </>
  );
}
