/**
 * Среда выполнения приложения: обычный браузер, без Telegram.
 *
 * Раньше эти функции жили в webapp/src/lib/telegram.ts и были обёртками над
 * Telegram WebApp SDK, а PWA подменял их шимом на этапе сборки. Mini App больше
 * нет, поэтому подмена не нужна: остался один клиент, и он работает в браузере.
 * Набор функций сохранён целиком, потому что вызывающий код (кнопки, переходы,
 * липкая шапка) не должен знать, где он запущен — иначе пришлось бы править
 * каждую страницу.
 *
 * Каждая функция обязана быть безопасна вне браузера и при отсутствии
 * поддержки: вместо исключения тихо ничего не делает.
 */

/**
 * Уровень тактильного отклика.
 *
 * Набор строк повторяет бывший Telegram API, но реально используются два
 * значения — их достаточно, чтобы отличать переход от подтверждения.
 */
export type HapticStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

/** Тип уведомления: успех, ошибка, предупреждение. */
export type NotificationStyle = 'error' | 'success' | 'warning';

/**
 * Тактильный отклик при нажатии.
 *
 * Тип подбирается по смыслу действия: лёгкий для переходов между вкладками и
 * фильтрами, средний для подтверждения пользовательского ввода.
 *
 * Вибрация есть не везде, и это проверяется именно так: у navigator.vibrate в
 * одних браузерах нет метода, в других он есть и всегда возвращает false
 * (iOS Safari, режим инкогнито). Обращение к отсутствующему методу бросило бы
 * TypeError на первом же нажатии, поэтому проверяем наличие функции.
 */
export function haptic(style: HapticStyle = 'light'): void {
  if (typeof navigator.vibrate !== 'function') return;

  try {
    // Длительность подобрана на глаз по iOS-кривым отклика: лёгкий barely
    // ощутим, средний читается как подтверждение.
    navigator.vibrate(style === 'medium' ? 25 : 10);
  } catch {
    // Браузер запретил вибрацию без жеста пользователя — это ожидаемо.
  }
}

/**
 * Вибрация по событию: успех/ошибка/предупреждение.
 *
 * Намеренно ничего не делает: вибрация по событию в браузере ловится как
 * спам, особенно на длинных списках, где события следуют одно за другим.
 */
export function notify(_style: NotificationStyle): void {}

/** Отклик выбора значения (пикер, сегмент). */
export function hapticSelection(): void {
  haptic('light');
}

/**
 * Экономия трафика.
 *
 * Network Information API есть не везде (нет в Safari), поэтому проверяются
 * два независимых признака: пользовательский флаг Save-Data (его ставят и
 * мобильные браузеры, и операторы связи) и оценка скорости канала. Любой из них
 * означает «не тяни мегабайты без спроса».
 *
 * Отсутствие API трактуется как «экономии нет»: заставлять всех на десктопе
 * жить с превью вместо оригинала было бы хуже, чем изредка потратить трафик.
 */
export function isDataSaver(): boolean {
  if (typeof navigator === 'undefined') return false;

  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;

  if (!connection) return false;

  return connection.saveData === true || connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g';
}

/**
 * Подготовка документа при открытии приложения.
 *
 * Настройки самого документа: отключаем двойной тап-зум и подсветку тапа,
 * включаем color-scheme по системной теме. touch-action: manipulation убирает
 * задержку в 300 мс на мобильных браузерах, из-за которой кнопки ощущались бы
 * «ватными» по сравнению с нативным приложением.
 */
export function initDocument(): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.style.touchAction = 'manipulation';

  const body = document.body;
  if (body) body.style.touchAction = 'manipulation';

  blockInterfaceZoom();
  syncColorScheme();
}

