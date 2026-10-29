/**
 * Вход гостем: группа и имя, без БАРС.
 *
 * Экран намеренно короткий: два поля и одна кнопка. Всё, что человек вводит,
 * уходит только на сервер Mood; пароль не спрашивается.
 */

import { useState } from 'react';
import { ArrowLeft, CalendarDays } from 'lucide-react';

import { GuestGroupField } from './GuestGroupField';
import { ApiError, api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import { GUEST_DOCUMENTS, POLICY_LINK } from '@/legal';
import type { PwaTokenResponse } from '@/auth';
import type { GuestGroup, LegalDocId } from '@/types/api';

export function GuestOnboarding({
  onDone,
  onBack,
  registrationOpen,
}: {
  onDone: (issued: PwaTokenResponse) => void;
  onBack: () => void;
  /** null — конфиг ещё не пришёл; false — регистрация закрыта. */
  registrationOpen: boolean | null;
}) {
  const [group, setGroup] = useState<GuestGroup | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Partial<Record<LegalDocId, boolean>>>({});

  const allAccepted = GUEST_DOCUMENTS.every((document) => accepted[document.id]);
  const canSubmit = group !== null && name.trim().length > 0 && allAccepted && !busy;

  async function submit(): Promise<void> {
    if (!canSubmit || !group) return;

    setBusy(true);
    setError(null);

    try {
      const issued = await api.guestSession({
        groupId: group.id,
        groupName: group.label,
        faculty: group.description,
        displayName: name.trim(),
        consents: GUEST_DOCUMENTS.filter((document) => accepted[document.id]).map(
          (document) => document.id,
        ),
      });
      haptic('medium');
      onDone(issued);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Не удалось открыть расписание.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center gap-6 px-6 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <img
          src="/icons/site-icon-192.png?v=2"
          width={64}
          height={64}
          alt=""
          className="rounded-[16px]"
        />
        <h1 className="text-[22px] font-semibold">Расписание без входа</h1>
        <p className="text-[14px] leading-snug text-[var(--text-secondary)]">
          Выберите группу и имя. Будет только расписание — без БАРС, оценок, ДЗ,
          почты и уведомлений.
        </p>
      </div>

      {registrationOpen === false ? (
        <div
          className="rounded-[14px] border px-4 py-4 text-center"
          style={{ borderColor: 'var(--separator-soft)', background: 'var(--surface)' }}
        >
          <p className="text-[14px] leading-relaxed text-[var(--text-secondary)]">
            Регистрация новых аккаунтов временно закрыта. Гостевой вход тоже
            недоступен — попробуйте позже или войдите в существующий аккаунт.
          </p>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <GuestGroupField value={group} onChange={setGroup} disabled={busy} />

          <div className="space-y-1.5">
            <label
              className="px-1 text-[12px] font-medium text-[var(--text-secondary)]"
              htmlFor="guest-name"
            >
              Как вас называть
            </label>
            <input
              id="guest-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              disabled={busy}
              autoComplete="nickname"
              placeholder="Имя или псевдоним"
              className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
            />
          </div>

          <div className="space-y-3 rounded-[16px] border border-[var(--separator-soft)] bg-[var(--surface)] p-4">
            <p className="text-[13px] leading-snug text-[var(--text-secondary)]">
              Для гостевого режима примите документы. Галочки не проставлены заранее.
            </p>

            {GUEST_DOCUMENTS.map((document) => (
              <label key={document.id} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={!!accepted[document.id]}
                  onChange={(event) =>
                    setAccepted((prev) => ({ ...prev, [document.id]: event.target.checked }))
                  }
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                />
                <span className="text-[13px] leading-snug">
                  Я принимаю{' '}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openLink(document.url);
                    }}
                    className="text-left font-medium underline decoration-[var(--accent)] underline-offset-2"
                    style={{ color: 'var(--accent)' }}
                  >
                    {document.title}
                  </button>
                </span>
              </label>
            ))}

            <button
              type="button"
              onClick={() => openLink(POLICY_LINK.url)}
              className="text-left text-[12px] leading-snug underline decoration-[var(--separator-soft)] underline-offset-2"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {POLICY_LINK.title}
            </button>
          </div>

          {error ? (
            <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className="pressable pressable-active flex w-full items-center justify-center gap-2 rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white disabled:opacity-40"
          >
            <CalendarDays size={18} aria-hidden />
            {busy ? 'Открываем…' : 'Продолжить'}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={onBack}
        className="pressable pressable-active flex w-full items-center justify-center gap-1.5 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--text-secondary)]"
      >
        <ArrowLeft size={15} aria-hidden />
        Войти в аккаунт
      </button>

      <p className="text-center text-[12px] leading-snug text-[var(--text-tertiary)]">
        Имя и группа нужны только для статистики и показа расписания. Пароль не
        запрашивается.
      </p>
    </div>
  );
}
