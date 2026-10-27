/**
 * Колокольчик в шапке.
 *
 * Одна кнопка на всё приложение: открывает историю уведомлений. Счётчика
 * непрочитанных нет — новое уведомление и так всплывает на весь экран.
 * Если провайдера нет (экран входа, установка, согласия), компонент молча
 * ничего не рисует — шапки там всё равно нет.
 */

import { Bell } from 'lucide-react';

import { haptic } from '@/lib/env';
import { useNotifications } from './NotificationsProvider';

export function NotificationBell() {
  const notifications = useNotifications();
  if (!notifications) return null;

  const { openHub } = notifications;

  return (
    <button
      type="button"
      aria-label="Уведомления"
      onClick={() => {
        haptic('light');
        openHub();
      }}
      className="pressable relative rounded-full p-2 active:pressable-active"
      style={{ color: 'var(--accent)' }}
    >
      <Bell size={19} aria-hidden />
    </button>
  );
}
