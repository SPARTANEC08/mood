import { ArrowLeft, ArrowUpRight } from 'lucide-react';

import { Page } from '@/components/Page';
import { haptic, openLink } from '@/lib/env';

/**
 * Скрытый экран кабинета.
 *
 * Открывается десятью быстрыми тапами по карточке профиля. Ни в навигации, ни
 * в текстах на него нет ссылки — это и есть весь смысл экрана.
 *
 * Ссылка задаётся здесь. Пока строка пуста, кнопки нет и экран остаётся пустым.
 */
const HIDDEN_LINK = '';
const HIDDEN_LINK_LABEL = 'Открыть';

export function HiddenMenuScreen({ onBack }: { onBack: () => void }) {
  return (
    <Page
      header={
        <header
          className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]"
          style={{ background: 'var(--app-bg)' }}
        >
          <div className="mx-auto flex max-w-[560px] items-center gap-2">
            <button
              type="button"
              aria-label="Назад"
              onClick={() => {
                haptic('light');
                onBack();
              }}
              className="pressable -ml-1 rounded-full p-1.5 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <ArrowLeft size={22} aria-hidden />
            </button>
          </div>
        </header>
      }
    >
      {HIDDEN_LINK ? (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            openLink(HIDDEN_LINK);
          }}
          className="pressable surface flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
        >
          <ArrowUpRight size={18} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
          <span className="min-w-0 flex-1 text-[15px] font-medium">{HIDDEN_LINK_LABEL}</span>
        </button>
      ) : null}
    </Page>
  );
}
