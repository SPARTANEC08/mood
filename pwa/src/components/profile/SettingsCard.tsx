/**
 * Настройки приложения в «Кабинете»: push-уведомления и тема.
 *
 * Telegram из настроек убран: уведомления живут только в приложении. Флаг
 * pushEnabled и число устройств приходят с сервера, разрешение — из браузера.
 */

import { useCallback, useEffect, useState } from 'react';
import { BellOff, BellRing, Monitor } from 'lucide-react';

import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import { enablePush, pushPermission, pushSupport, syncPush } from '@/lib/push';
import { useTheme, type ThemeMode } from '@/lib/theme';
import type { BootstrapProfile } from '@/types/api';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Системная' },
  { mode: 'light', label: 'Светлая' },
  { mode: 'dark', label: 'Тёмная' },
];

export function SettingsCard({ profile }: { profile: BootstrapProfile }) {
  const [mode, setMode] = useTheme();

  const [pushEnabled, setPushEnabled] = useState<boolean>(profile.pushEnabled !== false);
  const [pushDevices, setPushDevices] = useState<number>(profile.pushDevices ?? 0);
  const [pushBusy, setPushBusy] = useState(false);
  const pushSupportState = pushSupport();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    pushPermission(),
  );

  useEffect(() => {
    setPushEnabled(profile.pushEnabled !== false);
    setPushDevices(profile.pushDevices ?? 0);
  }, [profile.pushEnabled, profile.pushDevices]);

  const reload = useCallback(async () => {
    try {
      const state = await api.notificationsState();
      setPushEnabled(state.pushEnabled);
      setPushDevices(state.pushDevices);
    } catch {
      // Оставляем последнее известное состояние: это переключатель, а не
      // источник правды, и выдумывать значение при ошибке сети незачем.
    }
  }, []);

  /*
   * Разрешение уже выдано — значит подписка должна существовать. После
   * переустановки PWA или чистки данных сайта в браузере появляется новый
   * endpoint, и без синхронизации сервер слал бы в мёртвый адрес.
   */
  useEffect(() => {
    let cancelled = false;

    if (pushSupport() !== 'ready' || pushPermission() !== 'granted') return;

    void syncPush().then((result) => {
      if (!cancelled && result.subscribed) void reload();
    });

    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  async function togglePush(): Promise<void> {
    if (pushBusy) return;

    setPushBusy(true);
    haptic('medium');

    try {
      if (pushEnabled) {
        // Выключение — только флаг на сервере: подписка остаётся, чтобы
        // включение обратно не требовало нового системного разрешения.
        await api.toggleNotifications(false);
        setPushEnabled(false);
      } else {
        const granted = await enablePush();
        setPermission(pushPermission());

        if (!granted) return;

        await api.toggleNotifications(true);
        setPushEnabled(true);
      }

      const state = await api.pushState();
      setPushDevices(state.devices);
    } catch {
      // Сервер не подтвердил изменение — оставляем прежнее состояние.
    } finally {
      setPushBusy(false);
    }
  }

  const pushSubtitle = (() => {
    if (pushSupportState === 'unsupported') return 'Не поддерживается браузером';
    if (pushSupportState === 'ios-not-installed') return 'Добавьте приложение на экран «Домой»';
    if (permission === 'denied') return 'Запрещены в настройках браузера';
    if (pushEnabled && pushDevices > 0) {
      return pushDevices > 1 ? `Включены · ${pushDevices} устройств` : 'Включены';
    }
    return 'Выключены';
  })();

  const pushAvailable =
    pushSupportState === 'ready' && permission !== 'denied' && permission !== 'unsupported';

  const themeLabel = THEME_OPTIONS.find((option) => option.mode === mode)?.label ?? 'Системная';

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{
            background: 'var(--accent-soft)',
            color: pushEnabled && pushDevices > 0 ? 'var(--accent)' : 'var(--text-tertiary)',
          }}
          aria-hidden
        >
          {pushEnabled && pushDevices > 0 ? <BellRing size={18} /> : <BellOff size={18} />}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug">Push-уведомления</p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {pushSubtitle}
          </p>
        </div>

        {pushAvailable ? (
          pushEnabled && pushDevices > 0 ? (
            <button
              type="button"
              role="switch"
              aria-checked={pushEnabled}
              aria-label="Push-уведомления"
              disabled={pushBusy}
              onClick={() => void togglePush()}
              className="pressable relative h-[25px] w-[42px] shrink-0 rounded-full transition-colors active:pressable-active disabled:opacity-50"
              style={{ background: pushEnabled ? 'var(--accent)' : 'var(--separator)' }}
            >
              <span
                className="absolute left-[2px] top-[2px] h-[21px] w-[21px] rounded-full bg-white shadow-sm transition-transform duration-200"
                style={{ transform: pushEnabled ? 'translateX(17px)' : 'translateX(0)' }}
              />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void togglePush()}
              disabled={pushBusy}
              className="pressable shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium active:pressable-active disabled:opacity-50"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {pushBusy ? 'Включаем…' : 'Включить'}
            </button>
          )
        ) : null}
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
