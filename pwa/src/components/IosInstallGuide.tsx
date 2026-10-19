import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Menu, Plus, Share, Smartphone } from 'lucide-react';

import { haptic, isIOS, isStandalone } from '@/lib/env';

/**
 * Инструкция по установке Mood на iPhone — ТОЛЬКО для iOS в браузере.
 *
 * Зачем отдельно от InstallPrompt. На iOS страница чаще всего открыта во
 * встроенном WebView (из Telegram), а оттуда установить PWA нельзя: нужно
 * сначала выйти в настоящий Safari. Прежний InstallPrompt этого шага не знал,
 * запоминал отказ на 30 дней и предлагал «Продолжить в браузере» — то есть
 * оставлял человека там, где установка невозможна.
 *
 * Правила:
 *  - показывается при КАЖДОЙ загрузке, пока приложение не установлено;
 *  - кнопки «остаться в браузере» нет — только «Понятно»;
 *  - первый шаг всегда про «Открыть в Safari»;
 *  - четыре шага: фото + текст; картинки — WebP с явными размерами;
 *  - на Android и десктопе не показывается никогда.
 */

/** Показывать ли этот экран прямо сейчас. */
export function shouldShowIosInstallGuide(): boolean {
  // Показываем всегда на iOS, пока не доказано обратное (уже в PWA). Если
  // определить не удалось — считаем, что браузер, и показываем.
  return isIOS() && !isStandalone();
}

/** Реактивная версия условия — чтобы не дублировать проверку в App. */
export function useShouldShowIosInstallGuide(): boolean {
  const [show] = useState(shouldShowIosInstallGuide);
  return show;
}

interface Step {
  /** Текст шага; допускает разметку (например, жирный акцент). */
  text: ReactNode;
  icon: 'menu' | 'share' | 'plus';
  /** Готовое фото шага (WebP, width:100% в карточке). */
  image: string;
  /** Собственные размеры файла — чтобы не было сдвига вёрстки при загрузке. */
  width: number;
  height: number;
}

const STEPS: Step[] = [
  {
    text: 'Нажмите «…» или «Поделиться» в шапке Telegram и выберите «Открыть в Safari».',
    icon: 'menu',
    image: '/install/ios-step-1.webp',
    width: 720,
    height: 129,
  },
  {
    text: 'В Safari нажмите иконку «Поделиться» (квадрат со стрелкой вверх) внизу экрана.',
    icon: 'share',
    image: '/install/ios-step-2.webp',
    width: 720,
    height: 1428,
  },
  {
    text: 'Пролистайте список действий и выберите «На экран “Домой”».',
    icon: 'share',
    image: '/install/ios-step-3.webp',
    width: 720,
    height: 1156,
  },
  {
    text: (
      <>
        Нажмите «Добавить» и убедитесь, что включён переключатель{' '}
        <strong className="font-semibold" style={{ color: 'var(--accent)' }}>
          «Открыть как веб‑приложение»
        </strong>
        .
      </>
    ),
    icon: 'plus',
    image: '/install/ios-step-4.webp',
    width: 720,
    height: 590,
  },
];

function StepIcon({ kind }: { kind: Step['icon'] }) {
  if (kind === 'menu') return <Menu size={15} className="shrink-0" aria-hidden />;
  if (kind === 'share') return <Share size={15} className="shrink-0" aria-hidden />;
  return <Plus size={15} className="shrink-0" aria-hidden />;
}

/**
 * Фото шага.
 *
 * Размеры файла заданы атрибутами width/height, а CSS растягивает по ширине
 * карточки (w-full h-auto) — поэтому вёрстка не «прыгает» при подгрузке, хотя
 * у снимков разная высота. loading=lazy/decoding=async — чтобы шаги ниже
 * экрана не тормозили открытие.
 */
function StepImage({ step }: { step: Step }) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className="relative mt-2.5 overflow-hidden rounded-[12px] border"
      style={{ borderColor: 'var(--separator-soft)', background: 'var(--surface)' }}
    >
      {failed ? (
        <div className="flex h-[96px] items-center justify-center" style={{ color: 'var(--accent)' }}>
          <StepIcon kind={step.icon} />
        </div>
      ) : (
        <img
          src={step.image}
          width={step.width}
          height={step.height}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="block h-auto w-full"
        />
      )}
    </div>
  );
}

export function IosInstallGuide() {
  const [open, setOpen] = useState(true);

  // Вне iOS (Android, десктоп) или уже в PWA — ничего не рендерим.
  if (!shouldShowIosInstallGuide()) return null;
  if (!open) return null;

  function dismiss() {
    haptic('medium');
    setOpen(false);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] overflow-y-auto overscroll-contain"
      style={{ background: 'var(--app-bg)', color: 'var(--text-primary)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Установка Mood на iPhone"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col gap-5 px-5 py-8 pb-[max(24px,env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Smartphone size={28} style={{ color: 'var(--accent)' }} aria-hidden />
          <h1 className="text-[22px] font-semibold leading-tight">Откройте Mood как приложение</h1>
          <p className="text-[15px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            В браузере Telegram приложение работает хуже. Установите его на экран «Домой» — это займёт 15 секунд.
          </p>
        </div>

        <ol className="flex flex-col gap-4">
          {STEPS.map((step, index) => (
            <li
              key={index}
              className="rounded-[16px] border p-3.5"
              style={{ borderColor: 'var(--separator-soft)', background: 'var(--surface)' }}
            >
              <div className="flex gap-3">
                <span className="text-[15px] font-semibold" style={{ color: 'var(--accent)' }}>
                  {index + 1}
                </span>
                <span className="flex items-start gap-1.5 text-[15px] leading-snug">
                  <span>{step.text}</span>
                  <span className="mt-0.5" style={{ color: 'var(--accent)' }}>
                    <StepIcon kind={step.icon} />
                  </span>
                </span>
              </div>
              <StepImage step={step} />
            </li>
          ))}
        </ol>

        <button
          type="button"
          onClick={dismiss}
          className="pressable pressable-active w-full rounded-[14px] px-4 py-3.5 text-[16px] font-semibold text-white"
          style={{ background: 'var(--accent)' }}
        >
          Понятно
        </button>
      </div>
    </div>,
    document.body,
  );
}
