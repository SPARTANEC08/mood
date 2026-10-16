import { useMemo } from 'react';
import { ArrowLeft, MapPin, User } from 'lucide-react';

import { FileAttachmentList } from '@/components/FileAttachmentList';
import { Page } from '@/components/Page';
import { Card, KindBadge, SkeletonLesson } from '@/components/ui';
import { formatTargetDate, plural } from '@/lib/dates';
import { gradeColor, shortKindLabel } from '@/lib/format';
import { haptic } from '@/lib/env';
import type { ApiHomework, ApiLessonVariant, ApiScheduleDay, ApiSubjectGrade } from '@/types/api';

/**
 * Экран одного предмета: расписание его пар и домашние задания.
 *
 * Отдельный экран, а не разворот карточки в списке: здесь есть что показать
 * (все пары предмета за семестр, все ДЗ по нему), и в ленте это занимало бы
 * пол-экрана на каждый предмет.
 *
 * Оценки по предмету подгружаются отдельно и не блокируют показ расписания:
 * расписание приходит из кэша и видно сразу.
 */
export function SubjectScreen({
  discipline,
  days,
  homework,
  grade,
  isGradeLoading,
  onBack,
}: {
  discipline: string;
  days: ApiScheduleDay[];
  homework: ApiHomework[];
  grade: ApiSubjectGrade | null;
  isGradeLoading: boolean;
  onBack: () => void;
}) {
  /**
   * Пары предмета за весь доступный диапазон, а не только на выбранной неделе.
   * Предмет — это «всё, где он встречается», поэтому неделя тут лишняя.
   */
  const lessons = useMemo(() => {
    const found: Array<{ rawDate: string; slot: ApiScheduleDay['slots'][number]; variant: ApiLessonVariant }> = [];

    for (const day of days) {
      for (const slot of day.slots) {
        const variant = slot.variants.find((v) => v.discipline === discipline);
        if (variant) found.push({ rawDate: day.rawDate, slot, variant });
      }
    }

    return found.sort((a, b) => a.rawDate.localeCompare(b.rawDate));
  }, [days, discipline]);

  /** Ближайшие по времени 12 пар — остальное не нужно для «расписа предмета». */
  const upcoming = lessons.slice(0, 12);

  const subjectHomework = useMemo(
    () =>
      homework
        .filter((h) => h.discipline === discipline)
        .sort((a, b) => a.targetDate.localeCompare(b.targetDate)),
    [homework, discipline],
  );

  return (
    <Page
      header={
        // Шапка с кнопкой назад. Не sticky: прокручивается только лента под
        // ней, поэтому закреплять шапку незачем, а липкая шапка в WebKit —
        // источник полос и мигания при прокрутке.
        <header
          className="px-3 pb-3 pt-[max(12px,env(safe-area-inset-top))]"
          style={{ background: 'var(--app-bg)' }}
        >
          <div className="mx-auto flex max-w-[560px] items-center gap-1">
            <button
              type="button"
              aria-label="Назад"
              onClick={() => {
                haptic('light');
                onBack();
              }}
              className="pressable rounded-full p-2 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <ArrowLeft size={20} aria-hidden />
            </button>
  
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[17px] font-semibold tracking-tight">{discipline}</h1>
              {/* Показываем будущие пары, а не весь семестр: «19 пар» смущает,
                  ведь половина из них уже позади. */}
              <p className="truncate text-[12px] text-[var(--text-secondary)]">
                {upcoming.length > 0
                  ? `ближайшая ${formatTargetDate(upcoming[0].rawDate)} · ещё ${upcoming.length - 1} ${plural(upcoming.length - 1, 'пара', 'пары', 'пар')}`
                  : 'пар в расписании нет'}
                {subjectHomework.length > 0
                  ? ` · ${subjectHomework.length} ${plural(subjectHomework.length, 'задание', 'задания', 'заданий')}`
                  : ''}
              </p>
            </div>
          </div>
        </header>
      }
    >
      <div className="space-y-5">
        {/* Итог по предмету */}
        {isGradeLoading ? (
          <SkeletonLesson />
        ) : grade ? (
          <Card className="px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] text-[var(--text-secondary)]">Средний балл</p>
                <p className="mt-0.5 text-[32px] font-semibold leading-none tabular-nums">
                  {grade.currentAverage !== null
                    ? grade.currentAverage.toFixed(2).replace('.', ',')
                    : '—'}
                </p>
              </div>

              <div className="text-right">
                {grade.finalGrade ? (
                  <span
                    className="inline-block rounded-md px-2 py-1 text-[13px] font-semibold"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    {grade.finalGrade}
                  </span>
                ) : null}
                <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">
                  КМ {grade.gradedCount} из {grade.totalCount}
                </p>
                {/* Форма аттестации из ЛК — то, как будет сдаваться предмет */}
                {grade.attestation ? (
                  <p className="mt-0.5 text-[12px]" style={{ color: 'var(--accent)' }}>
                    {formatAttestation(grade.attestation)}
                  </p>
                ) : grade.controlType && grade.controlType !== 'Неизвестно' ? (
                  <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                    {grade.controlType}
                  </p>
                ) : null}
              </div>
            </div>

            {grade.totalWeight > 0 ? (
              <div className="mt-3 flex items-center gap-2">
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded-full"
                  style={{ background: 'var(--separator-soft)' }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min((grade.gradedWeight / grade.totalWeight) * 100, 100)}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>
                <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
                  {grade.gradedWeight}/{grade.totalWeight}%
                </span>
              </div>
            ) : null}

            {/* КМ списком: вес, неделя, балл */}
            {grade.controlPoints.length > 0 ? (
              <div className="mt-3 border-t border-[var(--separator-soft)] pt-2">
                {grade.controlPoints.map((point) => (
                  <div
                    key={point.number}
                    className="flex items-center gap-3 border-b border-[var(--separator-soft)] py-2 last:border-b-0"
                  >
                    <span className="w-9 shrink-0 text-[12px] font-medium text-[var(--text-tertiary)]">
                      КМ {point.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {point.title ?? 'Без названия'}
                    </span>
                    {typeof point.weight === 'number' ? (
                      <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                        {point.weight}%
                      </span>
                    ) : null}
                    <span
                      className="w-9 shrink-0 text-right text-[14px] font-semibold tabular-nums"
                      style={{
                        color: point.score !== null ? gradeColor(point.score) : 'var(--text-tertiary)',
                      }}
                    >
                      {point.score !== null ? point.score.toFixed(1).replace('.', ',') : '—'}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}

        {/* Домашние задания по предмету — сразу после оценок.
            Порядок не косметика: человек открывает предмет, чтобы понять одно из
            двух — что с оценкой или что задали. Задания стоят вторым блоком
            именно потому, что это второй частый вопрос; расписание предмета
            нужно реже, и оно уходит ниже. */}
        <section>
          <h2 className="mb-2 mt-6 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Домашние задания
          </h2>

          {subjectHomework.length === 0 ? (
            <Card className="px-4 py-4">
              <p className="text-[14px] text-[var(--text-secondary)]">
                По этому предмету заданий пока нет.
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {subjectHomework.map((item) => (
                <Card key={item.id} className="px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-[var(--text-secondary)]">
                      К {formatTargetDate(item.targetDate)}
                      {item.lessonNumber ? ` · ${item.lessonNumber} пара` : ''}
                    </span>
                    <KindBadge kind={item.kind} />
                  </div>

                  {item.text ? (
                    <p className="mt-1.5 text-[14px] leading-relaxed whitespace-pre-wrap">{item.text}</p>
                  ) : null}

                  {item.authorName ? (
                    <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">
                      {item.authorName}
                    </p>
                  ) : null}

                  {/* Файлы лежат на сервере приложения: любой файл открывается
                      просмотрщиком внутри приложения, у каждого есть явная
                      кнопка скачивания. */}
                  {item.files.length > 0 ? (
                    <div className="mt-2.5 border-t border-[var(--separator-soft)] pt-2.5">
                      <FileAttachmentList files={item.files} />
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Расписание предмета */}
        <section>
          <h2 className="mb-2 mt-6 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Расписание
          </h2>

          {upcoming.length === 0 ? (
            <Card className="px-4 py-4">
              <p className="text-[14px] text-[var(--text-secondary)]">
                Пары по этому предмету в загруженном диапазоне не найдены.
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {upcoming.map(({ rawDate, slot, variant }) => (
                <Card key={`${rawDate}-${slot.lessonNumber}`} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] tabular-nums text-[var(--text-secondary)]">
                        <span className="font-medium">{formatTargetDate(rawDate)}</span>
                        <span>·</span>
                        <span>
                          {slot.timeStart}—{slot.timeEnd}
                        </span>
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-secondary)]">
                        {variant.auditorium ? (
                          <span className="inline-flex items-center gap-1">
                            <MapPin size={12} aria-hidden />
                            {variant.auditorium}
                          </span>
                        ) : null}
                        {variant.lecturerShort ? (
                          <span className="inline-flex items-center gap-1">
                            <User size={12} aria-hidden />
                            {variant.lecturerShort}
                          </span>
                        ) : null}
                      </div>

                      {variant.note ? (
                        <p className="mt-1 text-[12px]" style={{ color: 'var(--warning)' }}>
                          {variant.note}
                        </p>
                      ) : null}
                    </div>

                    <KindBadge kind={variant.kind} label={shortKindLabel(variant.kindOfWork)} />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

/* ── вспомогательные функции ───────────────────────────────────────────── */

/**
 * Приводит текст аттестации к виду «Зачёт с оценкой».
 *
 * CSS capitalize не годится: он поднимает регистр каждого слова и ломает
 * кириллицу — «зачёт с оценкой» превращается в «Зачёт С Оценкой».
 */
function formatAttestation(raw: string): string {
  return raw.charAt(0).toLocaleUpperCase('ru') + raw.slice(1);
}
