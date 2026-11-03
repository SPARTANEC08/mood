/**
 * Админка внутри PWA: мобильный дашборд и группы разделов.
 *
 * Сверху — четыре живые цифры и быстрые действия, ниже — «Обзор», «Люди»,
 * «Сообщения», «Система». Доступ к управлению админами и системным настройкам
 * показываем только основному админу; сервер всё равно проверяет права.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Brush,
  Gauge,
  Lock,
  Megaphone,
  ShieldCheck,
  Users,
  Wifi,
} from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminStatsResponse, BootstrapProfile } from '@/types/api';
import { AdminAdmins } from './AdminAdmins';
import { AdminDiagnostics } from './AdminDiagnostics';
import { AdminMaintenance } from './AdminMaintenance';
import { AdminMessages } from './AdminMessages';
import { AdminStats } from './AdminStats';
import { AdminUsers } from './AdminUsers';
import { AdminHeader, SectionRow, StatCard, Toggle, errorText } from './shared';

export type AdminSection =
  | 'menu'
  | 'stats'
  | 'messages'
  | 'users'
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
  const [today, setToday] = useState<AdminStatsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnvAdmin = profile.isEnvAdmin === true;

  useEffect(() => {
    void Promise.all([
      api.adminRegistration().then((state) => setRegistrationOpen(state.open)),
      api.adminStats({ period: 'today' }).then(setToday),
    ]).catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function toggleRegistration(next: boolean): Promise<void> {
    if (busy || !isEnvAdmin) return;
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
  if (section === 'messages') return <AdminMessages onBack={backToMenu} />;
  if (section === 'users') return <AdminUsers onBack={backToMenu} />;
  if (section === 'diagnostics') return <AdminDiagnostics onBack={backToMenu} isEnvAdmin={isEnvAdmin} />;
  if (section === 'maintenance') return <AdminMaintenance onBack={backToMenu} />;
  if (section === 'admins') return <AdminAdmins onBack={backToMenu} profile={profile} />;

  const active = today?.live?.today?.active;
  const online = today?.live?.current?.online ?? 0;
  const bars = today?.live?.current?.barsSessions ?? 0;
  const visits = today?.live?.today?.visits ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader
        title="Админка"
        onBack={onClose}
        right={
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            {isEnvAdmin ? 'Основной' : 'Админ'}
          </span>
        }
      />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-4 px-4 pb-8 pt-1">
          <Card className="px-4 py-3.5">
            <p className="text-[15px] font-semibold leading-tight">{profile.fullName}</p>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {profile.groupName || 'без группы'} · {isEnvAdmin ? 'полный доступ' : 'без управления админами'}
            </p>
          </Card>

          <div className="grid grid-cols-2 gap-2">
            <StatCard
              label="Активных сегодня"
              value={active ? active.total : '—'}
              hint={active ? `${active.users} с БАРС · ${active.guests} гостей` : 'считаем…'}
              tone="success"
            />
            <StatCard label="Онлайн" value={online} hint="±5 минут" />
            <StatCard label="Сессии БАРС" value={bars} hint="активные входы" />
            <StatCard label="Открытий" value={visits} hint="заходы в приложение" />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Написать', icon: Megaphone, go: 'messages' as const },
              { label: 'Люди', icon: Users, go: 'users' as const },
              { label: 'Графики', icon: BarChart3, go: 'stats' as const },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setSection(item.go)}
                  className="pressable flex flex-col items-center gap-1.5 rounded-[14px] px-2 py-3 text-[12px] font-semibold active:pressable-active"
                  style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
                >
                  <Icon size={18} style={{ color: 'var(--accent)' }} aria-hidden />
                  {item.label}
                </button>
              );
            })}
          </div>

          <section className="space-y-2">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Обзор
            </h2>
            <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
              <SectionRow
                icon={BarChart3}
                title="Статистика"
                subtitle="Активные, открытия, сессии, история"
                onClick={() => setSection('stats')}
              />
              <SectionRow
                icon={Activity}
                title="Диагностика"
                subtitle="Сервисы, память, журнал действий"
                onClick={() => setSection('diagnostics')}
              />
            </Card>
          </section>

          <section className="space-y-2">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Люди
            </h2>
            <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
              <SectionRow
                icon={Users}
                title="Пользователи"
                subtitle="Поиск, фильтры, сессии, удаление"
                onClick={() => setSection('users')}
              />
              <SectionRow
                icon={ShieldCheck}
                title="Администраторы"
                subtitle={isEnvAdmin ? 'Состав и роли' : 'Только просмотр'}
                onClick={() => setSection('admins')}
              />
            </Card>
          </section>

          <section className="space-y-2">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Сообщения
            </h2>
            <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
              <SectionRow
                icon={Megaphone}
                title="Сообщения"
                subtitle="Лента и push · всем или лично"
                onClick={() => setSection('messages')}
              />
            </Card>
          </section>

          <section className="space-y-2">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Система
            </h2>
            <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
              <SectionRow
                icon={Gauge}
                title="Регистрация"
                subtitle={
                  registrationOpen === null
                    ? 'Загрузка…'
                    : registrationOpen
                      ? 'Открыта для новых пользователей'
                      : 'Закрыта'
                }
                right={
                  isEnvAdmin ? (
                    <Toggle
                      checked={registrationOpen === true}
                      onChange={(next) => void toggleRegistration(next)}
                      label="Регистрация"
                      disabled={registrationOpen === null || busy}
                    />
                  ) : (
                    <Lock size={16} style={{ color: 'var(--text-tertiary)' }} aria-hidden />
                  )
                }
              />
              {isEnvAdmin ? (
                <SectionRow
                  icon={Brush}
                  title="Обслуживание"
                  subtitle="Уборка файлов, кэшей и брошенных гостей"
                  onClick={() => setSection('maintenance')}
                />
              ) : (
                <SectionRow
                  icon={Lock}
                  title="Обслуживание"
                  subtitle="Доступно только основному администратору"
                />
              )}
            </Card>
          </section>

          {today?.live ? (
            <p className="px-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              <Wifi size={12} className="mr-1 inline" aria-hidden />
              Данные на {today.live.moscowNow.time} МСК
            </p>
          ) : null}

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
