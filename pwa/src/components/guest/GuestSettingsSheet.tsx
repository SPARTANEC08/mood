/**
 * Настройки гостя: имя, группа и переход в полный вход.
 *
 * Отдельный лист, а не вкладка «Кабинет»: у гостя одна страница — расписание.
 * После сохранения группы расписание перезагружается, чтобы не показывать
 * пары старой группы.
 */

import { useState } from 'react';
import { LogIn } from 'lucide-react';

import { GuestGroupField } from './GuestGroupField';
import { BottomSheet } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { BootstrapProfile, GuestGroup } from '@/types/api';

export function GuestSettingsSheet({
  open,
  onClose,
  profile,
  onSaved,
  onLogin,
}: {
  open: boolean;
  onClose: () => void;
  profile: BootstrapProfile;
  onSaved: (profile: BootstrapProfile) => void;
  onLogin: () => void;
}) {
  const [name, setName] = useState(profile.fullName);
  const [group, setGroup] = useState<GuestGroup | null>(
    profile.groupId && profile.groupName
      ? { id: profile.groupId, label: profile.groupName, description: profile.faculty }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (busy || !group || !name.trim()) return;

    setBusy(true);
    setError(null);

    try {
      const result = await api.guestUpdateProfile({
        displayName: name.trim(),
        groupId: group.id,
        groupName: group.label,
        faculty: group.description,
      });
      haptic('medium');
      onSaved(result.profile);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить настройки.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Настройки гостя"
      closeLabel="Закрыть"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label
            className="px-1 text-[12px] font-medium text-[var(--text-secondary)]"
            htmlFor="guest-settings-name"
          >
            Имя или псевдоним
          </label>
          <input
            id="guest-settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            disabled={busy}
            className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
          />
        </div>

        <GuestGroupField value={group} onChange={setGroup} disabled={busy} />

        {error ? (
          <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
        ) : null}

        <button
          type="button"
          disabled={busy || !group || !name.trim()}
          onClick={() => void save()}
          className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] px-4 py-3 text-[15px] font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>

        <div className="border-t border-[var(--separator-soft)] pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={onLogin}
            className="pressable pressable-active flex w-full items-center justify-center gap-2 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--accent)] disabled:opacity-40"
          >
            <LogIn size={16} aria-hidden />
            Войти в полный аккаунт
          </button>
          <p className="mt-2 px-2 text-center text-[11px] leading-snug text-[var(--text-tertiary)]">
            Гостевой профиль и его статистика останутся отдельными.
          </p>
        </div>
      </div>
    </BottomSheet>
  );
}
