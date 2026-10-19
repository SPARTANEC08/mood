/**
 * Точка сборки приложения: bootstrap и выбор экрана.
 *
 * Порядок загрузки выбран из соображений скорости открытия:
 *
 * 1. Первым показывается расписание. Оно берётся из кэша на сервере и не требует
 *    ни входа в БАРС, ни IMAP — отдаётся почти мгновенно, а на холодном старте
 *    ещё и восстанавливается из localStorage без запроса.
 * 2. Bootstrap с профилем уходит параллельно, НЕ блокируя расписание.
 * 3. Данные первого уровня (расписание, ДЗ, «Важное») тянет DataProvider один раз
 *    при входе; ленивые разделы БАРС и почта грузятся при открытии вкладки.
 *
 * Разметка оболочки и диалог добавления вынесены в app/Shell.tsx и
 * app/AddRecordFlow.tsx — здесь остаётся только управление bootstrap'ом и
 * переключением вкладки.
 */

import { useCallback, useEffect, useState } from 'react';

import { TabBar, type TabId } from '@/components/TabBar';
import { TelegramPrompt } from '@/components/TelegramPrompt';
import { ErrorState } from '@/components/ui';
import { clearPwaToken, SIGNED_OUT_EVENT } from '@/auth';
import { ApiError, api } from '@/lib/api';
import { DataProvider } from '@/lib/dataContext';
import { initTelegramApp, syncColorScheme } from '@/lib/env';
import { perfLog } from '@/lib/perf';
import { NeedLoginScreen } from '@/pages/ProfilePage';
import { SchedulePage } from '@/pages/SchedulePage';
import type { RecordKind } from '@/components/AddRecordSheet';
import type { BootstrapResponse } from '@/types/api';
import { Shell, Tier2Gate } from './Shell';

/**
 * Заглушка профиля на время загрузки bootstrap.
 *
 * Провайдеру кэша профиль нужен только как признак того, что вход разрешён.
 * Пока настоящий ответ не пришёл, экраны успевают отрисоваться скелетами, и
 * значения из заглушки не успевают нигде показаться.
 */
const EMPTY_BOOTSTRAP: BootstrapResponse = {
  profile: { userId: '', fullName: '', groupName: '' },
  barsAuthorized: true,
  sessionValid: null,
  today: '',
  weekNumber: 0,
  scheduleRange: null,
  mailUnread: null,
};

export function ScheduleApp({ onReLogin }: { onReLogin: () => void }) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('schedule');

  /**
   * Диалог добавления живёт в оболочке, но его состояние поднято сюда, чтобы
   * плюсик с панели открывал его из любой вкладки.
   */
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  /** На какой вид записи открыть диалог. По умолчанию — ДЗ: их добавляют чаще. */
  const [addKind, setAddKind] = useState<RecordKind>('homework');


  useEffect(() => {
    initTelegramApp();
    syncColorScheme();
  }, []);

  const loadBootstrap = useCallback(async () => {
    setError(null);
    const startedAt = Date.now();

    try {
      const result = await api.bootstrap();
      // Bootstrap идёт параллельно расписанию и не блокирует его показ: этот
      // замер показывает, сколько он занял САМ, не задерживая первый кадр.
      perfLog('bootstrap-done', Date.now() - startedAt);
      setBootstrap(result);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        // Токен недействителен или отозван на другом устройстве. Это не ошибка
        // сети, которую показывают поверх приложения: человека надо вернуть на
        // экран входа. Иначе он остался бы на скелетоне расписания с мёртвым
        // токеном и без объяснения.
        clearPwaToken();
        window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
        return;
      }

      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные.');
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <ErrorState message={error} onRetry={() => void loadBootstrap()} />
      </div>
    );
  }

  // Пока профиль не пришёл, расписание уже видно: оно не зависит от БАРС.
  //
  // DataProvider тоже нужен: страницы берут данные из кэша, а без профиля мы не
  // знаем, авторизован ли студент. Поэтому здесь он поднимается сразу, а не
  // после bootstrap — расписание от этого не задерживается.
  //
  // Ветки «показать null» здесь нет намеренно: любой сбой профиля либо уходит на
  // экран ошибки выше, либо на экран входа (401). В оставшемся случае на экране
  // скелет расписания — но никогда не пустой белый фон.
  if (!bootstrap) {
    return (
      <DataProvider bootstrap={EMPTY_BOOTSTRAP}>
        <Tier2Gate tab={tab} />
        {tab === 'schedule' ? <SchedulePage /> : null}
        <TabBar active={tab} onChange={setTab} onAdd={() => setAddSheetOpen(true)} />
      </DataProvider>
    );
  }

  if (!bootstrap.barsAuthorized) {
    return <NeedLoginScreen onReLogin={onReLogin} />;
  }

  return (
    <DataProvider bootstrap={bootstrap}>
      <Shell
        profile={bootstrap}
        tab={tab}
        onTab={setTab}
        addSheetOpen={addSheetOpen}
        addKind={addKind}
        onOpenAddSheet={(kind) => {
          setAddKind(kind);
          setAddSheetOpen(true);
        }}
        onCloseAddSheet={() => setAddSheetOpen(false)}
      />

      {/*
        Приглашение подключить Telegram. Показывается при каждом заходе, пока бот
        не привязан: внутри компонента и монтирование, и возврат из фона.
      */}
      <TelegramPrompt
        userId={bootstrap.profile.userId}
        telegramId={bootstrap.profile.telegramId}
      />
    </DataProvider>
  );
}
