/**
 * Первый экран для тех, кто ещё не вошёл.
 *
 * Приложение остаётся на «/»: его URL, манифест, Service Worker и APK не
 * меняются. Если PWA-токена нет, корень сразу уводит на статический лендинг,
 * а лендинг ведёт на «/?login=1» — этот параметр отключает редирект, чтобы
 * человек попал на экран входа, а не обратно на лендинг.
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
      params.get('login') === '1' ||
      params.get('guest') === '1' ||
      params.get('debug') === '1'
    ) {
      return;
    }

    var token = window.localStorage.getItem('mood_pwa_token');
    if (!token) {
      window.location.replace('/landing.html');
    }
  } catch (error) {
    // Приватный режим или отключённое хранилище: показываем обычный экран входа.
  }
})();
