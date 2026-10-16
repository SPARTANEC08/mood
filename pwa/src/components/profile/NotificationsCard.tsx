/**
 * Карточка уведомлений в Telegram.
 *
 * Бот после рефакторинга умеет ровно три вещи: показать ссылку на приложение,
 * принять `/start <userId>` и выключить уведомления. Всё остальное — здесь.
 *
 * Состояние берётся из профиля, а после любого изменения перечитывается
 * отдельным лёгким запросом: bootstrap ради одного поля ходит в БАРС и IMAP, а
 * перечитывание после возврата из бота обязано быть дешёвым — иначе человек
 * увидит «выключено», хотя он только что нажал «включить» там.
 */

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import type { BootstrapProfile } from '@/types/api';

/**
 * Имя бота для deep link вида `t.me/<bot>?start=<userId>`.
 *
 * Значение задаётся переменной сборки `VITE_TELEGRAM_BOT_USERNAME`, чтобы при
 * смене бота не пришлось править исходник: пока переменная не задана,
 * используется бот по умолчанию — кнопка не должна исчезать из-за .env.
 */
const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'hub_mpei_bot';

export function NotificationsCard({ profile }: { profile: BootstrapProfile }) {
  const [telegramId, setTelegramId] = useState<number | null>(profile.telegramId ?? null);
  const [enabled, setEnabled] = useState<boolean>(profile.notificationsEnabled !== false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTelegramId(profile.telegramId ?? null);
    setEnabled(profile.notificationsEnabled !== false);
  }, [profile.telegramId, profile.notificationsEnabled]);

  const reload = useCallback(async () => {
    try {
      const state = await api.notificationsState();
      setTelegramId(state.telegramId);
      setEnabled(state.notificationsEnabled);
    } catch {
      // Состояние останется прежним: это кнопка, а не источник правды, и
      // подменять его выдумкой при ошибке сети незачем.
    }
  }, []);

  // Возврат из Telegram — самый частый повод состояние устареть: человек был
  // в боте, нажал «подключить» или «выключить», вернулся сюда.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  async function toggle() {
    if (busy) return;

    setBusy(true);
    haptic('medium');

    const next = !enabled;

    try {
      await api.toggleNotifications(next);
      setEnabled(next);
      await reload();
    } catch {
      // Откатываем на то, что было: показать переключатель в состоянии, на
      // которое сервер не согласился, хуже, чем показать ошибку молча.
      setEnabled(enabled);
    } finally {
      setBusy(false);
    }
  }

  const linked = telegramId !== null && telegramId !== undefined;
  const disabled = linked && !enabled;

  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {disabled ? (
            <BellOff size={20} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          ) : (
            <Bell size={20} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
          )}
          <span className="min-w-0 text-[15px] font-medium">
            {disabled ? 'Уведомления выключены' : 'Уведомления в Telegram'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            if (linked) {
              void toggle();
              return;
            }

            haptic('medium');
            openLink(`https://t.me/${TELEGRAM_BOT_USERNAME}?start=${profile.userId}`);
          }}
          disabled={linked && busy}
          className="pressable shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium active:pressable-active disabled:opacity-40"
          style={{ background: 'var(--surface-2)', color: 'var(--accent)' }}
        >
          {busy ? 'Сохраняем…' : !linked ? 'Подключить' : enabled ? 'Выключить' : 'Включить'}
        </button>
      </div>
    </Card>
  );
}
