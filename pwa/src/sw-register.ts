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

/** Тост предложения обновить приложение. Один за сессию — см. ниже. */
let updateToastShown = false;

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

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        // Прежний воркер отдал управление и ждёт закрытия открытых страниц;
        // раньше этого момента обновление ещё не готово.
        if (installing.state !== 'installed') return;
        if (navigator.serviceWorker.controller) {
          showUpdateToast();
        }
      });
    });
  } catch (err: unknown) {
    console.warn('[PWA] Service Worker не зарегистрирован, офлайн недоступен:', err);
  }
}

/**
 * Кнопка «перезагрузить» — единственный способ применить новую версию.
 *
 * Показывается один раз за сессию: sw.js кэшируется по URL с версией, но сам
 * браузер переспрашивает его и при установке, поэтому тост мог бы появляться
 * каждые несколько минут поверх работы. Флаг живёт до перезагрузки страницы,
 * которая как раз и применяет обновление.
 */
function showUpdateToast(): void {
  if (updateToastShown) return;
  if (document.getElementById('mood-update-toast')) return;

  updateToastShown = true;

  const toast = document.createElement('div');
  toast.id = 'mood-update-toast';
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed',
    'left:50%',
    'transform:translateX(-50%)',
    'bottom:calc(20px + env(safe-area-inset-bottom))',
    'z-index:100',
    'display:flex',
    'gap:12px',
    'align-items:center',
    'padding:10px 14px',
    'border-radius:14px',
    'background:var(--surface)',
    'color:var(--text-primary)',
    'border:1px solid var(--separator-soft,rgba(0,0,0,.1))',
    'box-shadow:0 4px 20px rgba(0,0,0,.12)',
    'font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = 'Доступна новая версия';

  const button = document.createElement('button');
  button.type = 'button';
  // Именно «Перезагрузить», а не «Обновить»: кнопка перезагружает страницу
  // целиком (применяет новый Service Worker), а не обновляет данные. Слово
  // «Обновить» в интерфейсе закреплено за данными, и путать эти действия
  // нельзя — человек нажмёт «Обновить» и не поймёт, почему приложение мигнуло.
  button.textContent = 'Перезагрузить';
  button.style.cssText = [
    'appearance:none',
    'border:0',
    'border-radius:10px',
    'padding:7px 12px',
    'background:var(--accent)',
    'color:var(--lesson-chip-text)',
    'font:600 14px/1 -apple-system,system-ui,sans-serif',
    'cursor:pointer',
  ].join(';');
  button.addEventListener('click', () => {
    toast.remove();
    window.location.reload();
  });

  toast.append(text, button);
  document.body.appendChild(toast);
}