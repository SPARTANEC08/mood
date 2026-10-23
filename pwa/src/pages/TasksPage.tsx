import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleCheck, NotebookPen, StickyNote, TriangleAlert } from 'lucide-react';

import { AddRecordSheet, type RecordKind } from '@/components/AddRecordSheet';
import { Page } from '@/components/Page';
import { Header } from '@/components/TabBar';
import { RecordDetailScreen } from '@/components/RecordDetailScreen';
import { EmptyState, ErrorState, ListGroup, SkeletonList, Toast } from '@/components/ui';
import { RefreshIndicator } from '@/components/RefreshIndicator';
import { usePullToRefresh } from '@/components/PullToRefresh';
import {
  ConfirmSheet,
  describeRecord,
  HomeworkCard,
  ImportantCard,
  SectionHeader,
  type TaskRecord,
} from '@/components/tasks/parts';
import { ApiError, api } from '@/lib/api';
import { useAppData } from '@/lib/dataContext';
import { todayRawMoscow } from '@/lib/dates';
import { haptic, notify } from '@/lib/env';
import type { ApiHomework } from '@/types/api';

/**
 * Экран «Задания» с подвкладками «ДЗ» и «Важное».
 *
 * ДЗ идут по дате сдачи: ближайшие сверху, внутри дня — по номеру пары.
 * Просроченные показываются серым в конце списка и без чекбокса. Выполненные
 * уезжают в свёрнутую секцию «Сделано» внизу: это личная отметка, у разных
 * студентов группы она разная.
 *
 * Выбранная подвкладка запоминается, по умолчанию открываются ДЗ. «Важное»
 * остаётся отдельным списком от новых к старым.
 *
 * Плашка целиком кликабельна и открывает детальный экран. Чекбокс «Сделано»
 * живёт внутри плашки и не открывает её.
 *
 * Фильтр по предмету — обычный `<select>` в шапке списка, а не горизонтальная
 * лента чипов: лента занимала всю ширину ради двух-трёх предметов, скроллилась
 * боком и съедала место, которого на телефоне и так мало. На «Важном» фильтра
 * нет: там нет предметов.
 *
 * Добавление — кнопкой-плюсиком в нижней панели (см. TabBar), а не плюсом в
 * шапке: действие «добавить» нужно из любой вкладки, а не только с открытой.
 */

type TaskItem = TaskRecord;
type TasksTab = 'homework' | 'important';

/** Запоминаем выбранную подвкладку; по умолчанию — ДЗ. */
const TASKS_TAB_KEY = 'mood_tasks_tab';

