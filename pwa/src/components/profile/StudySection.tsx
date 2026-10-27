/**
 * Раскрывающийся раздел учёбы в «Кабинете».
 *
 * Один и тот же паттерн для стипендий, приказов и библиотеки: в свёрнутом виде
 * видно только название и счётчик, в развёрнутом — все данные из БАРС. Так
 * кабинет не превращается в простыню, но ничего не теряет.
 */

import { useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { haptic } from '@/lib/env';

export function StudySection({
  icon: Icon,
  title,
  subtitle,
  badge,
  defaultOpen = false,
  tone = 'accent',
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  tone?: 'accent' | 'success' | 'warning';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const iconStyle =
    tone === 'success'
      ? { background: 'rgba(52, 199, 89, 0.12)', color: 'var(--success)' }
      : tone === 'warning'
        ? { background: 'rgba(255, 149, 0, 0.12)', color: 'var(--warning)' }
        : { background: 'var(--accent-soft)', color: 'var(--accent)' };

  return (
    <div
      className="overflow-hidden rounded-[20px] border"
      style={{ background: 'var(--surface)', borderColor: 'var(--separator-soft)' }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((value) => !value);
        }}
        className="pressable flex w-full items-center gap-3 px-4 py-3.5 text-left active:pressable-active"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={iconStyle}
          aria-hidden
        >
          <Icon size={18} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-snug">{title}</span>
          <span
            className="mt-0.5 block text-[12px] leading-snug"
            style={{ color: 'var(--text-secondary)' }}
          >
            {subtitle}
          </span>
        </span>

        {badge}
        <ChevronRight
          size={18}
          className={cn('shrink-0 transition-transform duration-200', open && 'rotate-90')}
          style={{ color: 'var(--text-tertiary)' }}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          className="border-t px-4 pb-3.5 pl-[60px] pt-1"
          style={{ borderColor: 'var(--separator-soft)' }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Строка внутри раскрытого раздела. */
export function StudyLine({ children }: { children: ReactNode }) {
  return (
    <div
      className="border-t py-2.5 first:border-t-0 first:pt-0"
      style={{ borderColor: 'var(--separator-soft)' }}
    >
      {children}
    </div>
  );
}
