/**
 * Общий вид одного уведомления.
 *
 * Используется и модалкой нового события, и лентой центра уведомлений. Иконка,
 * заголовок, время и строки деталей должны выглядеть одинаково: человек видит
 * одно и то же событие в двух местах и не должен гадать, почему они разные.
 */

import {
  ExternalLink,
  FileText,
  GraduationCap,
  Mail,
  Megaphone,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import { formatMoscowTime } from '@/lib/dates';
import { openLink } from '@/lib/env';
import { OSEP_MAIL_URL } from '@/lib/links';
import type { AppNotification, AppNotificationKind } from '@/types/api';

const KIND_META: Record<AppNotificationKind, { icon: LucideIcon; title: string }> = {
  grade: { icon: GraduationCap, title: 'Новые оценки' },
  mail: { icon: Mail, title: 'Новое письмо' },
  order: { icon: FileText, title: 'Новый приказ' },
  scholarship: { icon: Wallet, title: 'Стипендия' },
  broadcast: { icon: Megaphone, title: 'Объявление' },
};

/** Заголовок события: серверный label, иначе запасной по типу. */
export function notificationTitle(item: AppNotification): string {
  return item.label ?? KIND_META[item.kind].title;
}

export function NotificationContent({ item }: { item: AppNotification }) {
  const details = item.details ?? [];
  const isBroadcast = item.kind === 'broadcast';
  const Icon = KIND_META[item.kind].icon;

  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        aria-hidden
      >
        <Icon size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-[14px] font-semibold leading-snug">
            {notificationTitle(item)}
          </h3>
          <span
            className="shrink-0 text-[11px] leading-snug"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {formatMoscowTime(item.createdAt)}
          </span>
        </div>

        {isBroadcast ? (
          <p
            className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {item.text}
          </p>
        ) : details.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {details.map((line, index) => (
              <li
                key={`${index}-${line}`}
                className="whitespace-pre-wrap break-words text-[13px] leading-relaxed"
                style={{ color: 'var(--text-secondary)' }}
              >
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Действие под уведомлением.
 *
 * Пока есть только у почты: содержимое письма в приложении не показывается,
 * поэтому единственное осмысленное действие — открыть ОСЭП.
 */
export function NotificationActions({ item }: { item: AppNotification }) {
  if (item.kind !== 'mail') return null;

  return (
    <button
      type="button"
      onClick={() => openLink(OSEP_MAIL_URL)}
      className="pressable mt-2 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold active:pressable-active"
      style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
    >
      Открыть ОСЭП
      <ExternalLink size={14} aria-hidden />
    </button>
  );
}
