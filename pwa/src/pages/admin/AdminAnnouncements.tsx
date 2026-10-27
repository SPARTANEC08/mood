/**
 * Очередь объявлений в приложении.
 *
 * Объявление показывается модалкой всем (или адресату) и остаётся в центре
 * уведомлений. Здесь же его можно удалить.
 */

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { AdminAnnouncement } from '@/types/api';
import { AdminHeader, ConfirmDialog, SectionRow, errorText, formatStamp } from './shared';

export function AdminAnnouncements({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminAnnouncement | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.adminAnnouncements();
      setItems(result.items);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminCreateAnnouncement({ text: text.trim() });
      setText('');
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    try {
      await api.adminDeleteAnnouncement(removing.id);
      setRemoving(null);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminHeader title="Объявления" onBack={onBack} />

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-4 pb-8 pt-1">
          <Card className="overflow-hidden">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Текст объявления"
              rows={4}
              maxLength={4000}
              className="w-full resize-none bg-transparent px-4 py-3 text-[14px] outline-none"
              style={{ color: 'var(--text-primary)' }}
            />
          </Card>

          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !text.trim()}
            className="pressable w-full rounded-[14px] py-3 text-[15px] font-semibold text-white active:pressable-active disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? 'Сохраняем…' : 'Опубликовать всем'}
          </button>

          {error ? (
            <Card className="px-4 py-3">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            </Card>
          ) : null}

          {items.length === 0 ? (
            <Card className="px-4 py-6">
              <p className="text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                Объявлений нет.
              </p>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0"
                  style={{ borderColor: 'var(--separator-soft)' }}
                >
                  <Megaphone size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{item.text}</p>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {formatStamp(Date.parse(item.createdAt))}
                      {item.targetUserId ? ' · лично' : ' · всем'}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Удалить"
                    onClick={() => setRemoving(item)}
                    className="pressable shrink-0 rounded-full p-1.5 active:pressable-active"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              ))}
            </Card>
          )}

          <SectionRow
            icon={Megaphone}
            title="Как это выглядит"
            subtitle="Модалка при входе + запись в центре уведомлений"
          />
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Удалить объявление?"
        message={removing?.text}
        confirmLabel="Удалить"
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
