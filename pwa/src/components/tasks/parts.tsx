/**
 * Презентационные части экрана «Задания»: заголовок секции, карточки ДЗ и
 * «Важного», подтверждение удаления и тост.
 *
 * Вынесены из TasksPage, чтобы страница отвечала за данные и действия, а
 * разметка карточек жила отдельно. Состояния у них нет — всё через пропсы.
 */

import { useEffect, type ReactNode } from 'react';
import { ChevronRight, Paperclip, Pencil, Trash2 } from 'lucide-react';

import { KindBadge } from '@/components/ui';
import { formatCreatedAt, formatTargetDate, plural } from '@/lib/dates';
import { haptic } from '@/lib/env';
import type { ApiHomework, ApiImportant } from '@/types/api';

export type TaskRecord = ApiHomework | ApiImportant;

/** Заголовок секции с иконкой и количеством. */
export function SectionHeader({
  icon,
  title,
  count,
}: {
  icon: ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span style={{ color: 'var(--text-tertiary)' }} aria-hidden>
        {icon}
      </span>
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-secondary)]">
        {title}
      </h2>
      {count > 0 ? (
        <span className="text-[13px] text-[var(--text-tertiary)]">{count}</span>
      ) : null}
    </div>
  );
}

/**
 * Плашка ДЗ.
 *
 * Кликабельна целиком: карточка обёрнута в `<div>` с ролью кнопки, а не в
 * `<button>`, потому что внутри есть собственные кнопки «Изменить» и «Удалить»,
 * а кнопка внутри кнопки в HTML невалидна и в Safari ломает разметку.
 */
export function HomeworkCard({
  item,
  onOpen,
  onEdit,
  onDelete,
}: {
  item: ApiHomework;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="surface pressable cursor-pointer px-4 py-3 active:pressable-active"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1 text-[15px] font-medium leading-snug">{item.discipline}</span>
        <KindBadge kind={item.kind} />
      </div>

      {item.text ? (
        <p className="mt-1 line-clamp-2 text-[14px] leading-relaxed whitespace-pre-wrap">{item.text}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--text-tertiary)]">
        <span>к {formatTargetDate(item.targetDate)}</span>
        {item.lessonNumber ? (
          <span>
            {item.lessonNumber} {plural(item.lessonNumber, 'пара', 'пары', 'пар')}
          </span>
        ) : null}
        {item.authorName ? <span>{item.authorName}</span> : null}
        <FilesBadge count={item.files.length} />
      </div>

      <CardActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

export function ImportantCard({
  item,
  onOpen,
  onEdit,
  onDelete,
}: {
  item: ApiImportant;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="surface pressable cursor-pointer px-4 py-3 active:pressable-active"
    >
      <span className="block text-[15px] font-medium leading-snug">{item.title}</span>

      {item.text ? (
        <p className="mt-1 line-clamp-2 text-[14px] leading-relaxed whitespace-pre-wrap">{item.text}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--text-tertiary)]">
        <span>{formatCreatedAt(item.createdAt)}</span>
        {item.authorName ? <span>{item.authorName}</span> : null}
        <FilesBadge count={item.files.length} />
      </div>

      <CardActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

/** Иконка скрепки с числом файлов. Без числа иконка читалась бы как декорация. */
function FilesBadge({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <span className="inline-flex items-center gap-1">
      <Paperclip size={11} aria-hidden />
      {count}
    </span>
  );
}

/**
 * Кнопки действий на плашке.
 *
 * `stopPropagation` обязателен: плашка кликабельна целиком, и без остановки
 * тап по «Удалить» открывал бы детальный экран вместо удаления.
 */
function CardActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          haptic('light');
          onEdit();
        }}
        className="pressable flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium active:pressable-active"
        style={{ color: 'var(--accent)' }}
      >
        <Pencil size={13} aria-hidden />
        Изменить
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          haptic('light');
          onDelete();
        }}
        className="pressable flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium active:pressable-active"
        style={{ color: 'var(--danger)' }}
      >
        <Trash2 size={13} aria-hidden />
        Удалить
      </button>

      <ChevronRight size={15} className="ml-0.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
    </div>
  );
}

/** Подпись записи в подтверждении удаления. */
export function describeRecord(record: TaskRecord): string {
  return 'discipline' in record
    ? `${record.discipline} — ${formatTargetDate(record.targetDate)}`
    : record.title;
}

/** Подтверждение удаления — как в iOS, отдельным листом. */
export function ConfirmSheet({
  title,
  subtitle,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  subtitle: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onCancel}
        className="animate-fade absolute inset-0 bg-black/40"
      />

      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="animate-rise relative w-full max-w-[300px] rounded-[20px] px-5 py-5 text-center"
        style={{ background: 'var(--surface-grouped)' }}
      >
        <h3 className="text-[17px] font-semibold">{title}</h3>
        {subtitle ? (
          <p className="mt-1 line-clamp-2 text-[13px] text-[var(--text-secondary)]">{subtitle}</p>
        ) : null}

        <div className="mt-4 flex flex-col gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              haptic('medium');
              onConfirm();
            }}
            className="pressable w-full rounded-[12px] py-2.5 text-[16px] font-semibold active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--danger)', color: '#fff' }}
          >
            {busy ? 'Удаляем…' : 'Удалить'}
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="pressable w-full rounded-[12px] py-2.5 text-[16px] font-semibold active:pressable-active"
            style={{ background: 'var(--surface)', color: 'var(--accent)' }}
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

/** Всплывающее сообщение об ошибке поверх ленты. */
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
