/**
 * Карточка пары и карточка перерыва для ленты расписания.
 *
 * Данные и обработчики приходят пропами, запросов внутри нет. Единственное
 * собственное состояние — выбранный вариант пары по подгруппам: какой из них
 * смотреть, знает только человек. Вынесены из SchedulePage, чтобы страница не
 * разрасталась разметкой карточки.
 */

import { memo, useState, type MouseEvent } from 'react';

import { ChevronRight, MapPin, StickyNote, User } from 'lucide-react';

import { FileAttachmentList } from '@/components/FileAttachmentList';
import { Card, KindBadge, Row } from '@/components/ui';
import { shortKindLabel } from '@/lib/format';
import type { ApiHomework, ApiLessonSlot, ApiLessonVariant } from '@/types/api';
import { truncatePreview } from './helpers';

/**
 * Подпись варианта на чипе.
 *
 * `subgroup` приходит из МЭИ строкой вида «ИЭ-43-26\2п.». Показывать её целиком
 * в чипе бессмысленно: номер группы повторяется в шапке расписания. Достаём
 * номер подгруппы, а если его в строке нет — нумеруем варианты по порядку.
 */
function variantLabel(subgroup: string | undefined, index: number): string {
  const match = subgroup ? /(\d+)\s*п\.?\s*$/i.exec(subgroup.trim()) : null;
  return match ? `${match[1]} п.` : `Вариант ${index + 1}`;
}

/** Чип варианта: обычная button, поэтому клик по нему не открывает предмет. */
function VariantChip({
  variant,
  index,
  active,
  onSelect,
}: {
  variant: ApiLessonVariant;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className="pressable rounded-full px-2 py-0.5 text-[12px] font-semibold active:pressable-active"
      style={{
        background: active ? 'var(--accent)' : 'var(--accent-soft)',
        color: active ? '#fff' : 'var(--accent)',
      }}
    >
      {variantLabel(variant.subgroup, index)}
    </button>
  );
}

/**
 * Вложенные интерактивные элементы карточки.
 *
 * Клик по ним не должен открывать предмет: у них своё действие (раскрыть ДЗ,
 * открыть файл, перейти по внешней ссылке). Проверяем по target, а не
 * stopPropagation на каждом элементе: так новая кнопка внутри карточки не
 * «выстрелит» переходом по недосмотру.
 */
const NESTED_INTERACTIVE = 'a[href], button, input, textarea, select, [role="button"]';

interface LessonCardProps {
  slot: ApiLessonSlot;
  expanded: Set<string>;
  onToggleHomework: (id: string) => void;
  onOpenSubject: (discipline: string) => void;
  /** Полные записи ДЗ — нужны ради вложений, которых нет в метаданных пары. */
  homeworkById: Map<string, ApiHomework>;
  /** Идёт ли эта пара прямо сейчас (только для сегодняшнего дня). */
  isNow?: boolean;
  /** Сколько минут осталось до конца текущей пары. */
  minutesLeft?: number;
}

/**
 * Карточка одной пары.
 *
 * Обёрнута в memo (см. areLessonCardPropsEqual): страница дней смонтирована
 * целиком, и без этого раскрытие одного задания перерисовывало все карточки
 * всех семи дней, включая невидимые.
 */
