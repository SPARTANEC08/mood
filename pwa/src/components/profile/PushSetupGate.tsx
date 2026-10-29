/**
 * Ежедневное напоминание включить push.
 *
 * Telegram-уведомлений больше нет, а push есть далеко не у всех, поэтому
 * приложение само предлагает включить его при входе:
 *   - раз в день, пока разрешение не выдано;
 *   - раз в неделю, если человек запретил уведомления в браузере;
 *   - на iOS без установки — инструкция «на экран Домой»;
 *   - если push выключен вручную в настройках — не дёргаем.
 *
 * Полноэкранно, но с «Позже»: напоминание не должно мешать пользоваться
 * приложением. Включить и выключить можно в любой момент в настройках.
 */

import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';

import { api } from '@/lib/api';
import { PushHelpSheet } from '@/components/profile/PushHelpSheet';
import { PushConsentSheet } from '@/components/legal/PushConsentSheet';
import { haptic } from '@/lib/env';
import { enablePush, pushPermission, pushSupport, syncPush } from '@/lib/push';
import type { BootstrapProfile } from '@/types/api';

const SHOWN_KEY = 'mood_push_gate_shown';
const DENIED_KEY = 'mood_push_gate_denied_at';
const DENIED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Дата по Москве: «сегодня» должно совпадать у всех, независимо от TZ. */
function mskToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Приватный режим: напоминание просто покажется снова.
  }
}

type GateMode = 'ready' | 'ios' | 'denied';

export function PushSetupGate({
  profile,
  pushConsentAccepted = false,
}: {
  profile: BootstrapProfile;
  pushConsentAccepted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentOk, setConsentOk] = useState(pushConsentAccepted);
  const [mode, setMode] = useState<GateMode>('ready');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConsentOk(pushConsentAccepted);
  }, [pushConsentAccepted]);

  useEffect(() => {
    if (profile.isGuest) return;
    if (profile.pushEnabled === false) return;
    if ((profile.pushDevices ?? 0) > 0) return;

    const support = pushSupport();
    if (support === 'unsupported') return;

    const permission = pushPermission();

    // Разрешение уже есть — просто восстанавливаем подписку, без плашки.
    if (permission === 'granted') {
      if (!consentOk) {
        setMode('ready');
        setOpen(true);
        return;
      }
      void syncPush();
      return;
    }

    if (permission === 'denied') {
      const last = Number(readStorage(DENIED_KEY) ?? 0);
      if (Date.now() - last < DENIED_RETRY_MS) return;

      writeStorage(DENIED_KEY, String(Date.now()));
      setMode('denied');
      setOpen(true);
      return;
    }

    const today = mskToday();
    if (readStorage(SHOWN_KEY) === today) return;

    writeStorage(SHOWN_KEY, today);
    setMode(support === 'ios-not-installed' ? 'ios' : 'ready');
    setOpen(true);
  }, [profile, consentOk]);

  if (!open) return null;

  // Запрет в браузере или iOS без установки — показываем подробную инструкцию
  // с кнопкой поддержки, а не краткий текст.
  if (mode !== 'ready') {
    return <PushHelpSheet kind={mode} onClose={() => setOpen(false)} />;
  }

  async function turnOn(force = false): Promise<void> {
    if (busy) return;

    if (!force && !consentOk) {
      setConsentOpen(true);
      return;
    }

    setBusy(true);
    haptic('medium');

    try {
      const granted = await enablePush();

      if (granted) {
        await api.toggleNotifications(true);
        setOpen(false);
        return;
      }

      if (pushPermission() === 'denied') {
        setMode('denied');
        writeStorage(DENIED_KEY, String(Date.now()));
      }
    } catch {
      // Сервер не ответил — плашка останется, попробует ещё раз.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-5">
      <div className="surface w-full max-w-[380px] rounded-[20px] px-5 py-5">
        <span
          className="flex h-11 w-11 items-center justify-center rounded-full"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <BellRing size={22} />
        </span>

        <h2 className="mt-3 text-[19px] font-semibold leading-tight">Включите уведомления</h2>

        <p className="mt-2 text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Оценки, письма, приказы и стипендия теперь приходят только в приложение.
          Разрешите уведомления, чтобы не пропустить их.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Включить или выключить можно в любой момент: Кабинет → Настройки приложения →
          Push-уведомления.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold active:pressable-active"
            style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
          >
            Позже
          </button>
          <button
            type="button"
            onClick={() => void turnOn()}
            disabled={busy}
            className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? 'Включаем…' : 'Включить'}
          </button>
        </div>
      </div>
      </div>
      <PushConsentSheet
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        onAccepted={() => {
          setConsentOpen(false);
          setConsentOk(true);
          void turnOn(true);
        }}
      />
    </>
  );
}
