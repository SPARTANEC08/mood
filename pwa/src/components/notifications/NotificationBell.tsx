/**
 * Колокольчик в шапке.
 *
 * Одна кнопка на всё приложение: цифра непрочитанных и открытие ленты.
 * Если провайдера нет (экран входа, установка, согласия), компонент молча
 * ничего не рисует — шапки там всё равно нет.
 */

import { Bell } from 'lucide-react';

import { haptic } from '@/lib/env';
import { useNotifications } from './NotificationsProvider';

export function NotificationBell() {
  const notifications = useNotifications();
  if (!notifications) return null;

  const { unread, openHub } = notifications;

  return (
    <button
      type="button"
      aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
      onClick={() => {
        haptic('light');
        openHub();
      }}
      className="pressable relative rounded-full p-2 active:pressable-active"
      style={{ color: 'var(--accent)' }}
    >
      <Bell size={19} aria-hidden />

      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
          style={{ background: 'var(--danger)' }}
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </button>
  );
}
