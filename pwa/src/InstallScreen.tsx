import { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Download,
  Menu,
  Monitor,
  Plus,
  Share,
  Smartphone,
} from 'lucide-react';

import { detectPlatform, isStandalone } from '@/components/InstallPrompt';
import { haptic } from '@/lib/env';

/**
 * Экран установки, который открывается с лендинга по /?install=1.
 *
 * Почему не инструкция на самом лендинге: на iOS «На экран Домой» ставит
 * ссылку на ТЕКУЩИЙ адрес, а не start_url из манифеста. Если ставить с
 * /landing.html, иконка будет открывать лендинг. Поэтому установка всегда
 * начинается с корня /: иконка получает правильный адрес, а после запуска
 * человек видит вход, а не маркетинговую страницу.
 *
 * Вход здесь не требуется: сначала установка, потом логин БАРС.
 */

interface InstallScreenProps {
  /** Убрать ?install=1 и перейти к входу (или в приложение, если токен уже есть). */
  onContinue: () => void;
}

interface IosStep {
  text: string;
  icon: 'share' | 'menu' | 'plus';
  image: string;
  width: number;
  height: number;
}

const IOS_STEPS: IosStep[] = [
  {
    text: 'Если вы в Telegram — нажмите «…» или «Поделиться» в шапке и выберите «Открыть в Safari».',
    icon: 'menu',
    image: '/install/ios-step-1.webp',
    width: 720,
    height: 129,
  },
  {
    text: 'В Safari нажмите «Поделиться» — квадрат со стрелкой вверх.',
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
    text: 'Нажмите «Добавить» и запустите Mood с иконки на экране «Домой».',
    icon: 'plus',
    image: '/install/ios-step-4.webp',
    width: 720,
    height: 590,
  },
];

function StepIcon({ kind }: { kind: IosStep['icon'] }) {
  if (kind === 'menu') return <Menu size={15} className="shrink-0" aria-hidden />;
  if (kind === 'share') return <Share size={15} className="shrink-0" aria-hidden />;
  return <Plus size={15} className="shrink-0" aria-hidden />;
}

function IosInstall() {
  return (
    <>
      <p className="text-[14px] leading-snug text-[var(--text-secondary)]">
        Установка возможна только из Safari. Если вы открыли Mood в Telegram,
        сначала перейдите в Safari — иначе «На экран “Домой”» не появится.
      </p>

      <ol className="flex flex-col gap-3">
        {IOS_STEPS.map((step, index) => (
          <li
            key={step.text}
            className="rounded-[16px] border p-3.5"
            style={{ borderColor: 'var(--separator-soft)', background: 'var(--surface)' }}
          >
            <div className="flex gap-3">
              <span className="text-[15px] font-semibold" style={{ color: 'var(--accent)' }}>
                {index + 1}
              </span>
              <span className="flex flex-1 items-start gap-1.5 text-[14px] leading-snug">
                <span>{step.text}</span>
                <span className="mt-0.5" style={{ color: 'var(--accent)' }}>
                  <StepIcon kind={step.icon} />
                </span>
              </span>
            </div>
            <img
              src={step.image}
              width={step.width}
              height={step.height}
              alt=""
              loading="lazy"
              decoding="async"
              className="mt-2.5 block h-auto w-full rounded-[12px] border"
              style={{ borderColor: 'var(--separator-soft)' }}
            />
          </li>
        ))}
      </ol>

      <p className="text-[12px] leading-snug text-[var(--text-tertiary)]">
        APK для iOS не подходит — это приложение для Android.
      </p>
    </>
  );
}

function AndroidInstall() {
  const [chromeOpen, setChromeOpen] = useState(false);

  function installFromChrome() {
    haptic('medium');
    const promptEvent = window.__moodInstallPrompt;

    if (promptEvent) {
      window.__moodInstallPrompt = null;
      void promptEvent.prompt();
      return;
    }

    setChromeOpen(true);
  }

  return (
    <>
      <a
        href="/apk/mood-1.1.0.apk"
        download="mood-1.1.0.apk"
        onClick={() => haptic('medium')}
        className="pressable pressable-active flex w-full items-center justify-center gap-2 rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white"
      >
        <Download size={19} aria-hidden />
        Скачать APK
      </a>
      <p className="mt-2 text-center text-[11.5px] text-[var(--text-tertiary)]">
        APK 1.1.0 · 1,4 МБ · Android 7+
      </p>

      <button
        type="button"
        onClick={installFromChrome}
        className="pressable pressable-active w-full rounded-[13px] border px-4 py-3 text-[13px] font-semibold"
        style={{ borderColor: 'var(--separator-soft)', color: 'var(--text-secondary)' }}
      >
        Или установить из Chrome
      </button>

      {chromeOpen ? (
        <ol className="flex flex-col gap-2.5 text-[13px] leading-snug text-[var(--text-secondary)]">
          <li>1. Откройте mood-app.ru в Chrome.</li>
          <li>2. Нажмите меню ⋮ в правом верхнем углу.</li>
          <li>3. Выберите «Установить приложение» или «Добавить на главный экран».</li>
          <li>4. Подтвердите установку.</li>
        </ol>
      ) : null}

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-[12px]">
        <a
          href="https://t.me/mood_mpei/15"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium"
          style={{ color: 'var(--accent)' }}
        >
          Последняя версия в Telegram
          <ArrowUpRight size={13} aria-hidden />
        </a>
        <a
          href="https://github.com/SPARTANEC08/mood/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium"
          style={{ color: 'var(--accent)' }}
        >
          GitHub Releases
          <ArrowUpRight size={13} aria-hidden />
        </a>
      </div>

      <p className="text-[12px] leading-snug text-[var(--text-tertiary)]">
        APK ставится поверх предыдущей версии. Если Chrome не предлагает
        установку — скачайте файл выше.
      </p>
    </>
  );
}

