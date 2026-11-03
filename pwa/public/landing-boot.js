/**
 * Первый экран для тех, кто ещё не вошёл.
 *
 * Приложение остаётся на «/»: его URL, манифест, Service Worker и APK не
 * меняются. Если PWA-токена нет, корень сразу уводит на статический лендинг.
 * Главная кнопка лендинга ведёт на «/setup» — отдельный экран установки без
 * входа; «/?login=1» оставлен как прямой вход для старых ссылок.
 *
 * Скрипт синхронный и стоит в <head> до React: без него приложение успевало
 * показать экран входа, а затем прыгало на лендинг.
 */
(function () {
  try {
    var path = window.location.pathname;
    if (path !== '/' && path !== '/index.html') return;

    var params = new URLSearchParams(window.location.search);
    if (
      params.get('install') === '1' ||
      params.get('login') === '1' ||
      params.get('guest') === '1' ||
      params.get('debug') === '1'
    ) {
      return;
    }

    // Ссылка из статьи переезда должна показывать лендинг даже внутри
    // standalone-оболочки старой PWA, а не экран авторизации.
    if (params.get('from') === 'migration') {
      window.location.replace('/landing.html?from=migration' + window.location.hash);
      return;
    }

    // Установленное приложение не должно открывать маркетинговый лендинг:
    // без токена ему нужен обычный экран входа.
    var standalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      document.referrer.indexOf('android-app://') === 0;

    if (standalone) return;

    var token = window.localStorage.getItem('mood_pwa_token');
    if (!token) {
      // Хэш сохраняем: ссылки вида /#install должны открывать раздел установки,
      // а не начало лендинга.
      window.location.replace('/landing.html' + window.location.hash);
    }
  } catch (error) {
    // Приватный режим или отключённое хранилище: показываем обычный экран входа.
  }
})();
