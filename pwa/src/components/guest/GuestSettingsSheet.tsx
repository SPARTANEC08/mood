/**
 * Настройки гостя: имя, группа и переход в полный вход.
 *
 * Отдельный лист, а не вкладка «Кабинет»: у гостя одна страница — расписание.
 * После сохранения группы расписание перезагружается, чтобы не показывать
 * пары старой группы.
 */

import { useState } from 'react';
import { ChevronRight, GitBranch, LogIn, LogOut, MessageCircle, Monitor, Moon, Send, Sun, type LucideIcon } from 'lucide-react';

import { GuestGroupField } from './GuestGroupField';
import { BottomSheet, Card } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import { useTheme, type ThemeMode } from '@/lib/theme';
import type { BootstrapProfile, GuestGroup } from '@/types/api';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: LucideIcon }> = [
  { mode: 'system', label: 'Системная', icon: Monitor },
  { mode: 'light', label: 'Светлая', icon: Sun },
  { mode: 'dark', label: 'Тёмная', icon: Moon },
];

export function GuestSettingsSheet({
  open,
  onClose,
  profile,
  onSaved,
  onExit,
}: {
  open: boolean;
  onClose: () => void;
  profile: BootstrapProfile;
  onSaved: (profile: BootstrapProfile) => void;
  onExit: () => void;
}) {
  const [name, setName] = useState(profile.fullName);
  const [group, setGroup] = useState<GuestGroup | null>(
    profile.groupId && profile.groupName
      ? { id: profile.groupId, label: profile.groupName, description: profile.faculty }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useTheme();

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

  /**
   * Выход из гостя: сервер удаляет запись, клиент стирает токен.
   *
   * 401/403 означают, что записи уже нет (токен истёк или её удалили с другого
   * устройства) — тогда выходим локально. Сеть и 5xx не считаем выходом: иначе
   * гость остался бы в базе, а человек думал бы, что профиль удалён.
   */
  async function exit(): Promise<void> {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      await api.guestExit();
    } catch (err: unknown) {
      const alreadyGone = err instanceof ApiError && (err.status === 401 || err.status === 403);
      if (!alreadyGone) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Не удалось выйти. Проверьте связь и попробуйте ещё раз.',
        );
        setBusy(false);
        return;
      }
    }

    haptic('medium');
    setBusy(false);
    onExit();
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

        <div className="space-y-1.5">
          <span className="px-1 text-[12px] font-medium text-[var(--text-secondary)]">Тема</span>
          <div
            role="radiogroup"
            aria-label="Тема оформления"
            className="flex gap-1 rounded-[12px] p-1"
            style={{ background: 'var(--surface-grouped)' }}
          >
            {THEME_OPTIONS.map(({ mode, label, icon: Icon }) => {
              const active = themeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  onClick={() => {
                    haptic('light');
                    setThemeMode(mode);
                  }}
                  className="pressable flex flex-1 items-center justify-center gap-1.5 rounded-[9px] py-2 text-[12px] font-medium active:pressable-active disabled:opacity-40"
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                  }}
                >
                  <Icon size={14} aria-hidden />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

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

        <div className="space-y-1.5">
          <span className="px-1 text-[12px] font-medium text-[var(--text-secondary)]">Контакты</span>
          <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/mood_mpei_sup');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <MessageCircle size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Поддержка</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@mood_mpei_sup</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/mood_mpei');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <Send size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Telegram-канал Mood</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@mood_mpei</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://github.com/SPARTANEC08/mood');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <GitBranch size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Исходный код</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">SPARTANEC08/mood</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>
          </Card>
        </div>

        <div className="space-y-1 border-t border-[var(--separator-soft)] pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void exit()}
            className="pressable pressable-active flex w-full items-center justify-center gap-2 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--accent)] disabled:opacity-40"
          >
            <LogIn size={16} aria-hidden />
            Войти в полный аккаунт
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void exit()}
            className="pressable pressable-active flex w-full items-center justify-center gap-2 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--danger)] disabled:opacity-40"
          >
            <LogOut size={16} aria-hidden />
            Выйти из гостевого режима
          </button>

          <p className="px-2 pt-1 text-center text-[11px] leading-snug text-[var(--text-tertiary)]">
            Гостевой профиль и его статистика будут удалены без возможности восстановления.
          </p>
        </div>
      </div>
    </BottomSheet>
  );
}
