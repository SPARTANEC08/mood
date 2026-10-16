/**
 * Карточка пары и карточка перерыва для ленты расписания.
 *
 * Презентационные компоненты без собственного состояния и запросов: всё
 * приходит пропами, обработчики поднимаются на страницу. Вынесены из
 * SchedulePage, чтобы страница не разрасталась разметкой карточки.
 */

import { ChevronRight, MapPin, StickyNote, User } from 'lucide-react';

import { FileAttachmentList } from '@/components/FileAttachmentList';
import { Card, KindBadge, Row } from '@/components/ui';
import { plural } from '@/lib/dates';
import { shortKindLabel } from '@/lib/format';
import type { ApiHomework, ApiLessonSlot } from '@/types/api';
import { truncatePreview } from './helpers';

/** Карточка одной пары. */
export function LessonCard({
  slot,
  expanded,
  onToggleHomework,
  onOpenSubject,
  homeworkById,
}: {
  slot: ApiLessonSlot;
  expanded: Set<string>;
  onToggleHomework: (id: string) => void;
  onOpenSubject: (discipline: string) => void;
  /** Полные записи ДЗ — нужны ради вложений, которых нет в метаданных пары. */
  homeworkById: Map<string, ApiHomework>;
}) {
  const variant = slot.variants[0];
  const extraCount = slot.variants.length - 1;

  if (!variant) {
    return (
      <Card className="px-4 py-3">
        <p className="text-[15px] font-medium">Занятие</p>
      </Card>
    );
  }

  return (
    <Card>
      {/* Время и номер пары — вторичный слой, как в iOS-карточках событий */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        {/* Номер пары залит акцентом: раньше он был того же синего, что и
            бейдж «Практика», и визуально сливался с ним. */}
        <span
          className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
          style={{ background: 'var(--lesson-chip)', color: 'var(--lesson-chip-text)' }}
        >
          {slot.lessonNumber} пара
        </span>
        <span className="text-[13px] tabular-nums text-[var(--text-secondary)]">
          {slot.timeStart} — {slot.timeEnd}
        </span>
      </div>

      <Row flush>
        <div className="px-4 pb-3">
          {/* Название кликабельно: тап открывает предмет — его пары, ДЗ и итог. */}
          <div className="mb-1 flex items-start justify-between gap-2">
            <button
              type="button"
              onClick={() => onOpenSubject(variant.discipline)}
              className="pressable flex-1 text-left active:pressable-active"
            >
              <h3 className="text-[16px] font-semibold leading-snug">{variant.discipline}</h3>
            </button>
            <KindBadge kind={variant.kind} label={shortKindLabel(variant.kindOfWork)} />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--text-secondary)]">
            {variant.auditorium ? (
              <span className="inline-flex items-center gap-1">
                <MapPin size={13} aria-hidden />
                {variant.auditorium}
                {variant.building ? `, ${variant.building}` : ''}
              </span>
            ) : null}

            {variant.lecturerShort ? (
              <span className="inline-flex items-center gap-1">
                <User size={13} aria-hidden />
                {variant.lecturerShort}
              </span>
            ) : null}
          </div>

          {/* Пара по подгруппам: показываем, что вариантов больше одного */}
          {extraCount > 0 ? (
            <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">
              {extraCount} {plural(extraCount, 'подгруппа', 'подгруппы', 'подгрупп')} по вариантам
            </p>
          ) : null}

          {variant.note ? (
            <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--warning)' }}>
              {variant.note}
            </p>
          ) : null}
        </div>
      </Row>

      {/* Привязанное ДЗ */}
      {slot.homework.length > 0 ? (
        slot.homework.map((hw) => {
          const isOpen = expanded.has(hw.id);
          // Полная запись появляется после того, как список ДЗ подгрузился.
          const fullHomework = homeworkById.get(hw.id);

          return (
            <div key={hw.id} className="border-t border-[var(--separator-soft)]">
              <button
                type="button"
                onClick={() => onToggleHomework(hw.id)}
                className="pressable flex w-full items-center gap-2 px-4 py-2.5 text-left active:pressable-active"
              >
                <StickyNote size={15} style={{ color: 'var(--accent)' }} aria-hidden />
                <span className="flex-1 text-[14px] font-medium">
                  {hw.text ? truncatePreview(hw.text) : 'Домашнее задание'}
                </span>
                {hw.fileCount > 0 ? (
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    📎 {hw.fileCount}
                  </span>
                ) : null}
                <ChevronRight
                  size={15}
                  aria-hidden
                  className="shrink-0 transition-transform duration-200"
                  style={{
                    color: 'var(--text-tertiary)',
                    transform: isOpen ? 'rotate(90deg)' : 'none',
                  }}
                />
              </button>

              {isOpen ? (
                <div className="animate-fade px-4 pb-3 pl-11">
                  <p className="text-[14px] leading-relaxed whitespace-pre-wrap">
                    {hw.text || 'Задание — в прикреплённых файлах бота.'}
                  </p>
                  {hw.authorName ? (
                    <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
                      Добавил: {hw.authorName}
                    </p>
                  ) : null}

                  {/* Вложения показываются здесь же, а не только на экране
                      предмета: на расписании человек обычно и узнаёт, что
                      задание вообще выложили. Любой файл открывается
                      просмотрщиком внутри приложения. */}
                  {fullHomework && fullHomework.files.length > 0 ? (
                    <div className="mt-2.5">
                      <FileAttachmentList files={fullHomework.files} />
                    </div>
                  ) : hw.fileCount > 0 ? (
                    <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
                      Файлы загружаются…
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      ) : null}
    </Card>
  );
}

/** Карточка перерыва между парами. */
export function LunchBreak({ from, to }: { from: string; to: string }) {
  return (
    <div
      // pb-3 вместо pb-2: перерыв отделяется от следующей за ним карточки пары,
      // потому что он живёт внутри того же wrapper-<div>, и общий gap родителя
      // на него не действует. Без явного отступа «Перерыв» слипался с карточкой.
      className="flex items-center gap-3 px-4 pb-3 pt-1.5"
      aria-label="Перерыв"
    >
      <span className="text-[13px] tabular-nums text-[var(--text-tertiary)]">
        {from} — {to}
      </span>
      <div className="flex-1 h-px" style={{ background: 'var(--separator-soft)' }} />
      <span className="text-[13px] text-[var(--text-secondary)]">Перерыв</span>
    </div>
  );
}
