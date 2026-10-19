import { useCallback, useEffect, useMemo, useState } from 'react';
import { NotebookPen, StickyNote } from 'lucide-react';

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
import { notify } from '@/lib/env';

/**
 * Экран «Задания и Важное».
 *
 * Список один, а не два переключаемых: человек чаще всего хочет увидеть «что
 * нового вообще», а не выбрать один из двух списков и потом узнать, что во
 * втором тоже что-то есть. Разделение осталось визуальным — двумя секциями с
 * заголовками внутри одного потока, — но порядок прокрутки один.
 *
 * Плашка целиком кликабельна и открывает детальный экран. Раньше карточка
 * раскрывалась на месте и разворачивала список в простыню; на мобильном экране
 * это означало, что вторая запись уезжала за экран и человек её не видел.
 *
 * Фильтр по предмету — обычный `<select>` в шапке списка, а не горизонтальная
 * лента чипов: лента занимала всю ширину ради двух-трёх предметов, скроллилась
 * боком и съедала место, которого на телефоне и так мало.
 *
 * Добавление — кнопкой-плюсиком в нижней панели (см. TabBar), а не плюсом в
 * шапке: действие «добавить» нужно из любой вкладки, а не только с открытой.
 */

type Record = TaskRecord;

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
  const [confirmDelete, setConfirmDelete] = useState<Record | null>(null);
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

  /**
   * На вкладке «Задания» показываются только актуальные задания.
   *
   * Общий список ДЗ теперь шире экрана: он покрывает окно расписания (−14 дней),
   * потому что задания на прошедшие дни нужны ленте пар вместе с вложениями.
   * Список же читают как «что задано» — прошедшие записи в нём были бы шумом,
   * поэтому здесь они отсекаются по московской дате.
   */
  const upcomingHomework = useMemo(() => {
    const today = todayRawMoscow();
    return homework.filter((hw) => hw.targetDate >= today);
  }, [homework]);

  /** Предметы фильтра — из существующих ДЗ: фильтровать нечем по тому, чего нет. */
  const subjects = useMemo(() => {
    const set = new Set<string>();
    for (const hw of upcomingHomework) set.add(hw.discipline);
    return [...set].sort();
  }, [upcomingHomework]);

  const visibleHomework = useMemo(() => {
    const list = filter
      ? upcomingHomework.filter((h) => h.discipline === filter)
      : upcomingHomework;
    return [...list].sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  }, [upcomingHomework, filter]);

  // Важное сортируется от новых к старым: у объявлений нет дедлайна, и «сверху
  // самое свежее» — единственный порядок, в котором они и читаются.
  const sortedImportant = useMemo(
    () => [...important].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [important],
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
        {/* Фильтр по предмету живёт в шапке списка и появляется только когда
            предметов больше одного: единственный предмет фильтром не является. */}
        {subjects.length > 1 ? (
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

        <section>
          <SectionHeader
            icon={<NotebookPen size={14} aria-hidden />}
            title={`Домашние задания${filter ? ` — ${filter}` : ''}`}
            count={visibleHomework.length}
          />

          {visibleHomework.length === 0 ? (
            <EmptyState
              icon={<NotebookPen size={30} aria-hidden />}
              title={filter ? 'По этому предмету заданий нет' : 'Заданий нет'}
              description={
                filter
                  ? 'Выберите другой предмет или снимите фильтр.'
                  : 'Нажмите «+» внизу, чтобы добавить первое.'
              }
            />
          ) : (
            <ListGroup>
              {visibleHomework.map((hw) => (
                <HomeworkCard
                  key={hw.id}
                  item={hw}
                  onOpen={() => setOpenRecordId(hw.id)}
                  onEdit={() => setSheet({ mode: 'edit', kind: 'homework', record: hw })}
                  onDelete={() => setConfirmDelete(hw)}
                />
              ))}
            </ListGroup>
          )}
        </section>

        <section className="mt-6">
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
