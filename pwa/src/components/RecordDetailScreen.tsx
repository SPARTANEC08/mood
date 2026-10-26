import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';

import { FileAttachmentList } from '@/components/FileAttachmentList';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { KindBadge } from '@/components/ui';
import { formatCreatedAt, formatTargetDate, plural } from '@/lib/dates';
import { haptic } from '@/lib/env';
import type { ApiHomework, ApiImportant } from '@/types/api';

/**
 * Детальный экран одной записи.
 *
 * Отдельный экран, а не раскрытая плашка: в списке важен срез — что свежего и по
 * какому предмету, а здесь важен текст целиком и файлы. На мобильном экране
 * оба вида не помещаются одновременно, и попытка показать полный текст в
 * плашке превращала список в простыню.
 *
 * Плашка и этот экран показывают один и тот же объект из кэша, поэтому запись
 * не перезапрашивается: кнопки «Изменить» и «Удалить» меняют её в том же
 * хранилище, и `reloadLists()` обновляет оба экрана сразу.
 */

export function RecordDetailScreen({
  record,
  onBack,
  onEdit,
  onDelete,
}: {
  record: ApiHomework | ApiImportant;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isHomework = 'discipline' in record;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]" style={{ background: 'var(--app-bg)' }}>
        <div className="mx-auto flex max-w-[560px] items-center gap-2">
          <button
            type="button"
            aria-label="Назад"
            onClick={() => {
              haptic('light');
              onBack();
            }}
            className="pressable -ml-1 rounded-full p-1.5 active:pressable-active"
            style={{ color: 'var(--accent)' }}
          >
            <ArrowLeft size={22} aria-hidden />
          </button>

          <span className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            {isHomework ? record.discipline : record.title}
          </span>

          {/* Правка и удаление — только у своих записей (canEdit считает сервер). */}
          {record.canEdit ? (
            <>
              <button
                type="button"
                aria-label="Изменить"
                onClick={() => {
                  haptic('light');
                  onEdit();
                }}
                className="pressable rounded-full p-1.5 active:pressable-active"
                style={{ color: 'var(--accent)' }}
              >
                <Pencil size={19} aria-hidden />
              </button>

              <button
                type="button"
                aria-label="Удалить"
                onClick={() => {
                  haptic('light');
                  onDelete();
                }}
                className="pressable rounded-full p-1.5 active:pressable-active"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={19} aria-hidden />
              </button>
            </>
          ) : null}

          <NotificationBell />
        </div>
      </header>

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-4 px-4 pt-2 pb-8">
          {/*
            Предмет НЕ дублируется: он уже в заголовке экрана. Здесь только то,
            чего в шапке нет, — тип занятия и когда сдавать.
          */}
          <div className="flex flex-wrap items-center gap-2">
            {isHomework ? (
              <>
                <KindBadge kind={record.kind} />
                <span className="text-[13px] text-[var(--text-tertiary)]">
                  к {formatTargetDate(record.targetDate)}
                  {record.lessonNumber
                    ? `, ${record.lessonNumber} ${plural(record.lessonNumber, 'пара', 'пары', 'пар')}`
                    : ''}
                  {record.timeStart ? `, ${record.timeStart}` : ''}
                </span>
              </>
            ) : (
              <span className="text-[13px] text-[var(--text-tertiary)]">
                {formatCreatedAt(record.createdAt, true)}
              </span>
            )}
          </div>

          {record.text ? (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{record.text}</p>
          ) : (
            <p className="text-[14px] text-[var(--text-tertiary)]">Текста нет — только файлы.</p>
          )}

          {record.authorName ? (
            <p className="text-[13px] text-[var(--text-tertiary)]">Добавил: {record.authorName}</p>
          ) : null}

          {record.files.length > 0 ? (
            <section className="space-y-2 pt-1">
              <h2 className="text-[13px] font-medium text-[var(--text-secondary)]">
                Файлы ({record.files.length})
              </h2>

              <FileAttachmentList files={record.files} />
            </section>
          ) : null}

          {/* Кнопки внизу дублируют те, что в шапке: на длинном тексте шапка
              уходит за верх экрана, а человеку нужно и дойти до удаления.
              У чужой записи кнопок нет, но текст прямо говорит, почему. */}
          {record.canEdit ? (
            <div className="flex gap-2 pt-4">
              <button
                type="button"
                onClick={() => {
                  haptic('light');
                  onEdit();
                }}
                className="pressable flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border px-4 py-2.5 text-[14px] font-semibold active:pressable-active"
                style={{ borderColor: 'var(--separator-soft)', color: 'var(--accent)' }}
              >
                <Pencil size={15} aria-hidden />
                Изменить
              </button>

              <button
                type="button"
                onClick={() => {
                  haptic('light');
                  onDelete();
                }}
                className="pressable flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-white active:pressable-active"
                style={{ background: 'var(--danger)' }}
              >
                <Trash2 size={15} aria-hidden />
                Удалить
              </button>
            </div>
          ) : (
            <p className="pt-4 text-[13px] text-[var(--text-tertiary)]">
              Изменить или удалить запись может только её автор.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}


