/**
 * Общий вид одного уведомления.
 *
 * Используется и модалкой нового события, и лентой центра уведомлений. Иконка,
 * заголовок, время и строки деталей должны выглядеть одинаково: человек видит
 * одно и то же событие в двух местах и не должен гадать, почему они разные.
 *
 * Новые события приходят со структурой (`data`) и рисуются карточками: чип КМ,
 * крупный балл, цветная дельта. Старые записи без структуры показываются
 * текстовыми строками — история не должна «пропадать» после обновления.
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

import { formatMoscowTime, plural } from '@/lib/dates';
import { openLink } from '@/lib/env';
import { OSEP_MAIL_URL } from '@/lib/links';
import type {
  AppNotification,
  AppNotificationData,
  AppNotificationGradeItem,
  AppNotificationKind,
} from '@/types/api';

const KIND_META: Record<
  AppNotificationKind,
  { icon: LucideIcon; title: string; color: string; soft: string }
> = {
  grade: {
    icon: GraduationCap,
    title: 'Новые оценки',
    color: 'var(--success)',
    soft: 'rgba(52, 199, 89, 0.12)',
  },
  mail: {
    icon: Mail,
    title: 'Новое письмо',
    color: 'var(--lecture)',
    soft: 'var(--lecture-bg)',
  },
  order: {
    icon: FileText,
    title: 'Новый приказ',
    color: 'var(--accent)',
    soft: 'var(--accent-soft)',
  },
  scholarship: {
    icon: Wallet,
    title: 'Стипендия',
    color: 'var(--lab)',
    soft: 'var(--lab-bg)',
  },
  broadcast: {
    icon: Megaphone,
    title: 'Объявление',
    color: 'var(--warning)',
    soft: 'rgba(255, 149, 0, 0.12)',
  },
};

/** Заголовок события: серверный label, иначе запасной по типу. */
export function notificationTitle(item: AppNotification): string {
  return item.label ?? KIND_META[item.kind].title;
}

/** Акцентный цвет типа — для полоски карточки в ленте. */
export function notificationAccent(kind: AppNotificationKind): string {
  return KIND_META[kind].color;
}

export function NotificationContent({ item }: { item: AppNotification }) {
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;
  const data = item.data;

  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: meta.soft, color: meta.color }}
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

        {item.kind === 'broadcast' ? (
          <p
            className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {item.text}
          </p>
        ) : data ? (
          <StructuredDetails data={data} />
        ) : (
          <FallbackDetails details={item.details} />
        )}
      </div>
    </div>
  );
}

/** Карточки по структуре; каждая ветка — свой тип события. */
function StructuredDetails({ data }: { data: AppNotificationData }) {
  switch (data.type) {
    case 'grade':
      return <GradeDetails items={data.items} />;
    case 'mail':
      return <MailDetails count={data.count} />;
    case 'order':
      return <OrderDetails items={data.items} />;
    case 'scholarship':
      return (
        <ScholarshipDetails
          appointed={data.appointed}
          scholarshipType={data.scholarshipType}
          period={data.period}
          amount={data.amount}
        />
      );
    default:
      return null;
  }
}

/** Несколько КМ из одного круга — одна карточка со списком. */
function GradeDetails({ items }: { items: AppNotificationGradeItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {items.map((item, index) => (
        <div
          key={`${item.discipline}-${item.point}-${index}`}
          className="rounded-[12px] px-2.5 py-2"
          style={{ background: 'var(--surface-grouped)' }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13px] font-medium leading-snug">
                {item.discipline}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
                КМ {item.point}
                {item.title ? ` · ${item.title}` : ''}
                {typeof item.weight === 'number' ? ` · ${item.weight}%` : ''}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[17px] font-semibold leading-none tabular-nums">
                {formatScore(item.score)}
              </span>
              {item.delta !== null && item.delta !== 0 ? (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums"
                  style={{
                    background: item.delta > 0 ? 'rgba(52, 199, 89, 0.14)' : 'rgba(255, 59, 48, 0.12)',
                    color: item.delta > 0 ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {formatDelta(item.delta)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MailDetails({ count }: { count: number }) {
  return (
    <div className="mt-2">
      <div
        className="flex items-center gap-3 rounded-[12px] px-3 py-2.5"
        style={{ background: 'var(--lecture-bg)' }}
      >
        <span
          className="text-[24px] font-semibold leading-none tabular-nums"
          style={{ color: 'var(--lecture)' }}
        >
          {count > 0 ? count : '1'}
        </span>
        <span className="text-[13px] leading-snug text-[var(--text-secondary)]">
          {count > 0
            ? plural(count, 'новое письмо', 'новых письма', 'новых писем')
            : 'новое письмо'}
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
        Темы и содержимое писем в приложение не передаются.
      </p>
    </div>
  );
}

function OrderDetails({
  items,
}: {
  items: Array<{ number?: string; date?: string; title: string }>;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {items.map((order, index) => (
        <div
          key={`${order.number ?? ''}-${order.date ?? ''}-${index}`}
          className="rounded-[12px] px-2.5 py-2"
          style={{ background: 'var(--surface-grouped)' }}
        >
          <p className="break-words text-[13px] leading-snug">{order.title}</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            {[order.number ? `№ ${order.number}` : '', order.date ?? '']
              .filter(Boolean)
              .join(' · ') || 'Без номера и даты'}
          </p>
        </div>
      ))}
    </div>
  );
}

function ScholarshipDetails({
  appointed,
  scholarshipType,
  period,
  amount,
}: {
  appointed: boolean;
  scholarshipType?: string;
  period?: string;
  amount?: string;
}) {
  const rows = [scholarshipType, period, amount].filter(Boolean);

  return (
    <div className="mt-2">
      <span
        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{
          background: appointed ? 'rgba(52, 199, 89, 0.14)' : 'rgba(255, 59, 48, 0.12)',
          color: appointed ? 'var(--success)' : 'var(--danger)',
        }}
      >
        {appointed ? 'Назначена' : 'Отменена'}
      </span>

      {rows.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {rows.map((row) => (
            <li
              key={row}
              className="break-words text-[13px] leading-snug text-[var(--text-secondary)]"
            >
              {row}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Старые уведомления: строки из базы, без структуры. */
function FallbackDetails({ details }: { details?: string[] }) {
  if (!details || details.length === 0) return null;

  return (
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
  );
}

/** Балл без хвостового нуля: 4, 4,5. */
function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Math.round(value * 100) / 100).replace('.', ',');
}

/** Дельта со знаком: +5, −0,5. */
function formatDelta(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatScore(value)}`;
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
