import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { haptic } from '@/lib/env';

/**
 * Карточка-поверхность.
 *
 * Нажатие обрабатывается только если передан onPress: без него карточка
 * остаётся неинтерактивной, чтобы не создавать ложные ощущения кликабельности.
 */
interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  className?: string;
  /** Инлайновые стили — например, акцентная рамка текущей пары. */
  style?: CSSProperties;
  /** Отключить тактильный отклик (для навигационных переходов внутри карточки). */
  silent?: boolean;
}

export function Card({ children, onPress, className, style, silent }: CardProps) {
  const surfaceClass = cn('surface overflow-hidden', className);

  if (!onPress) {
    return (
      <div className={surfaceClass} style={style}>
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!silent) haptic('light');
        onPress();
      }}
      className={cn(surfaceClass, 'pressable w-full text-left active:pressable-active')}
      style={style}
    >
      {children}
    </button>
  );
}

/**
 * Строка списка в стиле iOS.
 *
 * Разделитель начинается с отступа слева (16px), как в системных списках iOS:
 * текст и разделитель выровнены, а не начинаются от края карточки.
 */
interface RowProps {
  children: ReactNode;
  onPress?: () => void;
  className?: string;
  /** Убрать внутренние отступы — для вложенных блоков. */
  flush?: boolean;
}

export function Row({ children, onPress, className, flush }: RowProps) {
  const content = <div className={cn(!flush && 'px-4 py-3')}>{children}</div>;

  if (!onPress) {
    return <div className={cn('border-t border-[var(--separator-soft)] first:border-t-0', className)}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        onPress();
      }}
      className={cn(
        'pressable w-full text-left border-t border-[var(--separator-soft)] first:border-t-0',
        !flush && 'px-4 py-3',
        'active:pressable-active',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Заголовок секции: мелкий капитель серым, как в iOS. */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-1 mb-2 mt-6">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {title}
      </h2>
      {action}
    </div>
  );
}

/** Бейдж типа занятия. Цвета приглушены, как в системных компонентах. */
export function KindBadge({ kind, label }: { kind: 'lecture' | 'practice' | 'lab'; label?: string }) {
  const config = {
    lecture: { bg: 'var(--lecture-bg)', fg: 'var(--lecture)', text: 'Лекция' },
    practice: { bg: 'var(--practice-bg)', fg: 'var(--practice)', text: 'Практика' },
    lab: { bg: 'var(--lab-bg)', fg: 'var(--lab)', text: 'Лаб' },
  }[kind];

  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ background: config.bg, color: config.fg }}
    >
      {label ?? config.text}
    </span>
  );
}

/** Пустое состояние: иконка, заголовок, пояснение. */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-8 text-center">
      {icon ? (
        <div className="mb-3 text-[var(--text-tertiary)]" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="text-[15px] font-medium text-[var(--text-secondary)]">{title}</p>
      {description ? (
        <p className="mt-1 text-[13px] text-[var(--text-tertiary)] leading-relaxed">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * Скелет загрузки.
 *
 * Ставится на место будущего контента, пока идёт запрос: страница не остаётся
 * пустой, а пользователь видит структуру. Форма скелетов повторяет реальные
 * карточки — при загрузке лента не «прыгает».
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

/** Скелет карточки-поверхности: используется списками. */
export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="surface px-4 py-3.5">
      <Skeleton className="h-4 w-2/5" />
      <div className="mt-2 space-y-1.5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn('h-3', i === 0 ? 'w-full' : 'w-4/5')} />
        ))}
      </div>
      <div className="mt-2.5 flex gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}

/** Список скелетов на месте будущих строк. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2.5" role="status" aria-label="Загрузка" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={i % 2 === 0 ? 2 : 1} />
      ))}
    </div>
  );
}

/** Скелет пары в расписании. */
export function SkeletonLesson() {
  return (
    <div className="surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-16 rounded-md" />
        <Skeleton className="h-3.5 w-28" />
      </div>
      <Skeleton className="mt-2.5 h-4 w-3/5" />
      <div className="mt-2 flex gap-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

/**
 * Экран ошибки с кнопкой повтора.
 *
 * Текст ошибки берётся из ApiError.message и уже безопасен: сервер не
 * отдаёт наружу внутренние адреса и стеки.
 */
export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Повторить',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-8 text-center gap-3">
      <p className="text-[15px] font-medium text-[var(--text-secondary)]">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            onRetry();
          }}
          className="pressable mt-1 rounded-full px-5 py-2 text-[15px] font-medium text-[var(--accent)] active:pressable-active"
          style={{ background: 'var(--accent-soft)' }}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Группа списка с заголовком-заглушкой.
 * Разделители между строками — с отступом, как в системных списках.
 */
export function ListGroup({ children }: { children: ReactNode }) {
  return <div className="surface overflow-hidden">{children}</div>;
}

/**
 * Кнопка с тактильным откликом средней силы.
 * Средняя сила — для действий, меняющих данные (сохранить, отправить).
 */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  loading,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={() => {
        haptic('medium');
        onClick();
      }}
      className={cn(
        'pressable w-full rounded-[14px] py-3 text-[17px] font-semibold',
        'disabled:opacity-40',
        className ?? 'bg-[var(--accent)] text-white',
        !disabled && !loading && 'active:pressable-active',
      )}
    >
      {loading ? 'Отправка…' : children}
    </button>
  );
}

