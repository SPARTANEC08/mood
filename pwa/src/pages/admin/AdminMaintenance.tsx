/**
 * Обслуживание: ручной запуск уборки и результат.
 */

import { useState } from 'react';
import { Brush } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import { AdminHeader, StatCard, errorText, formatBytes } from './shared';

type MaintenanceResult = {
  previews?: number;
  orphans?: number;
  tmp?: number;
  reports?: number;
  backups?: number;
  guests?: number;
  freeMb?: number | null;
};

export function AdminMaintenance({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MaintenanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.adminMaintenance();
      setResult(response.result as MaintenanceResult);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Обслуживание" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          <Card className="px-4 py-3.5">
            <p className="text-[14px] font-semibold">Уборка диска</p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Удаляет просроченные превью, временные файлы, осиротевшие вложения и
              старые отчёты, а также брошенные гостевые профили старше 30 дней.
              Автоматически запускается раз в сутки — кнопка нужна,
              если место кончилось раньше.
            </p>
          </Card>

          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="pressable flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            <Brush size={16} aria-hidden />
            {busy ? 'Убираем…' : 'Запустить уборку'}
          </button>

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {result ? (
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Превью" value={result.previews ?? 0} />
              <StatCard label="Осиротевшие" value={result.orphans ?? 0} />
              <StatCard label="Временные" value={result.tmp ?? 0} />
              <StatCard label="Отчёты" value={result.reports ?? 0} />
              <StatCard label="Бэкапы" value={result.backups ?? 0} />
              <StatCard label="Гости" value={result.guests ?? 0} />
              <StatCard
                label="Свободно"
                value={result.freeMb != null ? formatBytes(result.freeMb * 1024 * 1024) : '—'}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
