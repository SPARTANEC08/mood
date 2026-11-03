/*
 * Kill-switch старой шведской PWA.
 *
 * Задача — не дать старому service worker продолжать отдавать закэшированное
 * приложение и увести открытые вкладки на страницу переезда в РФ.
 *
 * Файл кладётся на SE-сервер вместо /sw.js. Браузер проверяет обновление
 * service worker при навигации, устанавливает этот файл, активирует его,
 * чистит Cache Storage и переходит на mood-app.ru.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // Cache Storage может быть недоступен — это не мешает блокировке.
      }

      const target = 'https://mood-app.ru/migration/';

      try {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        await Promise.all(
          clients.map((client) =>
            'navigate' in client ? client.navigate(target).catch(() => undefined) : Promise.resolve(),
          ),
        );
      } catch {
        // Старые вкладки могли уже закрыться.
      }

      try {
        await self.registration.unregister();
      } catch {
        // Если unregister не сработал, SW всё равно не кэширует запросы.
      }

      try {
        await self.clients.openWindow(target);
      } catch {
        // openWindow может быть запрещён без пользовательского жеста.
      }
    })(),
  );
});

// Никакого кэша: все запросы идут в сеть, где nginx отдаёт страницу переезда.
self.addEventListener('fetch', () => {});
