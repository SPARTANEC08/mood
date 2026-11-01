/**
 * Аварийное самовосстановление клиента.
 *
 * Вынесено из index.html в отдельный файл, чтобы CSP могла запретить inline-
 * скрипты (`script-src 'self'`). Логика прежняя: если через 6 секунд React не
 * смонтировался, один раз за сессию чистим Cache Storage, снимаем Service
 * Worker и перезагружаемся.
 */
      (function () {
        try {
          var RECOVERY_KEY = 'mood_boot_recovery';
          var timer = setTimeout(function () {
            var root = document.getElementById('root');
            if (root && root.childElementCount > 0) return;
            if (sessionStorage.getItem(RECOVERY_KEY) === '1') return;
            sessionStorage.setItem(RECOVERY_KEY, '1');

            var tasks = [];
            if (window.caches && caches.keys) {
              tasks.push(
                caches.keys().then(function (names) {
                  return Promise.all(names.map(function (name) { return caches.delete(name); }));
                })
              );
            }
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
              tasks.push(
                navigator.serviceWorker.getRegistrations().then(function (regs) {
                  return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
                })
              );
            }
            Promise.all(tasks)
              .catch(function () {})
              .then(function () { location.reload(); });
          }, 6000);

          var observer = new MutationObserver(function () {
            var root = document.getElementById('root');
            if (root && root.childElementCount > 0) {
              clearTimeout(timer);
              observer.disconnect();
            }
          });
          observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {
          /* без восстановления приложение всё равно попробует загрузиться */
        }
      })();
