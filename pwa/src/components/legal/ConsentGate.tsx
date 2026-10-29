/**
 * Блокирующий экран принятия обновлённых документов.
 *
 * Показывается уже вошедшему пользователю, у которого нет актуальных версий
 * согласий (например, после обновления текстов). Пока он не принят, приложение
 * не монтирует DataProvider и не запрашивает данные БАРС; сервер параллельно
 * отвечает на такие запросы 403 consent_required.
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import type { LegalDocId, LegalStatus } from '@/types/api';

export function ConsentGate({
  legal,
  onAccepted,
  onLogout,
}: {
  legal: LegalStatus;
  onAccepted: () => void;
  onLogout: () => void;
}) {
  const [checked, setChecked] = useState<Partial<Record<LegalDocId, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const documents = legal.documents.filter((document) =>
    legal.missing.includes(document.id),
  );

  const allAccepted =
    documents.length > 0 && documents.every((document) => checked[document.id]);

  async function submit(): Promise<void> {
    if (!allAccepted || busy) return;

    setBusy(true);
    setError(null);
    haptic('medium');

    try {
      await api.acceptConsents(documents.map((document) => document.id));
      onAccepted();
    } catch {
      setError('Не удалось сохранить согласие. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div
        className="mx-auto flex min-h-full w-full max-w-[480px] flex-col justify-center gap-5 px-6 py-10"
        style={{ paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: 'var(--accent-soft)' }}
          aria-hidden
        >
          <ShieldCheck size={26} style={{ color: 'var(--accent)' }} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Обновились условия</h1>
        <p className="text-[14px] leading-relaxed text-[var(--text-secondary)]">
          Чтобы продолжить пользоваться Mood, примите актуальные документы. Это один
          раз — дальше приложение работает как обычно.
        </p>
      </div>

      <div className="space-y-3 rounded-[16px] border border-[var(--separator-soft)] bg-[var(--surface)] p-4">
        {documents.map((document) => (
          <div key={document.id} className="space-y-1.5">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={!!checked[document.id]}
                onChange={(event) =>
                  setChecked((prev) => ({ ...prev, [document.id]: event.target.checked }))
                }
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
              />
              <span className="text-[14px] leading-snug">
                Я принимаю{' '}
                <button
                  type="button"
                  onClick={() => openLink(document.url)}
                  className="text-left font-medium underline decoration-[var(--accent)] underline-offset-2"
                  style={{ color: 'var(--accent)' }}
                >
                  {document.title}
                </button>{' '}
                <span className="text-[var(--text-tertiary)]">(версия {document.version})</span>
              </span>
            </label>
          </div>
        ))}

        <div className="border-t border-[var(--separator-soft)] pt-3">
          <button
            type="button"
            onClick={() => openLink(legal.policy.url)}
            className="text-left text-[13px] leading-snug underline decoration-[var(--separator-soft)] underline-offset-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            {legal.policy.title} (версия {legal.policy.version})
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
      ) : null}

      <button
        type="button"
        disabled={!allAccepted || busy}
        onClick={() => void submit()}
        className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white disabled:opacity-40"
      >
        {busy ? 'Сохраняем…' : 'Принять и продолжить'}
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={onLogout}
        className="pressable pressable-active w-full rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--text-tertiary)] disabled:opacity-40"
      >
        Выйти
      </button>
      </div>
    </div>
  );
}