/**
 * Всплывающее сообщение об ошибке поверх ленты.
 *
 * Живёт в общей дизайн-системе, а не рядом с экраном «Задания»: тост нужен и
 * расписанию (ошибка жеста обновления), и «Успеваемости», и «Кабинету».
 */
export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [text, onClose]);

  return (
    <div
      role="alert"
      className="animate-fade fixed inset-x-4 z-50 mx-auto max-w-[400px] rounded-[14px] px-4 py-3 text-center text-[14px] text-white"
      style={{
        background: 'var(--danger)',
        bottom: 'calc(var(--tabbar-height) + var(--tabbar-gap) + 12px)',
      }}
      onClick={onClose}
    >
      {text}
    </div>
  );
}

/**
 * Модальный лист снизу (iOS Bottom Sheet).
 *
 * Реализация на голом портaле с блокировкой прокрутки фона: нативный
 * <dialog> в Safari/Telegram ведёт себя по-разному, поэтому своя реализация
 * надёжнее. Анимация — только появление; закрытие мгновенное, чтобы не
 * задерживать пользователя.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  closeLabel = 'Отмена',
  headerRight,
  height,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /**
   * Закреплённая внизу кнопка действия.
   *
   * Отдельная зона, а не часть children: у формы с файлами содержимое растёт
   * ниже первого экрана, и кнопка «Добавить», уехавшая под край, означала бы
   * прокрутку листа вслепую ради единственного действия.
   */
  footer?: ReactNode;
  /** Надпись левой кнопки. По умолчанию «Отмена» — как у форм. */
  closeLabel?: string;
  /** Действие справа в заголовке, например «Прочитать все». */
  headerRight?: ReactNode;
  /**
   * Фиксированная высота листа, например `min(720px, 85dvh)`.
   *
   * Нужна лентам с фильтрами: без неё лист сжимается под короткий список, и
   * переключение фильтра выглядит как прыжок всего окна. Формы высоту не
   * задают и остаются адаптивными.
   */
  height?: string;
  /**
   * Можно ли закрыть лист жестом, подложкой или кнопкой.
   *
   * false — на время необратимой операции: иначе запрос продолжится без
   * видимого результата, а лист останется за экраном с заблокированным фоном.
   */
  dismissible?: boolean;
}) {
  // Скролл фона блокируется, пока лист открыт, иначе жест прокрутки уезжает
  // на подложку под листом.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);

  // Родитель часто передаёт новую стрелку на каждый рендер. Через ref жест не
  // пересоздаётся посреди движения из-за обновления счётчика уведомлений.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /**
   * Жест «потянуть вниз», как у системных листов iOS.
   *
   * Работает только когда список уже в самом верху: иначе вертикальный свайп
   * должен прокручивать содержимое. Горизонтальный жест отдаётся фильтрам —
   * иначе нельзя было бы листать чипы. После порога лист уезжает вниз и
   * закрывается; до порога возвращается на место.
   */
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    dy: number;
    vertical: boolean | null;
  }>({ active: false, startX: 0, startY: 0, dy: 0, vertical: null });

  useEffect(() => {
    if (!open) return;

    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      enteredRef.current = false;
      return;
    }

    const sheet = sheetRef.current;
    if (sheet) {
      sheet.style.transition = '';
      sheet.style.transform = '';
    }
    if (backdropRef.current) backdropRef.current.style.opacity = '';

    // Класс анимации снимаем после её окончания: пока он висит, CSS-анимация
    // перебивает inline-transform, которым двигает жест.
    setEntered(false);
    enteredRef.current = false;
    const timer = window.setTimeout(() => {
      setEntered(true);
      enteredRef.current = true;
    }, 360);

    return () => {
      window.clearTimeout(timer);
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const sheet = sheetRef.current;
    if (!sheet) return;
    const backdrop = backdropRef.current;

    const resetDrag = (): void => {
      sheet.style.transition = 'transform 0.24s var(--ease-ios)';
      sheet.style.transform = 'translate3d(0, 0, 0)';
      if (backdrop) backdrop.style.opacity = '';
    };

    const onStart = (event: TouchEvent): void => {
      if (!dismissible || !enteredRef.current || sheet.scrollTop > 0) return;

      // Поля ввода не должны закрывать лист свайпом: там вертикальный жест —
      // это выделение текста или прокрутка внутри поля.
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

      const touch = event.touches[0];
      if (!touch) return;

      dragRef.current = {
        active: true,
        startX: touch.clientX,
        startY: touch.clientY,
        dy: 0,
        vertical: null,
      };
    };

    const onMove = (event: TouchEvent): void => {
      const drag = dragRef.current;
      if (!drag.active) return;

      const touch = event.touches[0];
      if (!touch) return;

      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      // Направление определяется один раз по первому заметному сдвигу.
      if (drag.vertical === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        drag.vertical = Math.abs(dy) >= Math.abs(dx);
        if (!drag.vertical) {
          drag.active = false;
          return;
        }
      }

      // Вверх — обычная прокрутка содержимого. Если до этого уже тянули вниз,
      // возвращаем лист на место плавно, а не рывком.
      if (dy <= 0) {
        if (drag.dy !== 0) resetDrag();
        drag.dy = 0;
        return;
      }

      if (sheet.scrollTop > 0) {
        drag.active = false;
        resetDrag();
        return;
      }

      event.preventDefault();
      drag.dy = dy;
      sheet.style.transition = 'none';
      sheet.style.transform = `translate3d(0, ${dy}px, 0)`;

      if (backdrop) {
        const heightPx = sheet.offsetHeight || 1;
        backdrop.style.opacity = String(Math.max(0.15, 1 - dy / (heightPx * 2)));
      }
    };

    const onEnd = (): void => {
      const drag = dragRef.current;
      if (!drag.active) return;
      drag.active = false;

      if (drag.dy <= 0) {
        drag.dy = 0;
        return;
      }

      const heightPx = sheet.offsetHeight || 1;
      const shouldClose = drag.dy > Math.min(140, heightPx * 0.22);
      drag.dy = 0;

      if (shouldClose) {
        sheet.style.transition = 'transform 0.2s var(--ease-ios)';
        sheet.style.transform = 'translate3d(0, 100%, 0)';
        if (backdrop) backdrop.style.opacity = '0';
        closeTimer.current = window.setTimeout(() => onCloseRef.current(), 180);
        return;
      }

      resetDrag();
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);

    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [open, dismissible]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        ref={backdropRef}
        type="button"
        aria-label="Закрыть"
        onClick={() => {
          if (!dismissible) return;
          haptic('light');
          onClose();
        }}
        className={cn('absolute inset-0 bg-black/35', entered ? '' : 'animate-fade')}
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative w-full max-w-[560px] rounded-t-[24px] pb-[calc(24px+env(safe-area-inset-bottom))] max-h-[88dvh] overflow-y-auto overscroll-contain',
          entered ? '' : 'animate-sheet',
        )}
        style={{
          background: 'var(--surface)',
          ...(height ? { height } : {}),
        }}
      >
        {/* «Ручка» — признак листа, который тянут вниз */}
        <div className="sticky top-0 z-10 flex flex-col items-center pt-2.5 pb-1" style={{ background: 'var(--surface)' }}>
          <div className="h-1 w-9 rounded-full" style={{ background: 'var(--separator)' }} />
        </div>

        {/*
          Три колонки одинаковой ширины: заголовок остаётся по центру, даже
          когда справа появляется «Прочитать все», а слева — «Закрыть».
          flex с пустым правым краем сдвигал бы заголовок влево.
        */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-5 pb-1">
          <button
            type="button"
            disabled={!dismissible}
            onClick={onClose}
            className="pressable justify-self-start text-[17px] active:pressable-active disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
          >
            {closeLabel}
          </button>
          <h3 className="min-w-0 max-w-[60vw] truncate text-center text-[17px] font-semibold">
            {title}
          </h3>
          <div className="flex items-center justify-end">{headerRight}</div>
        </div>

        <div className="px-5 pt-3">{children}</div>

        {/*
          Подвал закреплён на месте листа, а лента контента над ним прокручивается
          отдельно (max-h на родителе + overflow-y). Иначе кнопка уезжала бы
          вместе с содержимым и на длинной форме её просто не было бы видно.
        */}
        {footer ? (
          <div
            className="sticky bottom-0 z-10 mt-2 px-5 pt-2"
            style={{ background: 'var(--surface)' }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}