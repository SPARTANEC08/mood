/**
 * Одноразовое предложение включить push после установки приложения.
 *
 * Показывается только в установленной PWA и только пока разрешение не выдано
 * и не отклонено. Системное окно запрашивается по тапу: на iOS запрос вне
 * жеста молча игнорируется, и человек решил бы, что кнопка не работает.
 *
 * «Позже» запоминается навсегда: навязчивая плашка хуже, чем выключенные
 * уведомления. Включить вручную всегда можно в настройках.
 */

import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';

import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import { enablePush, isStandalone, pushPermission, pushSupport } from '@/lib/push';

const DISMISS_KEY = 'mood_push_prompt_dismissed';

export function PushPrompt() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Предложение имеет смысл только в установленном приложении: во вкладке
    // браузера человек ещё не решил, будет ли пользоваться Mood.
    if (!isStandalone()) return;
    if (pushSupport() !== 'ready') return;
    if (pushPermission() !== 'default') return;

    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      // Приватный режим: показываем, запомнить отказ не сможем.
    }

    setVisible(true);
  }, []);

  if (!visible) return null;

  function dismiss(): void {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Приватный режим — просто скрываем до следующего запуска.
    }
    setVisible(false);
  }

  async function turnOn(): Promise<void> {
    if (busy) return;

    setBusy(true);
    haptic('medium');

    try {
      const granted = await enablePush();

      if (granted) {
        await api.toggleNotifications(true, 'push');
        dismiss();
      } else if (pushPermission() === 'denied') {
        // Отказ в системном окне: повторно предлагать бессмысленно.
        dismiss();
      }
    } catch {
      // Сервер не ответил — плашка останется, человек попробует ещё раз.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <BellRing size={18} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug">Уведомления в приложении</p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            Новые оценки, письма и приказы — сразу на телефон, без Telegram.
          </p>

          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => void turnOn()}
              disabled={busy}
              className="pressable rounded-full px-3 py-1.5 text-[13px] font-medium active:pressable-active disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
            >
              {busy ? 'Включаем…' : 'Включить'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="pressable rounded-full px-3 py-1.5 text-[13px] font-medium active:pressable-active"
              style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}
            >
              Позже
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
