/**
 * Глобальные константы, подставляемые сборкой.
 *
 * __SW_VERSION__ объявлен в vite.config.ts через define — Vite заменяет его
 * литералом на этапе сборки, поэтому здесь нужен только объявленный тип.
 */
declare const __SW_VERSION__: string;

/**
 * Событие установки, пойманное браузером.
 *
 * beforeinstallprompt приходит один раз за жизнь страницы и может прийти ДО
 * того, как отрисуется первый экран установки. Без этого объявления кнопка
 * «Установить» не знала бы, что ей доступно, и всегда просто закрывала экран.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface Window {
  /** Отложенное событие установки; null, если браузер его не присылал. */
  __moodInstallPrompt?: BeforeInstallPromptEvent | null;
}
