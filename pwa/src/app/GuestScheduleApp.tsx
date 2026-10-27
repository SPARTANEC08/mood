/**
 * Гостевая оболочка: одна страница расписания.
 *
 * Нижней навигации, колокольчика, добавления записей и Telegram-приглашения
 * здесь нет. Группа и имя меняются в настройках; полный вход — оттуда же.
 */

import { useState } from 'react';

import { SchedulePage } from '@/pages/SchedulePage';
import { GuestSettingsSheet } from '@/components/guest/GuestSettingsSheet';
import { DataProvider } from '@/lib/dataContext';
import { CACHE_KEYS } from '@/lib/data/tier1';
import { clearPwaToken } from '@/auth';
import type { BootstrapProfile, BootstrapResponse } from '@/types/api';

export function GuestScheduleApp({ bootstrap }: { bootstrap: BootstrapResponse }) {
  const [profile, setProfile] = useState<BootstrapProfile>(bootstrap.profile);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function handleSaved(next: BootstrapProfile): void {
    setSettingsOpen(false);

    // Смена группы: старый кэш расписания относится к другой группе. Убираем
    // его и перезагружаем приложение, чтобы DataProvider сразу взял новый кэш.
    if (next.groupId !== profile.groupId) {
      try {
        window.localStorage.removeItem(`${CACHE_KEYS.schedule}:${profile.userId}`);
      } catch {
        // Приватный режим — просто перезагрузимся без очистки.
      }
      setProfile(next);
      window.location.reload();
      return;
    }

    setProfile(next);
  }

  function handleLogin(): void {
    // clearPwaToken сам снимает гостевой флаг и будит App событием выхода.
    clearPwaToken();
  }

  return (
    <DataProvider bootstrap={{ profile }} guest>
      <SchedulePage guest onOpenSettings={() => setSettingsOpen(true)} />

      <GuestSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        profile={profile}
        onSaved={handleSaved}
        onLogin={handleLogin}
      />
    </DataProvider>
  );
}
