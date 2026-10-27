/**
 * Регистрация Service Worker.
 *
 * Отдельно от main.tsx по одной причине: регистрация не должна быть частью
 * графа приложения. Она нужна даже тогда, когда само приложение не запустилось
 * (например, экран входа) — офлайн-оболочка всё равно должна открываться.
 *
 * Обновление намеренно НЕ применяется автоматически: смена Service Worker
 * сбрасывает кэш оболочки, и если это происходит посреди работы, пользователь
 * теряет открытый экран. Поэтому новая версия ждёт, пока он сам перезагрузит
 * приложение, а мы только предлагаем это кнопкой.
 *
 * __SW_VERSION__ подставляется vite.config.ts через define (объявлен в globals.d.ts).
 */

const SW_URL = `/sw.js?v=${__SW_VERSION__}`;

/** Полноэкранное предложение обновить приложение. Одно за сессию. */
let updateOverlayShown = false;

/**
 * Версия воркера, для которой человек уже нажал «Перезагрузить».
 *
 * iOS в standalone иногда не активирует новый воркер с первого раза: после
 * reload тот же waiting остаётся на месте, updatefound срабатывает снова, и
 * плашка возвращается через пару секунд. Запоминаем версию и не показываем
 * её повторно; новая версия — новый scriptURL — показывается как обычно.
 */
const DISMISSED_UPDATE_KEY = 'mood_sw_update_dismissed';
const DISMISSED_UPDATE_TTL_MS = 10 * 60 * 1000;

function updateVersion(registration: ServiceWorkerRegistration): string {
  return (
    registration.waiting?.scriptURL ??
    registration.installing?.scriptURL ??
    registration.active?.scriptURL ??
    ''
  );
}

function updateWasDismissed(registration: ServiceWorkerRegistration): boolean {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_UPDATE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as { version?: unknown; at?: unknown };
    if (typeof data.version !== 'string' || typeof data.at !== 'number') return false;
    return data.version === updateVersion(registration) && Date.now() - data.at < DISMISSED_UPDATE_TTL_MS;
  } catch {
    return false;
  }
}

function rememberDismissedUpdate(registration: ServiceWorkerRegistration): void {
  try {
    window.sessionStorage.setItem(
      DISMISSED_UPDATE_KEY,
      JSON.stringify({ version: updateVersion(registration), at: Date.now() }),
    );
  } catch {
    // Приватный режим: остаётся только защита в памяти текущей страницы.
  }
}

/**
 * Регистрирует Service Worker, если браузер его умеет.
 *
 * Два случая, когда регистрация НЕ происходит, и каждый по своей причине:
 *
 * 1. import.meta.env.DEV. В dev кэш ломает hot-reload: страница продолжает
 *    отдавать старый бандл из Cache Storage, и разработчик полчаса ищет правку,
 *    которая уже в коде. Это известная боль, и она предотвращается здесь.
 *
 * 2. navigator.serviceWorker отсутствует — старый Safari, режим инкогнито,
 *    жёсткие настройки приватности. Приложение работает и без офлайна.
 */
export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void register();
  });
}

/**
 * Сама регистрация, отдельно от проверок выше.
 *
 * try/catch и пустое catch здесь обязательны: отказ регистрации (http:// вместо
 * https, запрет Service Worker в настройках браузера) не должен ронять
 * приложение. Пользователь получит обычное веб-приложение вместо PWA — это
 * неприятно, но работоспособно, поэтому рвать из-за этого рендер нельзя.
 */
