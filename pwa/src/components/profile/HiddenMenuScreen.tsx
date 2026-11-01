import { ArrowLeft, ArrowUpRight } from 'lucide-react';

import { Page } from '@/components/Page';
import { haptic, openLink } from '@/lib/env';

/**
 * Скрытый экран кабинета.
 *
 * Открывается десятью быстрыми тапами по карточке профиля. Ни в навигации, ни
 * в текстах на него нет ссылки — это и есть весь смысл экрана.
 *
 * Кнопки задаются здесь. Пустой список — экран остаётся пустым.
 *
 * Ссылки на сторонние сервисы (хостинг и взрослый контент) убраны: в
 * студенческом приложении им не место, а внешний URL здесь — готовая
 * закладка/фишинг-поверхность. Экран оставлен как техническая точка входа
 * на будущее, без внешних переходов.
 */
const HIDDEN_LINKS: Array<{ label: string; url: string }> = [];

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
      {HIDDEN_LINKS.length > 0 ? (
        <div className="space-y-2">
          {HIDDEN_LINKS.map((link) => (
            <button
              key={link.url}
              type="button"
              onClick={() => {
                haptic('light');
                openLink(link.url);
              }}
              className="pressable surface flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <ArrowUpRight size={18} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              <span className="min-w-0 flex-1 text-[15px] font-medium">{link.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </Page>
  );
}
