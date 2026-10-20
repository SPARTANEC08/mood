import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { ChevronRight, Clock, Hash } from 'lucide-react';

import { Header } from '@/components/TabBar';
import { Page } from '@/components/Page';
import { Card, EmptyState, ListGroup, SkeletonCard, SkeletonLesson, Toast } from '@/components/ui';
import { RefreshIndicator } from '@/components/RefreshIndicator';
import { usePullToRefresh } from '@/components/PullToRefresh';
import { useAppData } from '@/lib/dataContext';
import { plural } from '@/lib/dates';
import { gradeColor } from '@/lib/format';
import { haptic } from '@/lib/env';
import type { ApiSubjectGrade } from '@/types/api';

/**
 * Экран успеваемости.
 *
 * Ключевые блоки:
 *  - задолженности (двойки за КМ) и закрытые КМ — двумя квадратами рядом;
 *  - внутривузовский рейтинг — вторым квадратом в той же строке;
 *  - полоса распределения оценок: пятёрки, четвёрки, тройки, двойки;
 *  - дисциплины с прогрессом закрытия КМ.
 *
 * Средний балл сознательно убран из верхнего блока: он уже виден в каждой
 * дисциплине, а место в шапке отдано тому, что важнее для контроля —
 * задолженностям.
 */
