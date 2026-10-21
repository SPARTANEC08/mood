/**
 * Оболочка с вкладками.
 *
 * Прокидывает кэш данных и счётчик обновления в страницы: вкладки не делают
 * собственных запросов, а читают готовое и получают новую метку, когда запись
 * добавили или поправили через диалог.
 *
 * Страница и панель навигации — соседи в одной flex-колонке #root высотой ровно
 * во видимую область (--app-height, см. index.css и lib/viewport.ts). Панель
 * стоит в потоке последней: лента выше растягивается на flex: 1 и прокручивается
 * сама, панель — shrink-0 и прижата к низу самой раскладкой. Поэтому её положение
 * не зависит ни от длины ленты, ни от адресной строки, ни от клавиатуры.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';

import { TabBar, type TabId } from '@/components/TabBar';
import { SkeletonList } from '@/components/ui';
import { useAppData } from '@/lib/dataContext';
import { ProfilePage } from '@/pages/ProfilePage';
import { SchedulePage } from '@/pages/SchedulePage';

/**
 * Тяжёлые вкладки грузятся отдельными чанками.
 *
 * Расписание — первый экран, оно в основном бандле. «Успеваемость» и «Задания»
 * открывают реже, и держать их код в стартовом бандле значит увеличивать LCP
 * ради экранов, которые человек может вообще не открыть. Vite выносит их в
 * отдельные файлы, а Suspense показывает скелет, пока чанк едет.
 */
const GradesPage = lazy(() => import('@/pages/GradesPage').then((m) => ({ default: m.GradesPage })));
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })));
import type { BootstrapResponse } from '@/types/api';
import { AddRecordFlow } from './AddRecordFlow';
import type { RecordKind } from '@/components/AddRecordSheet';

/**
 * Заявка вкладки на «ленивые» данные.
 *
 * Компонент без интерфейса и внутри провайдера: сам он не знает про данные, а
 * знает только номер вкладки. Так решение «когда грузить оценки и почту»
 * остаётся в одном месте (провайдере), а оболочка только сообщает, что человек
 * переключился.
 *
 * Стоит именно здесь, а не внутри страниц: страницы пересоздаются при каждом
 * переключении, и загрузка в useEffect означала бы повторный запрос при каждом
 * возврате на вкладку.
 */
function Tier2Gate({ tab }: { tab: TabId }) {
  const { loadTab } = useAppData();

  useEffect(() => {
    loadTab(tab);
  }, [loadTab, tab]);

  return null;
}

export { Tier2Gate };

export function Shell({
  profile,
  tab,
  onTab,
  addSheetOpen,
  addKind,
  onOpenAddSheet,
  onCloseAddSheet,
}: {
  profile: BootstrapResponse;
  tab: TabId;
  onTab: (id: TabId) => void;
  addSheetOpen: boolean;
  addKind: RecordKind;
  onOpenAddSheet: (kind: RecordKind) => void;
  onCloseAddSheet: () => void;
}) {
  /**
   * Счётчик, по которому «Задания» узнают, что данные списков устарели.
   *
   * Не событие в окне и не размазывание reloadLists по оболочке: диалог
   * добавления живёт здесь, а обновлять список умеет только страница. Счётчик —
   * единственный способ сказать ей «обновись», не ломая методы DataProvider.
   */
  const [listsRevision, setListsRevision] = useState(0);

  return (
    <MotionConfig reducedMotion="user">
      <Tier2Gate tab={tab} />

      {tab === 'schedule' ? <SchedulePage /> : null}
      <Suspense
        fallback={
          <div className="p-4">
            <SkeletonList count={3} />
          </div>
        }
      >
        {tab === 'grades' ? <GradesPage /> : null}
        {tab === 'tasks' ? <TasksPage listsRevision={listsRevision} /> : null}
      </Suspense>
      {tab === 'profile' ? <ProfilePage profile={profile} /> : null}

      <TabBar
        active={tab}
        onChange={onTab}
        onAdd={() => onOpenAddSheet('homework')}
      />

      {/*
        Диалог идёт вне MotionConfig намеренно: framer-motion тут ничего не
        анимирует, а лишний контекст на каждый переход листа заметен на слабом
        устройстве. После сохранения оболочка поднимает счётчик и уводит на
        «Задания» — человек нажал «+», добавил и должен увидеть результат.
      */}
      <AddRecordFlow
        open={addSheetOpen}
        kind={addKind}
        onClose={onCloseAddSheet}
        onSaved={() => {
          onCloseAddSheet();
          setListsRevision((revision) => revision + 1);
          onTab('tasks');
        }}
      />
    </MotionConfig>
  );
}