function DesktopInstall() {
  return (
    <>
      <p className="text-[14px] leading-snug text-[var(--text-secondary)]">
        На компьютере Mood открывается как обычный сайт, но его можно закрепить
        в отдельном окне Chrome или Edge.
      </p>

      <ol className="flex flex-col gap-2.5 text-[13.5px] leading-snug text-[var(--text-secondary)]">
        <li>1. Откройте mood-app.ru в Chrome или Edge.</li>
        <li>2. Нажмите иконку установки в адресной строке.</li>
        <li>3. Или откройте меню браузера → «Установить Mood».</li>
        <li>4. Приложение появится в Dock или меню «Пуск».</li>
      </ol>

      <p className="text-[12px] leading-snug text-[var(--text-tertiary)]">
        На компьютере удобно смотреть расписание и открывать файлы. Push лучше
        работают на телефоне.
      </p>
    </>
  );
}

export function InstallScreen({ onContinue }: InstallScreenProps) {
  const platform = detectPlatform();
  const installed = isStandalone();

  const title = installed
    ? 'Mood уже установлен'
    : platform === 'ios'
      ? 'Установите Mood на iPhone'
      : platform === 'android'
        ? 'Установите Mood на Android'
        : 'Установите Mood на компьютер';

  const subtitle = installed
    ? 'Откройте приложение с экрана «Домой». Дальше понадобится логин и пароль БАРС.'
    : platform === 'ios'
      ? 'Приложение ставится из Safari на экран «Домой» и открывается без адресной строки.'
      : platform === 'android'
        ? 'Скачайте APK или установите PWA из Chrome. После установки откройте Mood и войдите логином БАРС.'
        : 'Закрепите Mood в отдельном окне браузера — или продолжайте в обычной вкладке.';

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div
        className="mx-auto flex min-h-full w-full max-w-[460px] flex-col gap-5 px-5 py-8"
        style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/icons/site-icon-192.png?v=2"
            width={64}
            height={64}
            alt=""
            className="rounded-[17px]"
          />
          <h1 className="text-[23px] font-semibold leading-tight">{title}</h1>
          <p className="max-w-[380px] text-[14px] leading-snug text-[var(--text-secondary)]">
            {subtitle}
          </p>
        </div>

        <div
          className="flex flex-col gap-4 rounded-[18px] border p-4"
          style={{ borderColor: 'var(--separator-soft)', background: 'var(--surface)' }}
        >
          {installed ? (
            <div className="flex items-center gap-3 rounded-[14px] p-3" style={{ background: 'var(--accent-soft)' }}>
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                <Check size={19} aria-hidden />
              </span>
              <div className="min-w-0 text-[13px] leading-snug">
                <p className="font-semibold">Иконка уже на экране «Домой»</p>
                <p className="text-[var(--text-secondary)]">
                  Запускайте Mood с неё — это и есть приложение.
                </p>
              </div>
            </div>
          ) : platform === 'ios' ? (
            <IosInstall />
          ) : platform === 'android' ? (
            <AndroidInstall />
          ) : (
            <DesktopInstall />
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onContinue}
            className="pressable pressable-active w-full rounded-[14px] border px-4 py-3 text-[14px] font-semibold"
            style={{ borderColor: 'var(--separator-soft)', color: 'var(--text-secondary)' }}
          >
            Продолжить в браузере
          </button>
          <p className="text-center text-[11.5px] leading-snug text-[var(--text-tertiary)]">
            Логин и пароль БАРС понадобятся после установки.
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--text-tertiary)]">
          {platform === 'ios' ? (
            <Smartphone size={14} aria-hidden />
          ) : platform === 'android' ? (
            <Smartphone size={14} aria-hidden />
          ) : (
            <Monitor size={14} aria-hidden />
          )}
          <span>Mood · не официальное приложение НИУ МЭИ</span>
        </div>
      </div>
    </div>
  );
}
