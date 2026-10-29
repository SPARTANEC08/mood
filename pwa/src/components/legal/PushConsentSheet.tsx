/**
 * Согласие на Web Push.
 *
 * Показывается до подписки: push уходит через сервис браузера (Google/FCM,
 * Apple, Mozilla), поэтому без отдельного согласия подписку не оформляем.
 */

import { useState } from 'react';

import { BottomSheet } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import { PUSH_DOCUMENT } from '@/legal';

export function PushConsentSheet({
  open,
  onClose,
  onAccepted,
  zIndex,
}: {
  open: boolean;
  onClose: () => void;
  onAccepted: () => void;
  zIndex?: number;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept(): Promise<void> {
    if (!checked || busy) return;

    setBusy(true);
    setError(null);
    haptic('medium');

    try {
      await api.acceptConsents(['push']);
      onAccepted();
      onClose();
    } catch {
      setError('Не удалось сохранить согласие. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Push-уведомления"
      zIndex={zIndex}
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!checked || busy}
            onClick={() => void accept()}
            className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] py-3 text-[16px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Сохраняем…' : 'Согласен и включить'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="pressable pressable-active w-full rounded-[14px] py-3 text-[15px] font-semibold text-[var(--text-secondary)] disabled:opacity-40"
            style={{ background: 'var(--surface-grouped)' }}
          >
            Позже
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-[14px] leading-relaxed text-[var(--text-secondary)]">
        <p>
          В push уходит только тип события: новые оценки, письма, приказы или
          изменение стипендии. Баллы, темы писем и тексты приказов не передаются.
        </p>
        <p>
          Доставку выполняет push-сервис браузера (Google, Apple или Mozilla).
          Это иностранный сервис, поэтому нужно отдельное согласие.
        </p>

        <button
          type="button"
          onClick={() => openLink(PUSH_DOCUMENT.url)}
          className="text-left font-medium underline decoration-[var(--accent)] underline-offset-2"
          style={{ color: 'var(--accent)' }}
        >
          {PUSH_DOCUMENT.title}
        </button>

        <label className="flex items-start gap-3 pt-1">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-[13px] leading-snug">
            Я согласен(на) на передачу типа события в push-сервис браузера.
          </span>
        </label>

        {error ? (
          <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
