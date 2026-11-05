/**
 * Настройки приложения в «Кабинете»: push-уведомления и тема.
 *
 * Telegram из настроек убран: уведомления живут только в приложении. Флаг
 * pushEnabled и число устройств приходят с сервера, разрешение — из браузера.
 */

import { useCallback, useEffect, useState } from 'react';
import { BellOff, BellRing, ChevronRight, Palette } from 'lucide-react';

import { Card } from '@/components/ui';
import { PushHelpSheet } from '@/components/profile/PushHelpSheet';
import { ThemeSheet } from '@/components/profile/ThemeSheet';
import { PushConsentSheet } from '@/components/legal/PushConsentSheet';
import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import { enablePush, pushPermission, pushSupport, syncPush } from '@/lib/push';
import { useTheme, useThemePreset, type ThemeMode } from '@/lib/theme';
import type { BootstrapProfile } from '@/types/api';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Системная' },
  { mode: 'light', label: 'Светлая' },
  { mode: 'dark', label: 'Тёмная' },
];

export function SettingsCard({
  profile,
  pushConsentAccepted = false,
}: {
  profile: BootstrapProfile;
  pushConsentAccepted?: boolean;
}) {
  const [mode, setMode] = useTheme();
  const { theme, availableModes, effective } = useThemePreset();
  const [themeSheetOpen, setThemeSheetOpen] = useState(false);

  const [pushEnabled, setPushEnabled] = useState<boolean>(profile.pushEnabled !== false);
  const [pushDevices, setPushDevices] = useState<number>(profile.pushDevices ?? 0);
  const [pushBusy, setPushBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentOk, setConsentOk] = useState(pushConsentAccepted);
  const [helpKind, setHelpKind] = useState<'denied' | 'ios' | null>(null);
  const pushSupportState = pushSupport();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    pushPermission(),
  );

  useEffect(() => {
    setPushEnabled(profile.pushEnabled !== false);
    setPushDevices(profile.pushDevices ?? 0);
  }, [profile.pushEnabled, profile.pushDevices]);

  useEffect(() => {
    setConsentOk(pushConsentAccepted);
  }, [pushConsentAccepted]);

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

  async function togglePush(force = false): Promise<void> {
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
        if (!force && !consentOk) {
          setConsentOpen(true);
          setPushBusy(false);
          return;
        }

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

  /*
   * Проблема, которую человек может исправить сам: запрет в браузере или
   * неустановленная PWA на iOS. Только в этих случаях показываем кнопку
   * «Инструкция» вместо переключателя.
   */
  const pushProblem: 'denied' | 'ios' | null =
    permission === 'denied'
      ? 'denied'
      : pushSupportState === 'ios-not-installed'
        ? 'ios'
        : null;

  const themeLabel = theme.name;
  const displayMode: ThemeMode = availableModes.includes(mode) ? mode : effective;
  const singleVariantHint = !theme.variants.light
    ? 'В этой теме только тёмная версия'
    : !theme.variants.dark
      ? 'В этой теме только светлая версия'
      : null;

  return (
    <>
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
        ) : pushProblem ? (
          <button
            type="button"
            onClick={() => {
              haptic('light');
              setHelpKind(pushProblem);
            }}
            className="pressable shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold active:pressable-active"
            style={{ background: 'rgba(255,149,0,0.14)', color: 'var(--warning)' }}
          >
            Инструкция
          </button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => {
          haptic('light');
          setThemeSheetOpen(true);
        }}
        className="pressable flex w-full items-center gap-3 border-t px-4 py-3.5 text-left active:pressable-active"
        style={{ borderColor: 'var(--separator-soft)' }}
        aria-label="Открыть все темы"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <Palette size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-snug">Тема</span>
          <span
            className="mt-0.5 block truncate text-[12px] leading-snug"
            style={{ color: 'var(--text-secondary)' }}
          >
            {themeLabel}
          </span>
        </span>
        <span
          className="flex shrink-0 items-center gap-0.5 text-[13px] font-semibold"
          style={{ color: 'var(--accent)' }}
        >
          Все темы
          <ChevronRight size={15} aria-hidden />
        </span>
      </button>

      <div
        role="radiogroup"
        aria-label="Тема оформления"
        className="mx-4 mb-1 flex gap-1 rounded-[11px] p-1"
        style={{ background: 'var(--surface-grouped)' }}
      >
        {THEME_OPTIONS.map((option) => {
          const available = availableModes.includes(option.mode);
          const active = displayMode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!available}
              onClick={() => {
                if (!available) return;
                haptic('light');
                setMode(option.mode);
              }}
              className="pressable flex-1 rounded-[8px] py-1.5 text-[11px] font-semibold active:pressable-active disabled:cursor-default disabled:opacity-40"
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

      {singleVariantHint ? (
        <p className="mx-4 mb-3.5 text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
          {singleVariantHint}
        </p>
      ) : (
        <div className="mb-3.5" />
      )}

      {helpKind ? <PushHelpSheet kind={helpKind} onClose={() => setHelpKind(null)} /> : null}
    </Card>

    <ThemeSheet open={themeSheetOpen} onClose={() => setThemeSheetOpen(false)} />

    <PushConsentSheet
      open={consentOpen}
      onClose={() => setConsentOpen(false)}
      onAccepted={() => {
        setConsentOpen(false);
        setConsentOk(true);
        void togglePush(true);
      }}
    />
    </>
  );
}
