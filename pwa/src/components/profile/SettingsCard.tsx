/**
 * Настройки приложения в «Кабинете»: Telegram и тема.
 *
 * Одна карточка вместо двух отдельных секций: по финальному макету это один
 * смысловой блок. Логика Telegram осталась прежней (подключение, выключение,
 * перечитывание после возврата из бота), меняется только представление.
 */

import { useCallback, useEffect, useState } from 'react';
import { BellOff, Monitor, Send } from 'lucide-react';

import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import { useTheme, type ThemeMode } from '@/lib/theme';
import type { BootstrapProfile } from '@/types/api';

const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'mood_mpei_bot';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Системная' },
  { mode: 'light', label: 'Светлая' },
  { mode: 'dark', label: 'Тёмная' },
];

export function SettingsCard({ profile }: { profile: BootstrapProfile }) {
  const [telegramId, setTelegramId] = useState<number | null>(profile.telegramId ?? null);
  const [enabled, setEnabled] = useState<boolean>(profile.notificationsEnabled !== false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useTheme();

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
      // Оставляем последнее известное состояние: это переключатель, а не
      // источник правды, и выдумывать значение при ошибке сети незачем.
    }
  }, []);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  async function toggleTelegram(): Promise<void> {
    if (busy) return;

    setBusy(true);
    haptic('medium');
    const next = !enabled;

    try {
      await api.toggleNotifications(next);
      setEnabled(next);
      await reload();
    } catch {
      setEnabled(enabled);
    } finally {
      setBusy(false);
    }
  }

  const linked = typeof telegramId === 'number';
  const themeLabel = THEME_OPTIONS.find((option) => option.mode === mode)?.label ?? 'Системная';

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          {linked && !enabled ? <BellOff size={18} /> : <Send size={18} />}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug">Уведомления в Telegram</p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {!linked
              ? 'Не подключён'
              : enabled
                ? 'Включены · подключён'
                : 'Выключены'}
          </p>
        </div>

        {linked ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Уведомления в Telegram"
            disabled={busy}
            onClick={() => void toggleTelegram()}
            className="pressable relative h-[25px] w-[42px] shrink-0 rounded-full transition-colors active:pressable-active disabled:opacity-50"
            style={{ background: enabled ? 'var(--accent)' : 'var(--separator)' }}
          >
            <span
              className="absolute left-[2px] top-[2px] h-[21px] w-[21px] rounded-full bg-white shadow-sm transition-transform duration-200"
              style={{ transform: enabled ? 'translateX(17px)' : 'translateX(0)' }}
            />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              haptic('medium');
              openLink(`https://t.me/${TELEGRAM_BOT_USERNAME}?start=${profile.userId}`);
            }}
            className="pressable shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium active:pressable-active"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            Подключить
          </button>
        )}
      </div>

      <div
        className="flex items-center gap-3 border-t px-4 py-3.5"
        style={{ borderColor: 'var(--separator-soft)' }}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <Monitor size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug">Тема</p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {themeLabel}
          </p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label="Тема оформления"
        className="mx-4 mb-3.5 flex gap-1 rounded-[11px] p-1"
        style={{ background: 'var(--surface-grouped)' }}
      >
        {THEME_OPTIONS.map((option) => {
          const active = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                haptic('light');
                setMode(option.mode);
              }}
              className="pressable flex-1 rounded-[8px] py-1.5 text-[11px] font-semibold active:pressable-active"
              style={{
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
