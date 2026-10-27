/**
 * Полное удаление аккаунта.
 *
 * В финальном макете это маленькая ссылка в подвале, а не отдельный блок:
 * аккаунт не должен отвлекать. Опасность закрыта вторым барьером — вводом
 * слова «УДАЛИТЬ»; сервер проверяет его ещё раз.
 */

import { useState } from 'react';

import { BottomSheet } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { clearPwaToken } from '@/auth';
import { haptic } from '@/lib/env';

const CONFIRMATION = 'УДАЛИТЬ';

export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmation.trim().toUpperCase() === CONFIRMATION;

  async function remove(): Promise<void> {
    if (!canDelete || busy) return;

    setBusy(true);
    setError(null);
    haptic('heavy');

    try {
      await api.deleteAccount();
      // Стираем токен, кэши и показываем экран входа. Сервер уже удалил
      // запись, поэтому старый токен всё равно перестал бы работать.
      clearPwaToken();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Не удалось удалить аккаунт. Проверьте связь и попробуйте ещё раз.',
      );
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          haptic('medium');
          setConfirmation('');
          setError(null);
          setOpen(true);
        }}
        className="pressable text-[12px] font-semibold active:pressable-active"
        style={{ color: 'var(--danger)' }}
      >
        Удалить аккаунт
      </button>

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        title="Удалить аккаунт?"
        closeLabel="Отмена"
        footer={
          <button
            type="button"
            disabled={!canDelete || busy}
            onClick={() => void remove()}
            className="pressable w-full rounded-[14px] px-4 py-3.5 text-[16px] font-semibold text-white active:pressable-active disabled:opacity-40"
            style={{ background: 'var(--danger)' }}
          >
            {busy ? 'Удаляем…' : 'Удалить навсегда'}
          </button>
        }
      >
        <div className="space-y-3">
          <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Это не «выйти». Будут удалены аккаунт и все связанные данные:
          </p>

          <ul className="space-y-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            <li>• профиль и сохранённый вход в БАРС;</li>
            <li>• привязка Telegram и настройки уведомлений;</li>
            <li>• файлы, задания и объявления, созданные вами;</li>
            <li>• отметки «Сделано» и история уведомлений;</li>
            <li>• участие в статистике приложения.</li>
          </ul>

          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--danger)' }}>
            Отменить это нельзя. При следующем входе создастся новая запись.
          </p>

          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">
              Введите «{CONFIRMATION}», чтобы подтвердить
            </span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={CONFIRMATION}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              className="w-full rounded-[12px] border px-3 py-3 text-[16px] font-semibold tracking-wide outline-none"
              style={{
                borderColor: 'var(--separator-soft)',
                background: 'var(--surface-grouped)',
                color: 'var(--text-primary)',
              }}
            />
          </label>

          {error ? (
            <p className="text-[13px] leading-snug" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}
        </div>
      </BottomSheet>
    </>
  );
}
