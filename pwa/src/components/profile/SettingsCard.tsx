/**
 * Настройки приложения в «Кабинете»: push-уведомления и тема.
 *
 * Telegram из настроек убран: уведомления живут только в приложении. Флаг
 * pushEnabled и число устройств приходят с сервера, разрешение — из браузера.
 */

import { useCallback, useEffect, useState } from 'react';
import { BellOff, BellRing, Check, Monitor, Palette } from 'lucide-react';

import { Card } from '@/components/ui';
import { PushHelpSheet } from '@/components/profile/PushHelpSheet';
import { PushConsentSheet } from '@/components/legal/PushConsentSheet';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  contrastText,
  normalizeHex,
  useAccent,
} from '@/lib/accent';
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

export function SettingsCard({
  profile,
  pushConsentAccepted = false,
}: {
  profile: BootstrapProfile;
  pushConsentAccepted?: boolean;
}) {
  const [mode, setMode] = useTheme();
  const [accent, setAccent, resetAccent] = useAccent();

  /**
   * Черновик HEX-поля.
   *
   * Ввод идёт в состояние, а не сразу в localStorage: человек набирает «#7c4…»
   * по символу, и применять недописанный цвет нельзя. Как только строка стала
   * валидным цветом — применяем сразу, чтобы выбор был «живым».
   */
  const [hexDraft, setHexDraft] = useState(accent);
  const [hexValid, setHexValid] = useState(true);

  useEffect(() => {
    setHexDraft(accent);
    setHexValid(true);
  }, [accent]);

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

  const themeLabel = THEME_OPTIONS.find((option) => option.mode === mode)?.label ?? 'Системная';

  const accentPreset = ACCENT_PRESETS.find((preset) => preset.hex === accent);
  const accentLabel = accentPreset?.name ?? 'Свой цвет';
  /** Цвет не из палитры — значит выбран пипеткой/HEX-полем. */
  const customAccent = accentPreset === undefined;

  const pickAccent = (hex: string): void => {
    haptic('light');
    setAccent(hex);
  };

  const onHexChange = (value: string): void => {
    setHexDraft(value);
    const normalized = normalizeHex(value);
    setHexValid(normalized !== null);
    if (normalized) setAccent(normalized);
  };

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

      {/* ── Акцент ──────────────────────────────────────────────────────────
          Компактный блок: строка заголовка, один ряд кружков (все пресеты
          помещаются на любой ширине) и поле HEX. Никаких демо-карточек —
          цвет виден прямо на интерфейсе, как только его выбрали. */}
      <div
        className="flex items-center gap-3 border-t px-4 py-3.5"
        style={{ borderColor: 'var(--separator-soft)' }}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <Palette size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug">Акцент</p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {accentLabel}
          </p>
        </div>

        {accent === DEFAULT_ACCENT ? (
          <span
            className="h-5 w-5 shrink-0 rounded-full"
            style={{ background: accent, boxShadow: 'inset 0 0 0 1px var(--separator)' }}
            aria-hidden
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              haptic('light');
              resetAccent();
            }}
            className="pressable shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold active:pressable-active"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="mx-4 mb-3.5">
        <div
          role="radiogroup"
          aria-label="Акцентный цвет"
          className="flex items-center justify-between"
        >
          {ACCENT_PRESETS.map((preset) => {
            const active = preset.hex === accent;

            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={preset.name}
                title={preset.name}
                onClick={() => pickAccent(preset.hex)}
                className="pressable relative flex h-8 w-8 items-center justify-center rounded-full active:pressable-active"
                style={{
                  background: preset.hex,
                  boxShadow: active
                    ? `0 0 0 2px var(--surface), 0 0 0 3.5px ${preset.hex}`
                    : 'inset 0 0 0 1px var(--separator)',
                }}
              >
                {active ? (
                  <Check size={14} strokeWidth={3} style={{ color: contrastText(preset.hex) }} aria-hidden />
                ) : null}
              </button>
            );
          })}

          {/* Свой цвет: нативный пикер поверх кружка. Так работает и на iOS
              Safari, и на Android без собственной палитры. */}
          <label
            className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full"
            style={{
              background: 'var(--surface-grouped)',
              boxShadow: customAccent
                ? '0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent)'
                : 'inset 0 0 0 1px var(--separator)',
            }}
            title="Свой цвет"
          >
            <input
              type="color"
              value={accent}
              onChange={(event) => setAccent(event.target.value)}
              aria-label="Свой цвет"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            <Palette
              size={14}
              style={{ color: customAccent ? 'var(--accent)' : 'var(--text-secondary)' }}
              aria-hidden
            />
          </label>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <input
            type="text"
            value={hexDraft}
            onChange={(event) => onHexChange(event.target.value)}
            onBlur={() => {
              // Недописанный/битый ввод не применяем и возвращаем актуальный
              // цвет, чтобы поле не расходилось с реальным состоянием.
              if (hexValid) return;
              setHexDraft(accent);
              setHexValid(true);
            }}
            aria-label="Акцент, HEX"
            spellCheck={false}
            autoCapitalize="characters"
            autoComplete="off"
            className="w-[92px] rounded-[8px] border bg-[var(--surface)] px-2 py-1 text-[12px] tabular-nums outline-none"
            style={{
              borderColor: hexValid ? 'var(--separator-soft)' : 'var(--danger)',
              color: 'var(--text-primary)',
            }}
          />
          <span
            className="text-[11px]"
            style={{ color: hexValid ? 'var(--text-tertiary)' : 'var(--danger)' }}
          >
            {hexValid ? 'HEX' : 'Формат #RRGGBB'}
          </span>
        </div>
      </div>

      {helpKind ? <PushHelpSheet kind={helpKind} onClose={() => setHelpKind(null)} /> : null}
    </Card>

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
