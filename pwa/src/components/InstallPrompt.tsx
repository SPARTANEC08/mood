import { Menu, Plus, Share, Smartphone } from 'lucide-react';

import { haptic } from '@/lib/env';

/**
 * Первый экран: «поставьте приложение на домашний экран».
 *
 * Зачем он вообще. Приложение, запущенное с иконки, открывается без адресной
 * строки, стартует быстрее и переживает сворачивание: iOS не выгружает его при
 * уходе в фон. Объяснить это нужно один раз, но «один раз» здесь означает «до
 * установки», а не «до первого входа».
 *
 * Почему инструкция своя для каждой ОС. Шаг установки задаёт браузер, а не
 * приложение, и на iOS он один, на Android другой, и оба они НЕ совпадают с
 * тем, что показывал этот экран раньше: тот был написан только под Safari, и на
 * Android человек читал про «Поделиться» — кнопки, которой в Chrome на Android
 * нет. Сказать «нажмите кнопку, которой у вас нет» хуже, чем не показать
 * ничего.
 *
 * Про API установки. В Chrome он есть (beforeinstallprompt), но ловится
 * ненадёжно: событие приходит до того, как страницу успели покрасить, и если
 * его пропустили — до следующей загрузки. Поэтому и здесь, и на Android
 * показывается текст, а кнопка «Установить» лишь открывает системную панель
 * (iOS) или запускает отложенное событие, если оно поймано (Android).
 *
 * Отказ сохраняется на 30 дней. Без этого экран появлялся при каждом новом
 * открытии Safari и перекрывал приложение, даже если человек уже выбрал
 * «Продолжить в браузере». После срока отказ сбрасывается автоматически.
 * Установленность не хранится флагом: её определяет standalone-режим, поэтому
 * старое значение localStorage не может навсегда скрыть инструкцию.
 *
 * На десктопе экран не показывается вовсе: там установка — дело на усмотрение
 * человека, а модальное окно с кнопкой «Продолжить в браузере» на компьютере
 * выглядит как ошибка страницы.
 */

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);

const DEV_HOST_SUFFIXES = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.local'];

