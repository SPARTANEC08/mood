import { useEffect, useRef, type ReactNode } from 'react';

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
  /** Отключить тактильный отклик (для навигационных переходов внутри карточки). */
  silent?: boolean;
}

export function Card({ children, onPress, className, silent }: CardProps) {
  const surfaceClass = cn('surface overflow-hidden', className);

  if (!onPress) {
    return <div className={surfaceClass}>{children}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!silent) haptic('light');
        onPress();
      }}
      className={cn(surfaceClass, 'pressable w-full text-left active:pressable-active')}
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
}) {
  // Скролл фона блокируется, пока лист открыт, иначе жест прокрутки уезжает
  // на подложку под листом.
  const scrollLocked = useRef(false);

  useEffect(() => {
    if (!open) return;

    if (!scrollLocked.current) {
      document.body.style.overflow = 'hidden';
      scrollLocked.current = true;
    }

    return () => {
      document.body.style.overflow = '';
      scrollLocked.current = false;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={() => {
          haptic('light');
          onClose();
        }}
        className="animate-fade absolute inset-0 bg-black/35"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-sheet relative w-full max-w-[560px] rounded-t-[24px] pb-[calc(24px+env(safe-area-inset-bottom))] max-h-[88dvh] overflow-y-auto"
        style={{ background: 'var(--surface)' }}
      >
        {/* «Ручка» — признак листа, который тянут вниз */}
        <div className="sticky top-0 z-10 flex flex-col items-center pt-2.5 pb-1" style={{ background: 'var(--surface)' }}>
          <div className="h-1 w-9 rounded-full" style={{ background: 'var(--separator)' }} />
        </div>

        <div className="flex items-center justify-between px-5 pb-1">
          <button
            type="button"
            onClick={onClose}
            className="pressable text-[17px] active:pressable-active"
            style={{ color: 'var(--accent)' }}
          >
            Отмена
          </button>
          <h3 className="text-[17px] font-semibold">{title}</h3>
          <span className="w-[52px]" />
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