/**
 * Состояние центра уведомлений на всё приложение.
 *
 * Счётчика прочитанных больше нет: каждое новое уведомление и так показывается
 * полноэкранно. Провайдер отвечает только за открытие ленты и её обновление
 * после закрытия модалки, чтобы история не отставала от показанного.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { NotificationsSheet } from './NotificationsSheet';

interface NotificationsContextValue {
  /** Открыть ленту. */
  openHub: () => void;
  /** Сбросить кэш ленты: следующее открытие перечитает список. */
  invalidateFeed: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** null — провайдера нет (например, экран входа): колокольчик не рисуется. */
export function useNotifications(): NotificationsContextValue | null {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);

  const invalidateFeed = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  const openHub = useCallback(() => {
    setOpen(true);
  }, []);

  const value = useMemo<NotificationsContextValue>(
    () => ({ openHub, invalidateFeed }),
    [openHub, invalidateFeed],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}

      <NotificationsSheet
        open={open}
        onClose={() => setOpen(false)}
        revision={revision}
      />
    </NotificationsContext.Provider>
  );
}