/** Не показывать инструкцию после отказа в Safari при каждом новом открытии. */
const INSTALL_DISMISSED_KEY = 'mood_install_dismissed_at';
const INSTALL_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function hasRecentInstallDismissal(): boolean {
  try {
    const raw = localStorage.getItem(INSTALL_DISMISSED_KEY);
    if (!raw) return false;

    const dismissedAt = Number(raw);
    if (!Number.isFinite(dismissedAt) || Date.now() - dismissedAt >= INSTALL_DISMISS_COOLDOWN_MS) {
      localStorage.removeItem(INSTALL_DISMISSED_KEY);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function rememberInstallDismissal(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
  } catch {
    // Private browsing may disable storage; the prompt still closes this session.
  }
}

/** Какая система стоит у человека. */
export type Platform = 'ios' | 'android' | 'desktop';

/**
 * Определение платформы.
 *
 * iOS определяется тремя признаками сразу, потому что ни один из них не
 * достаточен. `navigator.standalone` есть только в Safari, `display-mode` в iOS
 * не поддерживается вовсе, а у iPad с новым Safari userAgent вообще не содержит
 * «iPad» — там как раз MacIntel с мультитачем.
 */
export function detectPlatform(): Platform {
  const ua = navigator.userAgent || '';

  // iPadOS 13+ притворяется десктопом Mac; touchpoints — единственный честный
  // признак планшета, отличить который от настоящего Mac нельзя и не нужно:
  // инструкция для iOS на iPad верна в обоих случаях.
  const isIpad = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;

  if (/iPhone|iPad|iPod/i.test(ua) || isIpad) return 'ios';
  if (/Android/i.test(ua)) return 'android';

  return 'desktop';
}

/**
 * Приложение открыто с домашнего экрана.
 *
 * iOS Safari не поддерживает display-mode в media и сообщает режим отдельным
 * полем navigator.standalone, поэтому проверяются оба признака: один ловит
 * Chrome и Android, второй — iOS.
 */
export function isStandalone(): boolean {
  if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true;

  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;

  // Chrome на Android при запуске из стороннего приложения (например, из Telegram)
  // не всегда выставляет display-mode, но оставляет этот referrer.
  if (document.referrer.startsWith('android-app://')) return true;

  return false;
}

/** Открыто ли из среды разработки или туннеля: там установка невозможна. */
export function isDevHost(): boolean {
  const host = window.location.hostname.toLowerCase();
  if (DEV_HOSTS.has(host)) return true;

  return DEV_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Стоит ли показывать первый экран.
 *
 * Ровно три причины сказать «нет», и все три — про состояние, а не про волю
 * человека:
 *
 *  - приложение уже установлено (иначе мы уже в standalone и незачем);
 *  - открыт dev-хост или туннель (там установка невозможна в принципе);
 *  - десктоп (инструкция для телефона на компьютере бессмысленна).
 *
 * Отказ запоминается на 30 дней, чтобы инструкция не перекрывала Safari при
 * каждом открытии. После срока ключ автоматически сбрасывается; состояние
 * установки определяется только standalone, постоянного «installed» флага нет.
 */
export function shouldShowInstallPrompt(): boolean {
  const standalone = isStandalone();
  const devHost = isDevHost();
  const platform = detectPlatform();
  const dismissed = hasRecentInstallDismissal();

  const show = !standalone && !devHost && platform !== 'desktop' && !dismissed;

  // Точка принятия решения. Логируется КАЖДЫЙ отказ с причиной: без этого
  // «подсказка не появилась» неотличимо от «её отключил dev-хост», «приложение
  // посчитали установленным» или «платформа определилась как desktop».
  // console.debug скрыт в консоли по умолчанию и не мешает в проде.
  if (!show) {
    const reason = standalone
      ? 'standalone (уже установлено)'
      : devHost
        ? 'dev-хост или туннель'
        : platform === 'desktop'
          ? 'платформа desktop'
          : 'инструкцию недавно закрыли';
    console.debug(`[install] подсказка не показана: ${reason}`);
  }

  return show;
}

/** Шаги установки под конкретную систему. */
interface Steps {
  title: string;
  intro: string;
  items: { text: string; icon?: 'share' | 'menu' | 'plus' }[];
}

function stepsFor(platform: Platform): Steps {
  if (platform === 'android') {
    return {
      title: 'Установите Mood на телефон',
      intro:
        'Отдельное приложение открывается без адресной строки, запускается быстрее и не закрывается при сворачивании.',
      items: [
        { text: 'Нажмите кнопку меню в правом верхнем углу экрана', icon: 'menu' },
        { text: 'Выберите «Установить приложение» или «Добавить на главный экран»' },
        { text: 'Подтвердите установку — приложение появится на главном экране', icon: 'plus' },
      ],
    };
  }

  return {
    title: 'Поставьте Mood на домашний экран',
    intro:
      'Отдельное приложение открывается без адресной строки, запускается быстрее и переживает сворачивание: iOS не выгружает его при уходе в фон.',
    items: [
      { text: 'Нажмите кнопку «Поделиться» внизу экрана Safari', icon: 'share' },
      { text: 'Прокрутите список действий вниз' },
      { text: 'Выберите «На экран Домой»', icon: 'plus' },
      { text: 'Нажмите «Добавить»' },
    ],
  };
}

/**
 * Иконка шага.
 *
 * Написать «нажмите кнопку» без картинки бессмысленно: человек ищет глазами
 * именно кнопку, а не слово. Иконка ставится рядом с названием действия, а не
 * вместо него.
 */
function StepIcon({ kind }: { kind: 'share' | 'menu' | 'plus' }) {
  if (kind === 'share') return <Share size={16} className="shrink-0 text-[var(--accent)]" aria-hidden />;
  if (kind === 'menu') return <Menu size={16} className="shrink-0 text-[var(--accent)]" aria-hidden />;
  return <Plus size={16} className="shrink-0 text-[var(--accent)]" aria-hidden />;
}

export function InstallPrompt({ onSkip }: { onSkip: () => void }) {
  const platform = detectPlatform();
  const steps = stepsFor(platform);

  /**
   * Закрыть подсказку и не показывать её снова в течение 30 дней.
   *
   * Установка не помечается отдельным флагом: факт установленного приложения
   * определяется standalone-режимом браузера.
   */
  function dismiss() {
    rememberInstallDismissal();
    onSkip();
  }

  /**
   * Отложенное событие установки Chrome.
   *
   * beforeinstallprompt приходит один раз за жизнь страницы и может прийти до
   * того, как этот экран отрисован. Поэтому событие запоминается в модуле, и
   * кнопка использует его, если оно уже есть. Если события нет — экран просто
   * закрывается, шаги выше остаются на странице.
   */
  function install() {
    haptic('medium');

    const promptEvent = window.__moodInstallPrompt;

    if (promptEvent) {
      window.__moodInstallPrompt = null;
      void promptEvent.prompt().then(
        () => dismiss(),
        () => dismiss(),
      );
      return;
    }

    // iOS: открываем системную панель «Поделиться» — именно в ней живёт
    // действие «На экран Домой». Отдельного API установки у Safari нет.
    const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
    if (typeof share === 'function') {
      share({ title: 'Mood — расписание МЭИ', url: window.location.href }).catch(() => undefined);
    }

    dismiss();
  }

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center gap-6 px-6 py-10 pb-[max(40px,env(safe-area-inset-bottom))]">
      <div className="flex flex-col items-center gap-3 text-center">
        <Smartphone size={28} className="text-[var(--accent)]" aria-hidden />
        <h1 className="text-[22px] font-semibold leading-tight">{steps.title}</h1>
        <p className="text-[15px] leading-snug text-[var(--text-secondary)]">{steps.intro}</p>
      </div>

      <ol className="space-y-2.5 text-[15px] leading-snug text-[var(--text-secondary)]">
        {steps.items.map((item, index) => (
          <li key={item.text} className="flex gap-3">
            <span className="text-[var(--text-tertiary)]">{index + 1}.</span>
            <span className="flex items-center gap-1.5">
              {item.text}
              {item.icon ? <StepIcon kind={item.icon} /> : null}
            </span>
          </li>
        ))}
      </ol>

      {/*
        Кнопка обязательна, а не декоративная: без неё экран был бы тупиком, из
        которого на iOS можно выйти только перезагрузкой страницы — и отказ стал
        бы невозможен вовсе.
      */}
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={install}
          className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white"
        >
          {platform === 'android' ? 'Установить' : 'Показать, где кнопка'}
        </button>

        <button
          type="button"
          onClick={dismiss}
          className="pressable pressable-active w-full rounded-[14px] border border-[var(--separator-soft)] px-4 py-3 text-[15px] font-semibold text-[var(--text-secondary)]"
        >
          Продолжить в браузере
        </button>

        <p className="text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          Можно вернуться в браузер и продолжить работу — эта подсказка появится
          снова при следующем открытии, пока приложение не установлено.
        </p>
      </div>
      </div>
    </div>
  );
}

/**
 * Запомнить событие установки, если браузер его прислал.
 *
 * Вызывается из main.tsx до рендера: событие приходит раньше, чем успеет
 * отрисоваться первый экран, и если его не поймать в этот момент, до кнопки
 * «Установить» оно уже не дойдёт.
 */
export function rememberInstallPrompt(event: Event): void {
  event.preventDefault();
  window.__moodInstallPrompt = event as BeforeInstallPromptEvent;
}