/**
 * Запрещает масштабирование интерфейса щипком.
 *
 * Мета-тег viewport (`maximum-scale=1, user-scalable=no`) закрывает вопрос на
 * Android и в большинстве браузеров, но iOS Safari его игнорирует: там зум
 * ловится жестовыми событиями WebKit. Поэтому дополнительно гасим
 * `gesturestart`/`gesturechange`/`gestureend` и Ctrl+колесо (щипок на десктопе).
 *
 * Исключение — просмотр файлов: внутри вьюера (портал в body с маркером
 * `data-mood-file-viewer`) зум нужен, там события не перехватываются. Картинка
 * зумится своими pointer-жестами, PDF — кнопками/pdf.js.
 */
function blockInterfaceZoom(): void {
  const insideViewer = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-mood-file-viewer]') !== null;

  const swallow = (event: Event) => {
    if (!insideViewer(event.target)) event.preventDefault();
  };

  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, swallow, { passive: false });
  }

  // Щипок на десктопе и в трекпаде приходит как wheel с зажатым Ctrl.
  document.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey && !insideViewer(event.target)) event.preventDefault();
    },
    { passive: false },
  );
}

/**
 * Синхронизирует тему приложения с системной.
 *
 * Тот же источник, что и в index.css (@media prefers-color-scheme): установка
 * свойства снимает с colorScheme светлую принудительную установку из :root и
 * позволяет браузеру переключаться самому.
 */
export function syncColorScheme(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Закрывает приложение.
 *
 * В PWA это не работает: закрыть окно может только скрипт, который его открыл.
 * Вызов оставлен, потому что его дёргает экран входа в БАРС, и падать там нельзя.
 */
export function closeApp(): void {
  try {
    window.close();
  } catch {
    // Браузер запретил закрытие — тихо ничего не делаем.
  }
}

/**
 * Открывает внешнюю ссылку.
 *
 * В standalone-PWA на iOS `window.open` открывает сайт внутри webview, а не в
 * Safari. Веб-почта МЭИ в этом контексте может получить 403 от Forefront TMG.
 * Переход через location выносит пользователя из установленного приложения.
 * В обычном браузере оставляем новую вкладку, чтобы не терять приложение.
 */
export function openLink(url: string): void {
  if (typeof window === 'undefined') return;

  let destination: URL;
  try {
    destination = new URL(url, window.location.origin);
  } catch {
    return;
  }
  // Не допускаем javascript:, data:, file: и другие активные схемы даже если
  // вызывающий код в будущем начнёт передавать ссылку из внешних данных.
  if (destination.protocol !== 'https:' && destination.protocol !== 'http:') return;

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  const isStandalone =
    navigatorWithStandalone.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;

  if (isStandalone) {
    window.location.href = destination.href;
    return;
  }

  try {
    window.open(destination.href, '_blank', 'noopener');
  } catch {
    // Всплывающие окна блокируются без жеста пользователя — это ожидаемо.
  }
}

/**
 * Высота вьюпорта в CSS-пикселях — нужна для расчёта нижних отступов.
 *
 * visualViewport, а не innerHeight: в мобильном Safari второй не учитывает
 * область, которую съедает выдвинутая клавиатура, и нижняя панель уезжала бы
 * под неё при вводе текста.
 */
export function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * iOS или iPadOS.
 *
 * Три признака сразу, потому что ни один не достаточен: на iPad с новым Safari
 * в userAgent нет «iPad» вообще — там MacIntel с мультитачем (отличить от
 * настоящего Macintosh нельзя и не нужно: инструкция одинаковая).
 *
 * Нужен только слою показа инструкции по установке (см. IosInstallGuide).
 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent || '';
  const isIpadOs = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;

  return /iPad|iPhone|iPod/.test(ua) || isIpadOs;
}

/**
 * Приложение открыто как установленное (с домашнего экрана), а не во вкладке.
 *
 * iOS Safari НЕ поддерживает display-mode в media и сообщает режим отдельным
 * полем navigator.standalone, поэтому проверяются оба признака.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;

  return window.matchMedia?.('(display-mode: standalone)').matches === true;
}
