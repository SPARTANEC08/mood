/**
 * Карточка «Документы и согласия» в профиле.
 *
 * Показывает, какие версии документов приняты и когда, и даёт открыть полные
 * тексты. Отзыв согласия здесь не делается: для обработки данных он означал бы
 * удаление аккаунта, а это отдельный сценарий с подтверждением.
 */

import { FileText, ShieldCheck } from 'lucide-react';

import { Card } from '@/components/ui';
import { openLink } from '@/lib/env';
import type { LegalStatus } from '@/types/api';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function ConsentsCard({
  legal,
  isGuest = false,
  embedded = false,
}: {
  legal: LegalStatus | undefined;
  isGuest?: boolean;
  /**
   * Только содержимое, без собственной карточки и заголовка.
   *
   * Нужен, когда блок живёт внутри сворачиваемого StudySection: заголовок
   * рисует он, а вторым заголовком карточка выглядела бы как вложенный блок.
   */
  embedded?: boolean;
}) {
  if (!legal) return null;

  const acceptedById = new Map(legal.accepted.map((item) => [item.id, item]));
  const documents = legal.documents.filter((document) => document.id !== 'guest' || isGuest);

  const content = (
    <div className="space-y-3">
      {documents.map((document) => {
        const accepted = acceptedById.get(document.id);

        return (
          <div key={document.id} className="flex items-start gap-3">
            <FileText
              size={16}
              className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => openLink(document.url)}
                className="block text-left text-[13px] font-medium leading-snug underline decoration-[var(--separator-soft)] underline-offset-2"
              >
                {document.title}
              </button>
              <span className="block text-[11px] leading-snug text-[var(--text-tertiary)]">
                {accepted
                  ? `Принято ${formatDate(accepted.acceptedAt)} · версия ${accepted.version}`
                  : document.id === 'push'
                    ? `Версия ${document.version} · не подключено`
                    : `Версия ${document.version} · не принято`}
              </span>
            </div>
          </div>
        );
      })}

      <div className="border-t border-[var(--separator-soft)] pt-3">
        <button
          type="button"
          onClick={() => openLink(legal.policy.url)}
          className="flex items-start gap-3 text-left"
        >
          <FileText
            size={16}
            className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium leading-snug underline decoration-[var(--separator-soft)] underline-offset-2">
              {legal.policy.title}
            </span>
            <span className="block text-[11px] leading-snug text-[var(--text-tertiary)]">
              Версия {legal.policy.version}
            </span>
          </span>
        </button>
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <Card className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={18} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
        <span className="text-[14px] font-semibold">Документы и согласия</span>
      </div>
      {content}
    </Card>
  );
}

/**
 * Сводка по согласиям для свёрнутой строки «Документов».
 *
 * Push — необязательный документ: его отсутствие не должно выглядеть как
 * «не всё принято». Гостевой документ считается обязательным только у гостя.
 */
export function consentsSummary(
  legal: LegalStatus | undefined,
  isGuest: boolean,
): { accepted: number; total: number } {
  if (!legal) return { accepted: 0, total: 0 };

  const acceptedIds = new Set(legal.accepted.map((item) => item.id));
  const required = legal.documents.filter(
    (document) => document.id !== 'push' && (document.id !== 'guest' || isGuest),
  );

  return {
    accepted: required.filter((document) => acceptedIds.has(document.id)).length,
    total: required.length,
  };
}
