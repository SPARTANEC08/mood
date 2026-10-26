/**
 * Уведомления внутри приложения: рассылки админа и события (оценки, письмо,
 * приказ, стипендия).
 *
 * В Telegram уходит только тип события, а здесь показываются детали: дисциплина
 * и балл, номер/дата приказа, статус стипендии. Для почты деталей нет — только
 * «Новое письмо». После «Закрыть» рассылка скрывается, событие помечается
 * прочитанным, и сразу показывается следующее из очереди.
 *
 * Опрос раз в 30 секунд, пока вкладка видима: у PWA нет своего push-канала, а
 * один лёгкий GET дешевле, чем WebPush и разрешения.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { AppNotification } from '@/types/api';
import {
  NotificationActions,
  NotificationContent,
  notificationTitle,
} from '@/components/notifications/NotificationContent';
import { useNotifications } from '@/components/notifications/NotificationsProvider';

/** Период опроса, пока приложение открыто. */
const POLL_MS = 30_000;

export function AnnouncementGate() {
  const [item, setItem] = useState<AppNotification | null>(null);
  const [closing, setClosing] = useState(false);
  /** Что показано прямо сейчас — чтобы опрос не подменял открытое окно. */
  const showing = useRef(false);
  const notifications = useNotifications();

  const load = useCallback(async () => {
    if (showing.current) return;
    try {
      const { item: next } = await api.notificationNext();
      if (next && !showing.current) {
        showing.current = true;
        setItem(next);
      }
    } catch {
      // Нет сети / нет входа в БАРС — молчим и повторим при следующем опросе.
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);

    // Возврат в приложение — самый частый случай «человек давно не открывал».
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const close = useCallback(async () => {
    const current = item;
    if (!current || closing) return;

    setClosing(true);
    try {
      await api.readNotification(current.id);
    } catch {
      // Сервер недоступен: закрываем локально, иначе окно не убрать.
    } finally {
      showing.current = false;
      setItem(null);
      setClosing(false);
      // Событие прочитано: обновляем бейдж и кэш ленты, если она открыта.
      notifications?.invalidateFeed();
      void notifications?.refreshUnread();
      // Очередь: сразу берём следующее уведомление, если оно есть.
      void load();
    }
  }, [closing, item, load, notifications]);

  if (!item) return null;

  const title = notificationTitle(item);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-5"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Закрыть"
        onClick={() => void close()}
        className="absolute inset-0 bg-black/45"
      />

      <div
        className="relative w-full max-w-[420px] rounded-[20px] p-5"
        style={{ background: 'var(--surface)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}
      >
        <NotificationContent item={item} />
        <NotificationActions item={item} />

        <button
          type="button"
          onClick={() => {
            haptic('light');
            void close();
          }}
          disabled={closing}
          className="pressable mt-4 w-full rounded-[14px] py-3 text-[16px] font-semibold text-white active:pressable-active disabled:opacity-60"
          style={{ background: 'var(--accent)' }}
        >
          {closing ? 'Закрываем…' : 'Закрыть'}
        </button>
      </div>
    </div>
  );
}
