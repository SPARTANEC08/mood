import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Header } from '@/components/TabBar';
import { Page } from '@/components/Page';
import { EmptyState, ErrorState, SkeletonLesson } from '@/components/ui';
import { api } from '@/lib/api';
import { SubjectScreen } from './SubjectScreen';
import { DayPager, WeekStrip } from '@/components/WeekStrip';
import { LessonCard, LunchBreak } from '@/components/schedule/LessonCard';
import {
  findLunchBreak,
  LONG_DAYS,
  longDayName,
  SHORT_DAYS,
  toMoscowRaw,
} from '@/components/schedule/helpers';
import { useAppData } from '@/lib/dataContext';
import { formatRawDate, parseRawDate } from '@/lib/dates';
import { readLastDay, writeLastDay } from '@/lib/lastDay';
import { perfLog } from '@/lib/perf';
import type { ApiHomework, ApiSubjectGrade } from '@/types/api';
import { haptic } from '@/lib/env';
import type { ApiScheduleDay, ScheduleResponse } from '@/types/api';

/** Ответ API на попытку обновления. */
interface ScheduleState {
  data: ScheduleResponse | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
}

export function SchedulePage() {
  // Расписание берётся из общего кэша: оно грузится один раз при входе,
  // и переключение вкладок сеть больше не трогает.
  const { userId, schedule, loading: cacheLoading, refreshing, error: cacheError, refresh } = useAppData();

  // Замер первого кадра страницы: по нему видно, что расписание показано из
  // кэша (<100 мс), а не после сети. Снимается один раз, до отрисовки.
  const mountAt = useRef(performance.now());
  useLayoutEffect(() => {
    perfLog('schedule-mount', Math.round(performance.now() - mountAt.current));
  }, []);

  // Первый кадр С расписанием: если оно пришло из кэша, это те же <100 мс, что
  // и монтирование; если пришло из сети — здесь видно, сколько человек ждал.
  const paintedRef = useRef(false);
  useLayoutEffect(() => {
    if (paintedRef.current || !schedule) return;
    paintedRef.current = true;
    perfLog('first-schedule-paint', Math.round(performance.now() - mountAt.current));
  }, [schedule]);

  const state: ScheduleState = useMemo(
    () => ({
      data: schedule,
      loading: cacheLoading,
      error: cacheError,
      refreshing,
    }),
    [schedule, cacheLoading, cacheError, refreshing],
  );

  // Выбранный день хранится как YYYY.MM.DD, а не индексом в неделе: индекс
  // после смены недели указывал бы на другой день, и выделение слетело бы с
  // сегодняшнего. Восстанавливается из localStorage ДО первого рендера, чтобы
  // после перезагрузки и смены вкладки человек сразу видел свой день — без
  // анимации «приезда» от чужой страницы.
  const [selectedDate, setSelectedDate] = useState<string | null>(() => readLastDay(userId));

  /** Смена дня человеком: помним её между открытиями приложения. */
  const chooseDay = useCallback(
    (rawDate: string) => {
      setSelectedDate(rawDate);
      writeLastDay(userId, rawDate);
    },
    [userId],
  );
  const [expandedHomework, setExpandedHomework] = useState<Set<string>>(new Set());

  /** Открытый предмет: тап по названию дисциплины в карточке пары. */
  const [openSubject, setOpenSubject] = useState<string | null>(null);
  /**
   * Полные записи ДЗ, чтобы показать вложения прямо в карточке пары.
   *
   * В расписании к паре приклеены только метаданные задания (id, текст, автор и
   * СКОЛЬКО файлов) — это дёшево и не тянет список вложений в каждый ответ
   * расписания. Но человеку на расписании нужно то же самое, что и на экране
   * предмета: увидеть фотографию задания и скачать её. Поэтому полные записи
   * подгружаются отдельно, один раз, и живут в состоянии страницы.
   */
  const [homeworkList, setHomeworkList] = useState<ApiHomework[]>([]);
  const [homeworkFilesLoading, setHomeworkFilesLoading] = useState(false);

  /** Просит полный список ДЗ, если он ещё не загружен. */
  const ensureHomeworkFiles = useCallback(async () => {
    if (homeworkList.length > 0 || homeworkFilesLoading) return;

    setHomeworkFilesLoading(true);
    try {
      const res = await api.homework();
      setHomeworkList(res.items);

      // Сверка: у каждого задания, приклеенного к паре в расписании, должна
      // быть полная запись в общем списке. Расписание отдаёт только метаданные
      // (id, текст, автор, СКОЛЬКО файлов), поэтому вложения берутся отсюда.
      // Если id не совпал — карточка не найдёт запись и покажет «Файлы
      // загружаются…» вечно, и тап по файлу будет невозможен. Это единственное
      // место, где расхождение видно сразу и целиком, поэтому оно логируется
      // один раз после загрузки, а не на каждом тапе.
      const loaded = new Set(res.items.map((item) => item.id));
      const missing: string[] = [];
      for (const day of schedule?.days ?? []) {
        for (const slot of day.slots) {
          for (const hw of slot.homework) {
            if (!loaded.has(hw.id)) missing.push(hw.id);
          }
        }
      }
      if (missing.length > 0) {
        console.warn(
          '[SchedulePage] у заданий расписания нет полной записи, вложения не покажутся:',
          missing,
        );
      }
    } catch (err: unknown) {
      // Не удалось — карточка покажет ДЗ без вложений. Раньше здесь был пустой
      // catch: причина терялась, и «вложения не пришли» и «сервер упал» были
      // одним и тем же молчанием.
      console.error('[SchedulePage] не удалось загрузить список ДЗ:', err);
    } finally {
      setHomeworkFilesLoading(false);
    }
  }, [homeworkList.length, homeworkFilesLoading]);

  const homeworkById = useMemo(() => {
    const map = new Map<string, ApiHomework>();
    for (const item of homeworkList) map.set(item.id, item);
    return map;
  }, [homeworkList]);
  const [subjectGrade, setSubjectGrade] = useState<ApiSubjectGrade | null>(null);
  const [isGradeLoading, setIsGradeLoading] = useState(false);

  /**
   * Сегодня по Москве.
   *
   * Считается один раз на монтирование: раньше строка стояла в теле компонента
   * и пересоздавала дату на каждом рендере, а вместе с ней — новый объект
   * Date, который ломал сравнения в useMemo ниже по файлу.
   */
  const [today, setToday] = useState(() => toMoscowRaw());

  /**
   * Дата «сегодня» должна меняться сама.
   *
   * Приложение может висеть открытым через полночь — и без этого «ближайший
   * непрошедший день» остался бы вчерашним, а переход на нынешнюю неделю
   * случился бы только после перезапуска. Раз в минуту: значение почти всегда
   * то же самое, а React на то же значение дерево не перерисовывает.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const current = toMoscowRaw();
      setToday((prev) => (prev === current ? prev : current));
    }, 60_000);

    return () => clearInterval(timer);
  }, []);


  /**
   * Ближайший непрошедший день выгрузки — на нём приложение открывается само.
   *
   * Считается как производное значение, а НЕ ставится в состояние из эффекта.
   * Так было раньше, и отсюда был прыжок: до срабатывания эффекта selectedDate
   * оставался null, неделя считалась от первого дня выгрузки (минус две недели),
   * а через кадр приложение перелетало на сегодняшнюю неделю. Человек видел
   * скачок ленты при каждом входе — дважды за открытие и всегда одинаково.
   */
  const defaultDate = useMemo(() => {
    const days = state.data?.days ?? [];
    if (days.length === 0) return null;

    const nextUp = days.find((d) => d.rawDate >= today);
    // Расписание целиком в прошлом (например, семестр сдан) — последний день.
    return nextUp?.rawDate ?? days[days.length - 1].rawDate;
  }, [state.data, today]);

  /**
   * День, который реально показывается: выбор человека, иначе ближайший день.
   *
   * Выбранная дата проверяется на попадание в выгрузку: после обновления
   * границы расписания сдвигаются (окно всегда «минус две недели»), и дата,
   * ушедшая за maxRaw, иначе оставила бы ленту пустой.
   */
  const effectiveDate = useMemo(() => {
    const days = state.data?.days ?? [];
    if (days.length === 0) return selectedDate;

    const first = days[0].rawDate;
    const last = days[days.length - 1].rawDate;

    if (selectedDate && selectedDate >= first && selectedDate <= last) return selectedDate;
    return defaultDate;
  }, [selectedDate, defaultDate, state.data]);

  /**
   * Семь дней выбранной недели — Пн…Вс, независимо от расписания.
   *
   * Раньше неделя собиралась из дней, которые прислал МЭИ, и поэтому обрезалась
   * на четверге: в выгрузке БАРС есть только будни, а субботы и воскресенья
   * отсутствуют совсем. Теперь сетка строится от календарных дат, а пары
   * подставляются из расписания. Выходные остаются видимыми и кликабельными —
   * по ним показывается «свободный день».
   *
   * Дни за пределами выгруженного диапазона в ленте не участвуют: в декабре
   * тянулись бы пустые страницы месяцами. Полоса дат при этом клетки свои
   * показывает — иначе сетка рассыпалась бы на неполные колонки.
   */
  const weekDays = useMemo(() => {
    const all = state.data?.days ?? [];
    if (all.length === 0) return [];

    const anchor = effectiveDate ?? all[0]?.rawDate ?? null;
    if (!anchor) return [];

    const anchorDate = parseRawDate(anchor);
    if (!anchorDate) return [];

    const dayOfWeek = (anchorDate.getUTCDay() + 6) % 7; // 0 = Пн
    const monday = new Date(anchorDate);
    monday.setUTCDate(anchorDate.getUTCDate() - dayOfWeek);

    const byRaw = new Map(all.map((d) => [d.rawDate, d]));
    const lastRaw = all[all.length - 1].rawDate;
    const firstRaw = all[0].rawDate;

    const cells: ApiScheduleDay[] = [];

    for (let i = 0; i < 7; i += 1) {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + i);
      const raw = formatRawDate(date);

      // За краями выгрузки показывать «свободный день» нельзя: там расписание
      // просто ещё не выгружено, и страница дня была бы враньём.
      if (raw < firstRaw) continue;
      if (raw > lastRaw) break;

      cells.push(
        byRaw.get(raw) ?? {
          rawDate: raw,
          dayOfWeek: i + 1,
          dayShort: SHORT_DAYS[i],
          dayName: LONG_DAYS[i],
          slots: [],
        },
      );
    }

    return cells;
  }, [state.data, effectiveDate]);

  /**
   * Границы листания: первый и последний день выгрузки расписания.
   *
   * За ними листать нельзя, и они совпадают с тем, что видит полоса дней:
   * дни за пределами выгрузки в сетке не показываются, поэтому жест, который
   * увёл бы туда, выглядел бы как пустота под пальцем.
   */
  const [minRaw, maxRaw] = useMemo(() => {
    const all = state.data?.days ?? [];
    if (all.length === 0) return [null, null] as const;
    return [all[0].rawDate, all[all.length - 1].rawDate] as const;
  }, [state.data]);

  /**
   * Дни выгрузки по дате — источник для клеток полосы дат.
   *
   * Клетке нужно знать, есть ли в дне пары: без этого суббота и воскресенье
   * выглядели бы так же, как рабочий день с двумя парами.
   */
  const daysByRaw = useMemo(() => {
    const map = new Map<string, ApiScheduleDay>();
    for (const day of state.data?.days ?? []) map.set(day.rawDate, day);
    return map;
  }, [state.data]);

  /**
   * Недели, доступные для листания полосой дат.
   *
   * Список строится от понедельника первой недели выгрузки до воскресенья
   * последней, поэтому у последней недели карусель есть даже тогда, когда
   * расписание обрывается на четверге.
   */
  const weeks = useMemo(() => {
    if (!minRaw || !maxRaw) return [];

    const first = parseRawDate(minRaw);
    const last = parseRawDate(maxRaw);
    if (!first || !last) return [];

    // Понедельник недели, в которую попала первая дата выгрузки.
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));

    const result: string[] = [];
    const cursor = new Date(first);

    // Недель может быть много: за семестр их около 18. Цикл заканчивается по
    // последней дате выгрузки, а не по счётчику — границу задают данные.
    while (cursor <= last) {
      result.push(formatRawDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    return result;
  }, [minRaw, maxRaw]);

  /** Позиция текущей недели в списке: 0, пока нечего показывать. */
  const activeWeek = useMemo(() => {
    const base = effectiveDate ?? weekDays[0]?.rawDate ?? null;
    if (!base) return 0;

    const date = parseRawDate(base);
    if (!date) return 0;

    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));

    const mondayRaw = formatRawDate(monday);
    const index = weeks.indexOf(mondayRaw);
    if (index >= 0) return index;

    // Недели выгрузки начинаются не с понедельника (окно МЭИ обрезано по датам),
    // поэтому точное попадание возможно не всегда. Откат на нулевую неделю был
    // как раз тем прыжком на прошлое: берём последнюю неделю, которая не позже
    // нужной, — это ближайшая осмысленная.
    let fallback = 0;
    for (let i = 0; i < weeks.length; i += 1) {
      if (weeks[i] <= mondayRaw) fallback = i;
    }
    return fallback;
  }, [effectiveDate, weekDays, weeks]);

  /** Позиция выбранного дня внутри недели — для карусели дней. */
  const activeDay = useMemo(() => {
    const index = weekDays.findIndex((d) => d.rawDate === effectiveDate);
    return index >= 0 ? index : 0;
  }, [weekDays, effectiveDate]);

  /** Выбор дня тапом по полосе дат. */
  const selectDay = useCallback((rawDate: string) => chooseDay(rawDate), [chooseDay]);

  /** Переключение дня свайпом по ленте пар. */
  const selectDayAt = useCallback(
    (index: number) => {
      const day = weekDays[index];
      if (day) chooseDay(day.rawDate);
    },
    [weekDays, chooseDay],
  );

  /**
   * Переход на соседнюю неделю с сохранением дня недели.
   *
   * Тот же день недели: иначе свайп по полосе выглядел бы как переход на
   * произвольную дату — из среды попадали во вторник, и что произошло, не
   * понятно. Если день за пределами выгрузки (последняя неделя обрывается на
   * четверге), берётся крайний день выгрузки: полоса всё равно уезжает ровно
   * на неделю.
   */
  const selectWeek = useCallback(
    (index: number) => {
      const mondayRaw = weeks[index];
      if (!mondayRaw || !effectiveDate || !maxRaw || !minRaw) return;

      const current = parseRawDate(effectiveDate);
      const monday = parseRawDate(mondayRaw);
      if (!current || !monday) return;

      const offset = (current.getUTCDay() + 6) % 7; // 0 = Пн
      const target = new Date(monday);
      target.setUTCDate(monday.getUTCDate() + offset);

      const raw = formatRawDate(target);
      chooseDay(raw > maxRaw ? maxRaw : raw < minRaw ? minRaw : raw);
    },
    [weeks, effectiveDate, minRaw, maxRaw, chooseDay],
  );

  /**
   * Открытие предмета.
   *
   * Расписание и ДЗ уже в памяти — показываем экран сразу. Оценки по
   * предмету подгружаем отдельно: экран не должен ждать БАРС, поэтому на
   * время запроса показывается скелет только в блоке итога.
   */
  const openDiscipline = useCallback(
    async (discipline: string) => {
      haptic('light');
      setOpenSubject(discipline);
      setSubjectGrade(null);
      setIsGradeLoading(true);

      // ДЗ нужны сразу; при провале экран всё равно покажется — просто без них.
      void api
        .homework()
        .then((res) => setHomeworkList(res.items))
        .catch(() => undefined);

      try {
        const grades = await api.grades();
        const found = grades.subjects.find((s) => s.discipline === discipline) ?? null;
        setSubjectGrade(found);
      } catch {
        setSubjectGrade(null);
      } finally {
        setIsGradeLoading(false);
      }
    },
    [],
  );

  /**
   * Раскрытие карточки ДЗ в ленте пары.
   */
  const toggleHomework = useCallback((id: string) => {
    haptic('light');
    setExpandedHomework((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

    // Диагностика вложений. По симптому «тап по файлу ничего не делает» сразу
    // видно, в каком из трёх случаев мы: full === undefined — полная запись не
    // подгрузилась (нет файлов в DOM, нажимать нечего); files.length === 0 —
    // у записи нет файлов на сервере; files.length > 0 — не работает открытие.
    const full = homeworkById.get(id);
    console.log('[SchedulePage] раскрытие ДЗ', {
      id,
      found: Boolean(full),
      filesCount: full?.files?.length ?? 0,
      firstMimeType: full?.files?.[0]?.mimeType ?? null,
      firstFileId: full?.files?.[0]?.fileId ?? null,
    });

    // Раскрытие задания — момент, когда человеку понадобятся его файлы.
    // Досылаем полный список ДЗ здесь: он один на страницу, а не на каждую
    // карточку, и повторные раскрытия уже ничего не ждут.
    if (!expandedHomework.has(id)) void ensureHomeworkFiles();
  }, [expandedHomework, ensureHomeworkFiles, homeworkById]);

  /**
   * Содержимое страницы дня.
   *
   * Вызывается для всех дней недели сразу: карусель смонтирована целиком, и
   * соседние дни обязаны быть в дереве уже во время жеста, иначе палец тянул бы
   * пустоту.
   */
  const renderDay = useCallback(
    (day: ApiScheduleDay) => {
      if (day.slots.length === 0) {
        return (
          <EmptyState
            title="Свободный день"
            description={`${day.dayName ?? longDayName(day.rawDate)} — занятий нет.`}
          />
        );
      }

      return (
        /*
         * gap вместо space-y.
         *
         * space-y работает через `:where(...)` — селектор с нулевой
         * специфичностью, — и полагается на то, что его правило окажется позже
         * по каскаду, чем сброс полей из префлайта. Работать это будет, пока не
         * появится любой конкурирующий margin, и тогда зазор исчезнет молча,
         * ровно как сейчас при листании. gap задаёт расстояние самим
         * раскладчиком, ему не с чем конкурировать.
         */
        <div className="flex flex-col gap-2.5">
          {day.slots.map((slot, index) => {
            const lunch = index > 0 ? findLunchBreak(day.slots[index - 1], slot) : null;

            return (
              <div key={`${day.rawDate}-${slot.lessonNumber}`}>
                {/* Перерыв отделяем от карточки: он лежит ВНУТРИ того же
                    wrapper'а, поэтому межблочный gap до него не относится и без
                    этого отступа он прилипал к паре. */}
                {lunch ? <LunchBreak from={lunch.from} to={lunch.to} /> : null}
                <LessonCard
                  slot={slot}
                  expanded={expandedHomework}
                  onToggleHomework={toggleHomework}
                  onOpenSubject={openDiscipline}
                  homeworkById={homeworkById}
                />
              </div>
            );
          })}
        </div>
      );
    },
    [expandedHomework, toggleHomework, openDiscipline, homeworkById],
  );

  // Экран предмета заменяет ленту целиком: у него своя шапка с кнопкой «Назад».
  if (openSubject) {
    return (
      <SubjectScreen
        discipline={openSubject}
        days={state.data?.days ?? []}
        homework={homeworkList}
        grade={subjectGrade}
        isGradeLoading={isGradeLoading}
        onBack={() => {
          haptic('light');
          setOpenSubject(null);
        }}
      />
    );
  }

  if (state.loading) {
    return (
      <Page header={<Header title="Расписание" large />}>
        {/* Скелеты вместо пустоты: структура видна сразу, приходят данные. */}
        <div className="space-y-2.5">
          <SkeletonLesson />
          <SkeletonLesson />
          <SkeletonLesson />
          <SkeletonLesson />
        </div>
      </Page>
    );
  }

  if (state.error && !state.data) {
    return (
      <Page header={<Header title="Расписание" large />}>
        <ErrorState message={state.error} onRetry={refresh} />
      </Page>
    );
  }

  const group = state.data?.groupName ?? '';

  return (
    <>
      <Page
      // Полоса дат неподвижна, а прокручиваются страницы дней под ней, поэтому
      // содержимое занимает всю высоту экрана и прокручивается само.
      fill
      header={
        <Header
          title="Расписание"
          large
          subtitle={group ? `Группа ${group}` : undefined}
          right={
            <button
              type="button"
              aria-label="Обновить расписание"
              onClick={() => {
                haptic('light');
                refresh();
              }}
              className="pressable rounded-full p-2 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <RefreshCw size={19} className={state.refreshing ? 'spinner' : undefined} aria-hidden />
            </button>
          }
        />
      }
    >
      {/*
        Полоса дат — неподвижная часть экрана, отступ от краёв ей нужен свой:
        трек карусели дней вынесен к краям экрана целиком (см. Page в режиме
        fill), и без обёртки клетки уехали бы вплотную к краям.
      */}
      <div className="px-4">
        <WeekStrip
          weeks={weeks}
          activeWeek={activeWeek}
          onWeekChange={selectWeek}
          daysByRaw={daysByRaw}
          minRaw={minRaw}
          maxRaw={maxRaw}
          selectedDate={effectiveDate}
          today={today}
          onSelectDay={selectDay}
        />
      </div>

      {/* Отступ снизу — под последней карточкой, а не под панель навигации:
          панель стоит в колонке ниже этого блока и ленту не перекрывает. */}
      <DayPager
        days={weekDays}
        index={activeDay}
        onIndexChange={selectDayAt}
        className="mt-3 min-h-0 flex-1"
        // Прокрутка страницы и отступы заданы явно здесь, а не только в DayPager:
        // значение ниже складывается с классами DayPager, но полагаться на
        // это нельзя — отступы и overflow ведут себя по-разному в WebKit, и
        // при их расхождении страница дня схлопывается.
        //
        // px-4 — отступ от краёв экрана ВНУТРИ каждой страницы дня, а не на треке
        // карусели. На треке он сдвинул бы всю ленту внутрь экрана: соседние дни
        // выезжали бы из-под отступа, у краёв оставалась полоса фона с
        // обрезанными чужими карточками, а блоки соседних дней смыкались без
        // зазора. Внутри страницы отступ сохраняет прежний вид активного дня и
        // одновременно даёт между днями чистый промежуток в 32px.
        //
        // Отступы по вертикали несимметричны: pt-3 (12px) сверху и pb-6 (24px)
        // снизу. Дни — это соседние страницы карусели, и при свайпе глаз
        // сравнивает нижнюю карточку одного дня с верхней карточкой следующего:
        // сумма их отступов и есть видимый зазор между страницами, а не зазор
        // внутри страницы. Раньше было pt-2 + pb-8 = 40px, но перевес был внизу —
        // сверху ленты воздуха не хватало, и верхняя карточка прилипала к полосе
        // дат.
        pageClassName="scroll-hidden overflow-y-auto overscroll-contain px-4 pt-3 pb-6"
      >
        {renderDay}
      </DayPager>
      </Page>
    </>
  );
}