async function register(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });

    // Явная проверка обновлений: браузер иначе троттлит её до раза в сутки, и
    // после деплоя пользователь мог остаться на старом воркере (а старый
    // index.html — на удалённых чанках). Проверяем при старте и при каждом
    // возврате в приложение.
    const checkForUpdate = (): void => {
      void registration.update().catch(() => undefined);
    };
    checkForUpdate();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });

    // Демо-триггер для проверки экрана обновления: /?update-demo=1.
    // Параметр убираем из адреса, чтобы после перезагрузки окно не появилось снова.
    const demoUrl = new URL(window.location.href);
    if (demoUrl.searchParams.get('update-demo') === '1') {
      demoUrl.searchParams.delete('update-demo');
      window.history.replaceState(null, '', `${demoUrl.pathname}${demoUrl.search}${demoUrl.hash}`);
      showUpdateOverlay(registration);
    }

    // Обновление уже ждёт (например, человек перезагрузил вкладку, но воркер
    // ещё не активировался) — показываем экран сразу, не дожидаясь updatefound.
    if (registration.waiting) {
      showUpdateOverlay(registration);
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        // Прежний воркер отдал управление и ждёт закрытия открытых страниц;
        // раньше этого момента обновление ещё не готово.
        if (installing.state !== 'installed') return;
        if (navigator.serviceWorker.controller) {
          showUpdateOverlay(registration);
        }
      });
    });
  } catch (err: unknown) {
    console.warn('[PWA] Service Worker не зарегистрирован, офлайн недоступен:', err);
  }
}

/**
 * Полноэкранное предложение обновить приложение.
 *
 * Почему не тост: плавающая плашка перекрывала TabBar на Android и ломала его
 * раскладку при перезагрузке. Полноэкранный слой не участвует в раскладке
 * приложения и после нажатия полностью удаляется.
 *
 * Перезагрузка обязательно активирует новый воркер (`SKIP_WAITING`). Без этого
 * после reload он снова оставался waiting, снова срабатывал updatefound — и
 * уведомление появлялось второй раз.
 */
function showUpdateOverlay(registration: ServiceWorkerRegistration): void {
  if (updateOverlayShown) return;
  if (document.getElementById('mood-update-overlay')) return;
  if (updateWasDismissed(registration)) return;

  updateOverlayShown = true;

  const overlay = document.createElement('div');
  overlay.id = 'mood-update-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'mood-update-title');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10000',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom))',
    'background:rgba(0,0,0,0.55)',
    'overscroll-behavior:contain',
    'font:400 15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:100%',
    'max-width:360px',
    'border-radius:20px',
    'padding:20px',
    'background:var(--surface)',
    'color:var(--text-primary)',
    'box-shadow:0 12px 40px rgba(0,0,0,0.35)',
  ].join(';');

  const title = document.createElement('h2');
  title.id = 'mood-update-title';
  title.textContent = 'Обновление Mood';
  title.style.cssText = 'margin:0 0 8px;font-size:18px;font-weight:650;';

  const text = document.createElement('p');
  text.textContent = 'Вышла новая версия приложения. Перезагрузите, чтобы применить её.';
  text.style.cssText = 'margin:0 0 16px;color:var(--text-secondary);';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Перезагрузить';
  button.style.cssText = [
    'appearance:none',
    'border:0',
    'border-radius:14px',
    'width:100%',
    'padding:13px 16px',
    'background:var(--accent)',
    'color:#fff',
    'font:600 16px/1 -apple-system,system-ui,sans-serif',
    'cursor:pointer',
  ].join(';');

  let reloading = false;
  const reload = (): void => {
    if (reloading) return;
    reloading = true;
    overlay.remove();
    window.location.reload();
  };

  button.addEventListener('click', () => {
    if (reloading) return;

    button.disabled = true;
    button.textContent = 'Обновляем…';
    button.style.opacity = '0.7';

    const waiting = registration.waiting;
    if (!waiting) {
      reload();
      return;
    }

    // Если iOS не активирует воркер с первого раза, эта же версия больше не
    // будет поднимать плашку после reload. Новая версия — новый scriptURL.
    rememberDismissedUpdate(registration);

    // Новый воркер активируется и забирает управление; перезагружаемся ровно
    // один раз — по controllerchange, со страховочным таймером.
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(reload, 1500);
  });

  panel.append(title, text, button);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}