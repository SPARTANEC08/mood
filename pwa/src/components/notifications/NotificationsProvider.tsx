/**
 * Состояние центра уведомлений на всё приложение.
 *
 * Задача провайдера — одна цифра на колокольчике, открытие ленты и обновление
 * счётчика после прочтения. Сам список живёт в листе: он нужен только когда
 * человек его открыл, и держать полсотни событий в памяти постоянно незачем.
 *
 * Опрос — раз в минуту и при возврате в приложение. Это лёгкий GET с двумя
 * COUNT-запросами, а не WebPush: у PWA в этой сборке нет своего push-канала.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from '@/lib/api';
import { NotificationsSheet } from './NotificationsSheet';

interface NotificationsContextValue {
  /** Сколько уведомлений не прочитано — для бейджа. */
  unread: number;
  /** Открыть ленту. */
  openHub: () => void;
  /** Перечитать только счётчик. */
  refreshUnread: () => Promise<void>;
  /** Сбросить кэш ленты: следующее открытие перечитает список. */
  invalidateFeed: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** null — провайдера нет (например, экран входа): колокольчик не рисуется. */
export function useNotifications(): NotificationsContextValue | null {
  return useContext(NotificationsContext);
}

const POLL_MS = 60_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);

  const refreshUnread = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const state = await api.notificationsUnread();
      setUnread(state.unread);
    } catch {
      // Нет сети или сессия БАРС недоступна — оставляем последнее значение.
      // Молчание лучше мигающего «0» на каждой потере связи.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshUnread();

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshUnread();
    }, POLL_MS);

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshUnread();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshUnread]);

  const invalidateFeed = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  const openHub = useCallback(() => {
    setOpen(true);
    void refreshUnread();
  }, [refreshUnread]);

  const value = useMemo<NotificationsContextValue>(
    () => ({ unread, openHub, refreshUnread, invalidateFeed }),
    [unread, openHub, refreshUnread, invalidateFeed],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}

      <NotificationsSheet
        open={open}
        onClose={() => setOpen(false)}
        revision={revision}
        onRead={() => void refreshUnread()}
        onReadAll={() => {
          invalidateFeed();
          void refreshUnread();
        }}
      />
    </NotificationsContext.Provider>
  );
}
