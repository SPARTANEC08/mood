/**
 * Инструкция, если push включить нельзя из-за настроек браузера или установки.
 *
 * Показывается только по кнопке из настроек и только когда есть проблема:
 * разрешение запрещено или на iOS приложение не установлено. Обычным
 * пользователям этот экран не показывается.
 */

import { ArrowLeft, BellOff, MessageCircle, Smartphone } from 'lucide-react';

import { haptic, openLink } from '@/lib/env';
import { SUPPORT_URL } from '@/lib/links';

type HelpKind = 'denied' | 'ios';

type Platform = 'ios' | 'android' | 'desktop';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';

  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** Samsung Internet: у него своя настройка «безопасных соединений», которая
 *  блокирует часть сайтов и прячет разрешения. */
function isSamsungBrowser(): boolean {
  return typeof navigator !== 'undefined' && /SamsungBrowser/i.test(navigator.userAgent);
}

function steps(kind: HelpKind, platform: Platform, samsung: boolean): string[] {
  if (kind === 'ios') {
    return [
      'Откройте сайт Mood в Safari.',
      'Нажмите «Поделиться» → «На экран Домой» → «Добавить».',
      'Запустите Mood с иконки на домашнем экране.',
      'Вернитесь в Кабинет → Настройки приложения и нажмите «Включить».',
    ];
  }

  if (platform === 'ios') {
    return [
      'Если Mood ещё не на экране «Домой» — сначала установите его через Safari: «Поделиться» → «На экран Домой».',
      'Откройте «Настройки» iPhone → «Уведомления» → «Mood».',
      'Включите «Разрешить уведомления».',
      'Вернитесь в Mood и нажмите «Включить» в настройках приложения.',
    ];
  }

  if (platform === 'android' && samsung) {
    return [
      'Откройте Samsung Internet → ⋮ → «Настройки» → «Конфиденциальность и безопасность».',
      'Включите «Использовать безопасные соединения» (может называться «Безопасное соединение»).',
      'Вернитесь на сайт Mood и обновите страницу.',
      'Нажмите замок рядом с адресом → «Разрешения» → «Уведомления» → «Разрешить».',
      'Если пункта «Уведомления» всё ещё нет — откройте Mood в Chrome или Firefox.',
    ];
  }

  if (platform === 'android') {
    return [
      'В Chrome нажмите значок замка (или ⓘ) рядом с адресом сайта.',
      'Выберите «Разрешения» → «Уведомления» → «Разрешить».',
      'Если пункта нет: Chrome → ⋮ → «Настройки» → «Настройки сайтов» → «Уведомления» → найдите Mood.',
      'Вернитесь в приложение и нажмите «Включить» ещё раз.',
    ];
  }

  return [
    'Нажмите значок замка рядом с адресом сайта.',
    'Откройте «Уведомления» и выберите «Разрешить».',
    'Если пункта нет: настройки браузера → «Конфиденциальность и безопасность» → «Настройки сайтов» → «Уведомления» → найдите Mood.',
    'Обновите страницу и нажмите «Включить» ещё раз.',
  ];
}

export function PushHelpSheet({
  kind,
  onClose,
}: {
  kind: HelpKind;
  onClose: () => void;
}) {
  const platform = detectPlatform();
  const items = steps(kind, platform, isSamsungBrowser());

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50">
      <div
        className="surface max-h-[85vh] w-full max-w-[480px] overflow-y-auto rounded-t-[22px] px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-5"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            aria-hidden
          >
            {kind === 'ios' ? <Smartphone size={20} /> : <BellOff size={20} />}
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight">
              {kind === 'ios' ? 'Сначала установите приложение' : 'Как разрешить уведомления'}
            </h2>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {kind === 'ios'
                ? 'На iPhone push работают только в установленной PWA'
                : 'Разрешение выдаётся в настройках браузера или системы'}
            </p>
          </div>
        </div>

        <ol className="mt-4 space-y-2.5">
          {items.map((item, index) => (
            <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}
              >
                {index + 1}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{item}</span>
            </li>
          ))}
        </ol>

        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Включить или выключить уведомления можно в любой момент: Кабинет → Настройки
          приложения → Push-уведомления.
        </p>

        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Если ничего не помогло — напишите в поддержку, разберёмся вместе.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              haptic('light');
              openLink(SUPPORT_URL);
            }}
            className="pressable flex flex-1 items-center justify-center gap-2 rounded-[12px] py-3 text-[15px] font-semibold active:pressable-active"
            style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
          >
            <MessageCircle size={16} aria-hidden />
            Поддержка
          </button>
          <button
            type="button"
            onClick={() => {
              haptic('light');
              onClose();
            }}
            className="pressable flex flex-1 items-center justify-center gap-2 rounded-[12px] py-3 text-[15px] font-semibold text-white active:pressable-active"
            style={{ background: 'var(--accent)' }}
          >
            <ArrowLeft size={16} aria-hidden />
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