/** Сортировка ДЗ: ближайшая дата, затем номер пары, затем время создания. */
function compareHomework(a: ApiHomework, b: ApiHomework): number {
  return (
    a.targetDate.localeCompare(b.targetDate) ||
    (a.lessonNumber ?? 0) - (b.lessonNumber ?? 0) ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

/** Что именно редактируем или создаём — нужно диалогу и после закрытия. */
interface SheetState {
  mode: 'create' | 'edit';
  kind: RecordKind;
  record?: TaskRecord;
}

/**
 * @param listsRevision Меняется, когда запись добавили или поправили вне этой
 *   страницы (диалог из нижней панели). Страница на это перечитывает списки —
 *   иначе человек нажал «+» на расписании, добавил и попал на «Задания» уже с
 *   устаревшим кэшем.
 */
export function TasksPage({ listsRevision = 0 }: { listsRevision?: number }) {
  const { homework, important, loading, error, refreshing, reloadLists } = useAppData();

  const [filter, setFilter] = useState<string>('');
  const [tab, setTab] = useState<TasksTab>(() => {
    try {
      return localStorage.getItem(TASKS_TAB_KEY) === 'important' ? 'important' : 'homework';
    } catch {
      return 'homework';
    }
  });
  /** Оптимистичные отметки «Сделано»: id → значение. */
  const [doneOverrides, setDoneOverrides] = useState<globalThis.Record<string, boolean>>({});
  const [doneOpen, setDoneOpen] = useState(false);

  /**
   * Открытая запись хранится по ИДЕНТИФИКАТОРУ, а не самим объектом.
   *
   * Раньше здесь лежал объект записи, и это ломало правку: список обновлялся,
   * а детальный экран продолжал показывать старый снимок — человек сохранял
   * новый заголовок и сразу видел прежний. Идентификатор же всегда ведёт к
   * свежему состоянию из кэша.
   */
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /**
   * После правок обновляем только списки: полный refresh заново ходит в БАРС и
   * IMAP, а после правки задания это лишние секунды ожидания.
   */
  const load = useCallback(async () => {
    await reloadLists();
  }, [reloadLists]);

  /**
   * Обновление по жесту: перечитывает ровно данные этой вкладки — ДЗ и
   * «Важное». Расписание не форсим: оно тут не показано, а поход в МЭИ ради
   * невидимого экрана — лишняя нагрузка.
   */
  const pullRefresh = useCallback(async () => {
    const message = await reloadLists();
    if (message) setToast(message);
  }, [reloadLists]);

  const pull = usePullToRefresh({ enabled: true, onRefresh: pullRefresh });

  const today = todayRawMoscow();

  /** ДЗ с учётом личных отметок «Сделано». */
  const homeworkWithDone = useMemo(
    () => homework.map((hw) => ({ ...hw, done: doneOverrides[hw.id] ?? hw.done })),
    [homework, doneOverrides],
  );

  /** Предметы фильтра — из всех ДЗ: фильтровать нечем по тому, чего нет. */
  const subjects = useMemo(() => {
    const set = new Set<string>();
    for (const hw of homework) set.add(hw.discipline);
    return [...set].sort();
  }, [homework]);

  const filteredHomework = useMemo(
    () => (filter ? homeworkWithDone.filter((hw) => hw.discipline === filter) : homeworkWithDone),
    [homeworkWithDone, filter],
  );

  const activeHomework = useMemo(
    () => filteredHomework.filter((hw) => !hw.done && hw.targetDate >= today).sort(compareHomework),
    [filteredHomework, today],
  );

  /** Просроченные — серым и в конце: без чекбокса, отметить нельзя. */
  const overdueHomework = useMemo(
    () => filteredHomework.filter((hw) => !hw.done && hw.targetDate < today).sort(compareHomework),
    [filteredHomework, today],
  );

  /** Сделано — отдельная свёрнутая секция внизу. */
  const doneHomework = useMemo(
    () =>
      filteredHomework
        .filter((hw) => hw.done)
        .sort((a, b) => b.targetDate.localeCompare(a.targetDate) || compareHomework(a, b)),
    [filteredHomework],
  );

  // Важное сортируется от новых к старым: у объявлений нет дедлайна.
  const sortedImportant = useMemo(
    () => [...important].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [important],
  );

  /**
   * Отметка «Сделано» — оптимистично. Сервер проверяет срок ещё раз; при
   * ошибке возвращаем прежнее состояние и показываем причину.
   */
  const toggleDone = useCallback(
    async (hw: ApiHomework) => {
      const next = !(doneOverrides[hw.id] ?? hw.done);

      setDoneOverrides((prev) => ({ ...prev, [hw.id]: next }));

      try {
        await api.setHomeworkDone(hw.id, next);
      } catch (err: unknown) {
        setDoneOverrides((prev) => {
          const copy = { ...prev };
          delete copy[hw.id];
          return copy;
        });
        notify('error');
        setToast(err instanceof ApiError ? err.message : 'Не удалось обновить задание.');
      }
    },
    [doneOverrides],
  );

  useEffect(() => {
    if (listsRevision === 0) return;
    void load();
  }, [listsRevision, load]);

  /**
   * Запись могла исчезнуть из кэша, пока был открыт её детальный экран —
   * например, её удалил однокурсник и список обновился. Тогда экран закрывается,
   * вместо того чтобы показывать то, чего уже нет.
   */
  /** Актуальная версия открытой записи — всегда из кэша, никогда не копия. */
  const openRecord = useMemo(
    () =>
      openRecordId
        ? (homework.find((h) => h.id === openRecordId) ??
          important.find((i) => i.id === openRecordId))
        : undefined,
    [openRecordId, homework, important],
  );

  useEffect(() => {
    // Запись могла исчезнуть из кэша, пока был открыт её детальный экран:
    // например, её удалил однокурсник и список обновился. Тогда экран
    // закрывается, вместо того чтобы показывать то, чего уже нет.
    if (openRecordId && !openRecord) setOpenRecordId(null);
  }, [openRecordId, openRecord]);

  /**
   * Удаление записи.
   *
   * Удалить может только автор; кнопки у чужих записей не показываются вовсе
   * (`canEdit` от сервера). Если запись всё же исчезла/недоступна, сервер
   * вернёт 404 — тогда показываем честное сообщение вместо «успеха».
   */
  const doDelete = useCallback(async () => {
    if (!confirmDelete || deletingId) return;

    const target = confirmDelete;
    setDeletingId(target.id);

    try {
      if ('discipline' in target) {
        await api.deleteHomework(target.id);
      } else {
        await api.deleteImportant(target.id);
      }

      notify('success');
      setConfirmDelete(null);
      setOpenRecordId(null);
      await load();
    } catch (err: unknown) {
      notify('error');
      setToast(err instanceof ApiError ? err.message : 'Не удалось удалить.');
    } finally {
      setDeletingId(null);
    }
  }, [confirmDelete, deletingId, load]);

  // ── Детальный экран ───────────────────────────────────────────────────────
  if (openRecordId && openRecord) {
    return (
      <>
        <RecordDetailScreen
          record={openRecord}
          onBack={() => setOpenRecordId(null)}
          onEdit={() =>
            setSheet({
              mode: 'edit',
              kind: 'discipline' in openRecord ? 'homework' : 'important',
              record: openRecord,
            })
          }
          onDelete={() => setConfirmDelete(openRecord)}
        />

        {sheet ? (
          <AddRecordSheet
            mode={sheet.mode}
            kind={sheet.kind}
            initialData={sheet.record}
            onClose={() => setSheet(null)}
            onSuccess={() => {
              setSheet(null);
              void load();
            }}
          />
        ) : null}

        {confirmDelete ? (
          <ConfirmSheet
            title="Удалить запись?"
            subtitle={describeRecord(confirmDelete)}
            busy={deletingId === confirmDelete.id}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => void doDelete()}
          />
        ) : null}
      </>
    );
  }

  if (loading) {
    return (
      <Page header={<Header title="Задания" large />}>
        {/* Скелет списка, а не спиннер по центру: структура видна сразу, и
            лента не «прыгает», когда придут данные. */}
        <SkeletonList />
      </Page>
    );
  }

  if (error && homework.length === 0 && important.length === 0) {
    return (
      <Page header={<Header title="Задания" large />}>
        <ErrorState message={error} onRetry={() => void load()} />
      </Page>
    );
  }

  return (
    <>
      <Page
        header={
          <Header
            title="Задания"
            large
            // Индикатор фонового обновления: списки обновляются сами при
            // возврате в приложение, и раньше это было совсем не видно. Пока
            // идёт жест, спиннер рисует сам pull-to-refresh — не дублируем.
            right={<RefreshIndicator active={refreshing && !pull.suppressBackground} />}
          />
        }
        pull={pull}
      >
        {/* Подвкладки: по умолчанию ДЗ, выбор запоминается. */}
        <div className="mb-3 flex gap-1 rounded-[14px] p-1" style={{ background: 'var(--surface)' }}>
          {([
            ['homework', 'ДЗ'],
            ['important', 'Важное'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (id === tab) return;
                haptic('light');
                setTab(id);
                try {
                  localStorage.setItem(TASKS_TAB_KEY, id);
                } catch {
                  // Приватный режим: выбор не переживёт перезагрузку.
                }
              }}
              className="pressable flex-1 rounded-[11px] py-2 text-[13.5px] font-semibold active:pressable-active"
              style={{
                background: tab === id ? 'var(--accent)' : 'transparent',
                color: tab === id ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Фильтр по предмету — только для ДЗ и только если предметов больше одного. */}
        {tab === 'homework' && subjects.length > 1 ? (
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Фильтр по предмету"
            className="mb-3 w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[14px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">Все предметы</option>
            {subjects.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : null}

        {tab === 'homework' ? (
          <>
            <section>
              <SectionHeader
                icon={<NotebookPen size={14} aria-hidden />}
                title={`Домашние задания${filter ? ` — ${filter}` : ''}`}
                count={activeHomework.length}
              />

              {activeHomework.length === 0 ? (
                <EmptyState
                  icon={<NotebookPen size={30} aria-hidden />}
                  title={filter ? 'По этому предмету заданий нет' : 'Активных заданий нет'}
                  description={
                    filter
                      ? 'Выберите другой предмет или снимите фильтр.'
                      : doneHomework.length > 0
                        ? 'Выполненные — в разделе «Сделано» ниже.'
                        : 'Нажмите «+» внизу, чтобы добавить первое.'
                  }
                />
              ) : (
                <ListGroup>
                  {activeHomework.map((hw) => (
                    <HomeworkCard
                      key={hw.id}
                      item={hw}
                      onOpen={() => setOpenRecordId(hw.id)}
                      onEdit={() => setSheet({ mode: 'edit', kind: 'homework', record: hw })}
                      onDelete={() => setConfirmDelete(hw)}
                      done={false}
                      onToggleDone={() => void toggleDone(hw)}
                    />
                  ))}
                </ListGroup>
              )}
            </section>

            {overdueHomework.length > 0 ? (
              <section className="mt-6">
                <SectionHeader
                  icon={<TriangleAlert size={14} aria-hidden />}
                  title="Просроченные"
                  count={overdueHomework.length}
                />
                <ListGroup>
                  {overdueHomework.map((hw) => (
                    <HomeworkCard
                      key={hw.id}
                      item={hw}
                      onOpen={() => setOpenRecordId(hw.id)}
                      onEdit={() => setSheet({ mode: 'edit', kind: 'homework', record: hw })}
                      onDelete={() => setConfirmDelete(hw)}
                      overdue
                    />
                  ))}
                </ListGroup>
              </section>
            ) : null}

            {doneHomework.length > 0 ? (
              <section className="mt-6">
                <button
                  type="button"
                  onClick={() => {
                    haptic('light');
                    setDoneOpen((open) => !open);
                  }}
                  aria-expanded={doneOpen}
                  className="pressable mb-2 flex w-full items-center gap-2 px-1 active:pressable-active"
                >
                  <span style={{ color: 'var(--text-tertiary)' }} aria-hidden>
                    <CircleCheck size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--text-secondary)]">
                    Сделано
                  </span>
                  <span className="text-[13px] text-[var(--text-tertiary)]">{doneHomework.length}</span>
                  <ChevronDown
                    size={15}
                    aria-hidden
                    style={{
                      color: 'var(--text-tertiary)',
                      transform: doneOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform 150ms',
                    }}
                  />
                </button>

                {doneOpen ? (
                  <ListGroup>
                    {doneHomework.map((hw) => (
                      <HomeworkCard
                        key={hw.id}
                        item={hw}
                        onOpen={() => setOpenRecordId(hw.id)}
                        onEdit={() => setSheet({ mode: 'edit', kind: 'homework', record: hw })}
                        onDelete={() => setConfirmDelete(hw)}
                        done
                        onToggleDone={() => void toggleDone(hw)}
                      />
                    ))}
                  </ListGroup>
                ) : null}
              </section>
            ) : null}
          </>
        ) : (
          <section>
            <SectionHeader
              icon={<StickyNote size={14} aria-hidden />}
              title="Важное"
              count={sortedImportant.length}
            />

            {sortedImportant.length === 0 ? (
              <EmptyState
                icon={<StickyNote size={30} aria-hidden />}
                title="Важного нет"
                description="Объявления вашей группы появятся здесь."
              />
            ) : (
              <ListGroup>
                {sortedImportant.map((item) => (
                  <ImportantCard
                    key={item.id}
                    item={item}
                    onOpen={() => setOpenRecordId(item.id)}
                    onEdit={() => setSheet({ mode: 'edit', kind: 'important', record: item })}
                    onDelete={() => setConfirmDelete(item)}
                  />
                ))}
              </ListGroup>
            )}
          </section>
        )}
      </Page>

      {sheet ? (
        <AddRecordSheet
          mode={sheet.mode}
          kind={sheet.kind}
          initialData={sheet.record}
          onClose={() => setSheet(null)}
          onSuccess={() => {
            setSheet(null);
            void load();
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmSheet
          title="Удалить запись?"
          subtitle={describeRecord(confirmDelete)}
          busy={deletingId === confirmDelete.id}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete()}
        />
      ) : null}

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