export function GradesPage() {
  const {
    barsMore: more,
    grades,
    attendance,
    barsRefreshing,
    barsError,
    refreshBars,
  } = useAppData();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  /**
   * Обновление по жесту: принудительный запрос снимка БАРС мимо TTL.
   *
   * Без force сервер отдал бы снимок двадцатиминутной давности, и жест выглядел
   * бы сломанным: спиннер прошёл, данные те же.
   */
  const pullRefresh = useCallback(async () => {
    const message = await refreshBars();
    if (message) setToast(message);
  }, [refreshBars]);

  const pull = usePullToRefresh({ enabled: true, onRefresh: pullRefresh });

  const toggle = (id: string) => {
    haptic('light');
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const academic = more?.academic ?? null;
  const debts = academic?.debts ?? 0;
  const closed = academic?.closed ?? 0;
  const totalKm = academic?.total ?? 0;
  const distribution = academic?.distribution ?? null;

  const comprehensive = more?.rating?.comprehensive ?? null;
  const ratingValue = comprehensive?.semester ?? comprehensive?.total ?? null;

  // Скелетон — пока данных этой вкладки ещё нет вообще. Условие не завязано на
  // barsLoading: фоновое обновление (§22.5) его не поднимает, а без данных всё
  // равно нельзя показывать «0 задолженностей» — это ложь до первого ответа.
  // Если пришли данные, скелетон уступает контенту; если ошибка — экрану ошибки.
  if (!grades && !barsError) {
    return (
      <Page header={<Header title="Успеваемость" large />}>
        <div className="space-y-4">
          <SkeletonLesson />
          <div className="grid grid-cols-2 gap-2.5">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
          </div>
          <SkeletonLesson />
          <SkeletonLesson />
        </div>
      </Page>
    );
  }

  if (barsError && !grades) {
    return (
      <Page header={<Header title="Успеваемость" large />}>
        <EmptyState title={barsError} description="Проверьте сессию БАРС и попробуйте ещё раз." />
      </Page>
    );
  }

  return (
    <>
    <Page
      header={
        <Header
          title="Успеваемость"
          large
          subtitle={grades?.semesterName}
          // Фоновое обновление (возврат в приложение после TTL) — единственная
          // обратная связь о том, что цифры перезапрашиваются.
          right={<RefreshIndicator active={barsRefreshing && !pull.suppressBackground} />}
        />
      }
      pull={pull}
    >
      <div className="space-y-3">
        {/* Два квадрата рядом: задолженности и рейтинг */}
        <div className="grid grid-cols-2 gap-2.5">
          <StatCard
            label="Задолженности"
            value={debts}
            hint={totalKm > 0 ? `КМ ${closed} из ${totalKm}` : 'нет КМ'}
            tone={debts > 0 ? 'danger' : 'accent'}
          />
          <StatCard
            label="Рейтинг"
            value={ratingValue}
            hint={more?.rating?.period ?? 'за семестр'}
            tone="accent"
            decimal
          />
        </div>

        {/* Пропуски отдельной строкой — он не влезает в пару с рейтингом,
            иначе подписи сжимаются в нечитаемую кашу. */}
        {attendance ? (
          <Card className="flex items-center justify-between px-4 py-3.5">
            <div>
              <p className="text-[13px] text-[var(--text-secondary)]">Пропущено пар</p>
              <p className="mt-0.5 text-[24px] font-semibold leading-none tabular-nums">
                {attendance.totalMissedLessons}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[12px] text-[var(--text-tertiary)]">
                {attendance.totalMissedHours} ч · уважительных {attendance.totalExcusedLessons}
              </p>
            </div>
          </Card>
        ) : null}

        {/* Распределение оценок вместо полосы причин пропуска */}
        <DistributionBar distribution={distribution} />

        {/* Дисциплины */}
        <div className="pt-1">
          <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Дисциплины
          </h2>

          {grades && grades.subjects.length === 0 ? (
            <EmptyState title="Оценок пока нет" description="Данные появятся после первых контрольных." />
          ) : (
            <ListGroup>
              {grades?.subjects.map((subject) => (
                <SubjectRow
                  key={subject.discipline}
                  subject={subject}
                  isOpen={expanded.has(subject.discipline)}
                  onToggle={() => toggle(subject.discipline)}
                />
              ))}
            </ListGroup>
          )}
        </div>
      </div>
    </Page>

    {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

/**
 * Распределение выставленных оценок — сводкой из четырёх карточек.
 *
 * Раньше это была только полоска, а рядом с ней цветные «5» и «12»: по такой
 * подписи нельзя было понять, где сама оценка, а где её количество, — и это
 * главная претензия к прежнему виду. Теперь у каждой оценки своя карточка:
 * крупная цифра — сколько, подпись со склонением — за что. Полоска осталась
 * под карточками и служит только пропорцией, без подписей внутри.
 *
 * Цвет цифры — не чистый токен, а смесь с основным цветом текста: чистый токен
 * не проходит AA на светлой теме (см. @utility grade-ink в index.css).
 *
 * Склонение берём у существующего plural(): правила у «оценка/оценки/оценок»
 * ровно те же, что у «пара/пары/пар», — второй такой функции не нужно.
 */
function DistributionBar({
  distribution,
}: {
  distribution: { fives: number; fours: number; threes: number; twos: number; total: number } | null;
}) {
  /** Карточки пересобираются только при смене снимка, а не на каждый рендер. */
  const cards = useMemo(
    () =>
      distribution
        ? [
            { mark: 5, count: distribution.fives, tone: 'var(--grade-5)', words: ['пятёрка', 'пятёрки', 'пятёрок'] },
            { mark: 4, count: distribution.fours, tone: 'var(--grade-4)', words: ['четвёрка', 'четвёрки', 'четвёрок'] },
            { mark: 3, count: distribution.threes, tone: 'var(--grade-3)', words: ['тройка', 'тройки', 'троек'] },
            { mark: 2, count: distribution.twos, tone: 'var(--grade-2)', words: ['двойка', 'двойки', 'двоек'] },
          ]
        : [],
    [distribution],
  );

  // Ни одной оценки в семестре: четыре нуля читались бы как «данные есть», хотя
  // их нет. Поэтому показывается пояснение — как и раньше.
  if (!distribution || distribution.total === 0) {
    return (
      <Card className="px-4 py-4">
        <p className="text-[13px] text-[var(--text-secondary)]">
          Оценок за контрольные пока нет — распределение появится после первых баллов.
        </p>
      </Card>
    );
  }

  return (
    <Card className="px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[13px] text-[var(--text-secondary)]">Распределение оценок</span>
        {/* Было --text-tertiary: контраст 1.97:1 на светлой теме, ниже AA. */}
        <span className="text-[12px] tabular-nums text-[var(--text-secondary)]">
          всего {distribution.total}
        </span>
      </div>

      {/* Две колонки на телефоне, четыре — когда места хватает. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map(({ mark, count, tone, words }) => (
          <div
            key={mark}
            // role="img": карточка читается одним объектом, поэтому цифра и
            // подпись не дублируют друг друга в скринридере. В aria — полная
            // формулировка (в подписи слово короче, но смысл тот же).
            role="img"
            aria-label={`Оценок на ${mark}: ${count}`}
            className="surface-grouped flex flex-col items-center justify-center px-2 py-2.5"
            style={{ '--tone': tone } as CSSProperties}
          >
            <span className="grade-ink text-[22px] font-semibold leading-none tabular-nums">
              {count}
            </span>
            <span className="mt-1 text-center text-[12px] leading-tight text-[var(--text-secondary)]">
              {plural(count, words[0], words[1], words[2])}
            </span>
          </div>
        ))}
      </div>

      {/* Пропорция без подписей: числа уже озвучены карточками. Перекрывать
          ими полоску нельзя — именно это и путало в прежнем виде. */}
      <div className="mt-2.5 flex h-2 overflow-hidden rounded-full" aria-hidden>
        {cards
          .filter((card) => card.count > 0)
          .map(({ mark, count, tone }) => (
            <div
              key={mark}
              style={{ width: `${(count / distribution.total) * 100}%`, background: tone }}
            />
          ))}
      </div>
    </Card>
  );
}

/** Строка дисциплины с прогрессом и раскрываемым списком КМ. */
function SubjectRow({
  subject,
  isOpen,
  onToggle,
}: {
  subject: ApiSubjectGrade;
  isOpen: boolean;
  onToggle: () => void;
}) {
  // БАРС уже посчитал средний с учётом пересдач — если значение есть, показываем
  // его. Свой расчёт по видимым КМ остаётся запасным вариантом.
  const average = subject.barsAverage ?? subject.currentAverage;
  const progress = subject.totalWeight > 0 ? (subject.gradedWeight / subject.totalWeight) * 100 : 0;

  return (
    <div className="border-t border-[var(--separator-soft)] first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[15px] font-medium">{subject.discipline}</span>
            {subject.finalGrade ? (
              <span
                className="rounded-md px-1.5 py-0.5 text-[12px] font-semibold"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {subject.finalGrade}
              </span>
            ) : null}
            <span
              className="w-12 text-right text-[16px] font-semibold tabular-nums"
              style={{ color: average !== null ? gradeColor(average) : 'var(--text-tertiary)' }}
            >
              {average !== null ? average.toFixed(1).replace('.', ',') : '—'}
            </span>
          </div>

          {subject.attestation ? (
            <p className="mt-0.5 truncate text-[12px] text-[var(--text-secondary)]">
              {subject.attestation.charAt(0).toLocaleUpperCase('ru') + subject.attestation.slice(1)}
            </p>
          ) : null}

          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--separator-soft)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.min(progress, 100)}%`, background: 'var(--accent)' }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
              {subject.gradedCount}/{subject.totalCount}
            </span>
          </div>
        </div>

        <ChevronRight
          size={16}
          aria-hidden
          className="shrink-0 transition-transform duration-200"
          style={{ color: 'var(--text-tertiary)', transform: isOpen ? 'rotate(90deg)' : 'none' }}
        />
      </button>

      {isOpen ? (
        <div className="animate-fade bg-[var(--surface-grouped)]">
          {subject.controlPoints.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--text-secondary)]">
              Контрольные мероприятия не указаны
            </p>
          ) : (
            subject.controlPoints.map((point) => (
              <div
                key={point.number}
                className="flex items-start gap-3 border-t border-[var(--separator-soft)] px-4 py-2.5"
              >
                <span className="mt-0.5 shrink-0 text-[12px] font-medium text-[var(--text-tertiary)]">
                  КМ {point.number}
                </span>

                <div className="min-w-0 flex-1">
                  {point.title ? (
                    <p className="text-[13px] leading-snug">{point.title}</p>
                  ) : (
                    <p className="text-[13px] text-[var(--text-secondary)]">Без названия</p>
                  )}

                  <div className="mt-0.5 flex items-center gap-3 text-[11px] text-[var(--text-tertiary)]">
                    {typeof point.weight === 'number' ? (
                      <span className="inline-flex items-center gap-1">
                        <Hash size={10} aria-hidden />
                        {point.weight}%
                      </span>
                    ) : null}
                    {point.week ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} aria-hidden />
                        неделя {point.week}
                      </span>
                    ) : null}
                    {point.date ? <span>{point.date}</span> : null}
                  </div>

                  {/* Пересдача: БАРС считает среднее по попыткам, показываем его
                      и сами попытки, чтобы оценка не выглядела «взявшейся из ниоткуда». */}
                  {point.attempts && point.attempts.length > 1 ? (
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      Попытки: {point.attempts.join(' → ')}
                    </p>
                  ) : null}
                </div>

                <span
                  className="shrink-0 text-[15px] font-semibold tabular-nums"
                  style={{ color: point.score !== null ? gradeColor(point.score) : 'var(--danger)' }}
                >
                  {point.score !== null ? point.score.toFixed(1).replace('.', ',') : '—'}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Квадрат со значением. */
function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  decimal,
}: {
  label: string;
  value: number | null;
  hint: string;
  tone?: 'default' | 'accent' | 'danger';
  decimal?: boolean;
}) {
  const valueColor =
    tone === 'danger' && (value ?? 0) > 0
      ? 'var(--danger)'
      : tone === 'accent' || tone === 'danger'
        ? 'var(--accent)'
        : 'var(--text-primary)';

  return (
    <Card className="px-4 py-3.5">
      <p className="truncate text-[12px] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums" style={{ color: valueColor }}>
        {value === null
          ? '—'
          : decimal
            ? value.toFixed(1).replace('.', ',')
            : String(value)}
      </p>
      <p className="mt-1 truncate text-[11px] text-[var(--text-tertiary)]">{hint}</p>
    </Card>
  );
}
