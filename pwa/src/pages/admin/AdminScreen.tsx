/**
 * Админка внутри PWA.
 *
 * Полноэкранный список разделов: статистика, рассылка, пользователи,
 * объявления, диагностика, обслуживание, администраторы. Вход — шестерёнка в
 * шапке «Кабинета», видимая только админу (сервер всё равно проверяет права
 * на каждом запросе).
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  BellRing,
  Brush,
  Megaphone,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { api } from '@/lib/api';
import { Card, ListGroup } from '@/components/ui';
import type { BootstrapProfile } from '@/types/api';
import { AdminAdmins } from './AdminAdmins';
import { AdminAnnouncements } from './AdminAnnouncements';
import { AdminBroadcast } from './AdminBroadcast';
import { AdminDiagnostics } from './AdminDiagnostics';
import { AdminMaintenance } from './AdminMaintenance';
import { AdminStats } from './AdminStats';
import { AdminUsers } from './AdminUsers';
import { AdminHeader, SectionRow, Toggle, errorText } from './shared';

export type AdminSection =
  | 'menu'
  | 'stats'
  | 'broadcast'
  | 'users'
  | 'announcements'
  | 'diagnostics'
  | 'maintenance'
  | 'admins';

export function AdminScreen({
  profile,
  initial = 'menu',
  onClose,
}: {
  profile: BootstrapProfile;
  initial?: AdminSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<AdminSection>(initial);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .adminRegistration()
      .then((state) => setRegistrationOpen(state.open))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function toggleRegistration(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);

    try {
      const state = await api.adminSetRegistration(next);
      setRegistrationOpen(state.open);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const backToMenu = () => setSection('menu');

  if (section === 'stats') return <AdminStats onBack={backToMenu} />;
  if (section === 'broadcast') return <AdminBroadcast onBack={backToMenu} />;
  if (section === 'users') return <AdminUsers onBack={backToMenu} />;
  if (section === 'announcements') return <AdminAnnouncements onBack={backToMenu} />;
  if (section === 'diagnostics') return <AdminDiagnostics onBack={backToMenu} />;
  if (section === 'maintenance') return <AdminMaintenance onBack={backToMenu} />;
  if (section === 'admins') return <AdminAdmins onBack={backToMenu} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Администрирование" onBack={onClose} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          <p className="px-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {profile.fullName}
          </p>

          <ListGroup>
            <SectionRow
              icon={BarChart3}
              title="Статистика"
              subtitle="Сегодня, вчера, неделя, месяц, дата"
              onClick={() => setSection('stats')}
            />
            <SectionRow
              icon={Megaphone}
              title="Рассылка"
              subtitle="Всем или лично · push, Telegram, лента"
              onClick={() => setSection('broadcast')}
            />
            <SectionRow
              icon={Users}
              title="Пользователи"
              subtitle="Поиск, карточка, сессии, удаление"
              onClick={() => setSection('users')}
            />
            <SectionRow
              icon={BellRing}
              title="Объявления"
              subtitle="Очередь в приложении"
              onClick={() => setSection('announcements')}
            />
            <SectionRow
              icon={Activity}
              title="Диагностика"
              subtitle="Сервисы, прогресс, журнал действий"
              onClick={() => setSection('diagnostics')}
            />
            <SectionRow
              icon={Brush}
              title="Обслуживание"
              subtitle="Уборка файлов и кэшей"
              onClick={() => setSection('maintenance')}
            />
            <SectionRow
              icon={ShieldCheck}
              title="Администраторы"
              subtitle="Env-админы и назначенные"
              onClick={() => setSection('admins')}
            />
            <SectionRow
              icon={BellRing}
              title="Регистрация"
              subtitle={
                registrationOpen === null
                  ? 'Загрузка…'
                  : registrationOpen
                    ? 'Открыта'
                    : 'Закрыта'
              }
              right={
                <Toggle
                  checked={registrationOpen === true}
                  onChange={(next) => void toggleRegistration(next)}
                  label="Регистрация"
                  disabled={registrationOpen === null || busy}
                />
              }
            />
          </ListGroup>

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
