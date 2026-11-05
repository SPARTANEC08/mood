/**
 * Переключатель темы оформления в «Кабинете».
 *
 * Выбор сводится к глобальному модулю темы (lib/theme.ts): он хранит режим в
 * localStorage и выставляет `data-theme` на <html>, а цвета живут только в
 * токенах index.css. Компонент намеренно не знает ни одного цвета — ни жёстко,
 * ни как разметку темы: активная кнопка заливается --accent, остальное берётся
 * из токенов поверхности.
 *
 * Три режима — системная, светлая и тёмная. По умолчанию активна тёмная.
 */

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui';
import { haptic } from '@/lib/env';
import { useTheme, type ThemeMode } from '@/lib/theme';

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: LucideIcon }> = [
  { mode: 'system', label: 'Системная', icon: Monitor },
  { mode: 'light', label: 'Светлая', icon: Sun },
  { mode: 'dark', label: 'Тёмная', icon: Moon },
];

export function ThemeCard() {
  const [mode, setMode] = useTheme();

  return (
    <section>
      <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        Оформление
      </h2>

      <Card className="p-3.5">
        <div
          role="radiogroup"
          aria-label="Тема оформления"
          className="flex gap-1 rounded-[12px] p-1"
          style={{ background: 'var(--surface-grouped)' }}
        >
          {OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => {
            const active = mode === optionMode;

            return (
              <button
                key={optionMode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  haptic('light');
                  setMode(optionMode);
                }}
                className="pressable flex flex-1 items-center justify-center gap-1.5 rounded-[9px] py-2 text-[13px] font-medium active:pressable-active"
                style={{
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                }}
              >
                <Icon size={15} aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      </Card>
    </section>
  );
}