export const LessonCard = memo(function LessonCard({
  slot,
  expanded,
  onToggleHomework,
  onOpenSubject,
  homeworkById,
  isNow = false,
  minutesLeft = 0,
}: LessonCardProps) {
  /**
   * Вариант пары, который показан.
   *
   * Пара по подгруппам приходит несколькими вариантами (у 1-й и 2-й подгруппы
   * разные преподаватели, аудитории, а иногда и предметы). Раньше карточка
   * всегда брала первый вариант — и вторая подгруппа видела чужого
   * преподавателя, а при разных дисциплинах ещё и чужой предмет. Теперь
   * варианты переключаются чипами; по умолчанию первый, как и раньше.
   *
   * Состояние локальное и переживает обновление расписания: индекс
   * подрезается, если вариантов стало меньше.
   */
  const [variantIndex, setVariantIndex] = useState(0);
  const activeIndex = slot.variants[variantIndex] ? variantIndex : 0;
  const variant = slot.variants[activeIndex];
  const extraCount = slot.variants.length - 1;
  /** Варианты пришли как подгруппы или как просто разные записи одной пары. */
  const bySubgroups = slot.variants.some((item) => Boolean(item.subgroup));

  if (!variant) {
    return (
      <Card className="px-4 py-3">
        <p className="text-[15px] font-medium">Занятие</p>
      </Card>
    );
  }

  /**
   * Активация карточки: вся площадь ведёт на предмет, кроме вложенных
   * интерактивных элементов (клик по кнопке/ссылке внутри обрабатывается ею).
   */
  const activate = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null;
    const nested = target?.closest(NESTED_INTERACTIVE);
    if (nested && nested !== event.currentTarget) return;
    onOpenSubject(variant.discipline);
  };

  return (
    // Вся карточка — одна зона нажатия, но БЕЗ role="button": внутри есть
    // собственные кнопки и ссылки, а вложенные интерактивные элементы внутри
    // role="button" — невалидная ARIA-композиция (скринридер путается, какая
    // кнопка «главная»). tabIndex + aria-label + Enter/Space дают тот же
    // доступный результат без ложной роли.
    <div
      tabIndex={0}
      aria-label={`Открыть предмет «${variant.discipline}»`}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Фокус на вложенной кнопке — её дело, не наше.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onOpenSubject(variant.discipline);
      }}
      className="cursor-pointer rounded-[var(--radius-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
    <Card
      style={
        isNow
          ? {
              // Обводка и свечение идут по скруглению карточки, без боковой
              // полосы: она ломала геометрию на rounded-углах.
              // Обводка — по контуру, а свечение — внутри фона: inset-тень
              // не выходит за карточку и не выглядит ореолом вокруг неё.
              background:
                'radial-gradient(130% 150% at 0% 50%, var(--accent-soft), var(--surface) 62%)',
              boxShadow:
                '0 0 0 1.5px var(--accent), inset 0 0 30px rgba(139, 92, 246, 0.24)',
            }
          : undefined
      }
    >
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
        {isNow ? (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Сейчас
          </span>
        ) : null}
        {/* Бейдж типа пары живёт в строке времени, то есть НАД серой линией
            (верхняя граница Row). Раньше он стоял под линией рядом с названием
            предмета и читался как часть названия, а не как метка типа занятия. */}
        <span className="ml-auto shrink-0">
          <KindBadge kind={variant.kind} label={shortKindLabel(variant.kindOfWork)} />
        </span>
      </div>

      <Row flush>
        <div className="px-4 pb-3">
          {/* Название кликабельно: тап открывает предмет — его пары, ДЗ и итог. */}
          <div className="mb-1">
            <button
              type="button"
              onClick={() => onOpenSubject(variant.discipline)}
              className="pressable w-full text-left active:pressable-active"
            >
              <h3 className="text-[16px] font-semibold leading-snug">{variant.discipline}</h3>
            </button>
            {isNow ? (
              <p className="mt-1 text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                до конца {Math.max(1, minutesLeft)} мин
              </p>
            ) : null}
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

          {/* Пара по подгруппам: переключение вариантов. Раньше здесь была
              строка «N подгруппы по вариантам», но посмотреть второй вариант
              было нельзя — показывался всегда первый. */}
          {extraCount > 0 ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Варианты занятия по подгруппам"
            >
              <span className="text-[12px] text-[var(--text-tertiary)]">
                {bySubgroups ? 'Подгруппа:' : 'Вариант:'}
              </span>
              {slot.variants.map((item, index) => (
                <VariantChip
                  key={`${item.subgroup ?? 'variant'}-${index}`}
                  variant={item}
                  index={index}
                  active={index === activeIndex}
                  onSelect={() => setVariantIndex(index)}
                />
              ))}
            </div>
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
    </div>
  );
}, areLessonCardPropsEqual);

/**
 * Сравнение пропсов карточки.
 *
 * Раскрытие задания меняет Set раскрытых на всей странице, то есть по ссылке
 * «изменились» все карточки — и перерисовывались все семь страниц дней.
 * Сравниваем только те id, что приклеены к ЭТОЙ паре: отметка чужого задания
 * карточку не касается. Остальные пропсы — по ссылке: slot приходит из данных
 * расписания, homeworkById меняется при обновлении списка ДЗ (тогда перерисовка
 * обязательна — именно так появляются вложения), оба колбэка стабильны.
 */
function areLessonCardPropsEqual(prev: LessonCardProps, next: LessonCardProps): boolean {
  if (
    prev.slot !== next.slot ||
    prev.homeworkById !== next.homeworkById ||
    prev.onToggleHomework !== next.onToggleHomework ||
    prev.onOpenSubject !== next.onOpenSubject ||
    prev.isNow !== next.isNow ||
    prev.minutesLeft !== next.minutesLeft
  ) {
    return false;
  }

  return expandedOf(next.slot, prev.expanded) === expandedOf(next.slot, next.expanded);
}

/** Отпечаток раскрытых заданий пары: «1» — раскрыто, «0» — нет. */
function expandedOf(slot: ApiLessonSlot, expanded: Set<string>): string {
  return slot.homework.map((hw) => (expanded.has(hw.id) ? '1' : '0')).join('');
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
