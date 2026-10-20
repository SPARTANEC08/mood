/* eslint-env serviceworker */

/**
 * Service Worker веб-версии Mood.
 *
 * ЗАДАЧА САМОГО SW: сделать приложение полезным без сети, не превратив его в
 * источник чужих данных. Отсюда все решения ниже.
 *
 * ЧТО КЭШИРУЕТСЯ
 *   - оболочка (index.html, бандлы, CSS, иконки): cache-first. Хешированные
 *     имена файлов меняются при каждой сборке, поэтому «старая» копия всегда
 *     корректна для своей версии приложения;
 *   - /api/schedule: stale-while-revalidate. Расписание меняется раз в сутки и
 *     лежит на сервене в кэше, поэтому отдавать вчерашнее мгновенно лучше, чем
 *     ждать сеть. Нет сети — отдаётся вчерашнее, и это честно: в шапке стоит
 *     «обновлено»;
 *   - /api/bootstrap: network-first с таймаутом 3 с. Данные мелкие, но от них
 *     зависит сам факт открытия приложения, поэтому пробуем сеть первой, но не
 *     держим пользователя на спиннере дольше трёх секунд.
 *
 * ЧТО НЕ КЭШИРУЕТСЯ И ПОЧЕМУ
 *   - оценки, пропуски, приказы, стипендия, библиотека (/api/bars/**) —
 *     слишком динамичны и слишком личны: показанные вчера оценки, завтра будут
 *     враньём, которое студент не сможет отличить от правды;
 *   - /api/mail — под 30-секундным кулдауном на сервере, кэш только мешал бы;
 *   - /api/homework, /api/important — список без кэша приложение всё равно
 *     перезапрашивает после любого изменения, а показать устаревшие записи
 *     значит дать удалить не ту запись;
 *   - POST/PATCH/DELETE — всегда сеть, без исключений.
 *
 * ПРИВАТНОСТЬ
 *   - кэш хранится в Cache Storage конкретного origin: у другой учётной записи
 *     в том же браузере он другой, и на устройстве он стирается при удалении
 *     данных сайта;
 *   - авторизационный заголовок в кэш НЕ попадает: cache.put сохраняет ответ,
 *     а не запрос, и мы никогда не отдаём кэш ответ на чужой токен, потому что
 *     стратерии применяются к URL, а не к личности.
 *
 * Версия кэша — метка сборки. Плейсхолдер __SW_VERSION__ подставляется в
 * dist/sw.js скриптом scripts/inject-sw-version.mjs после сборки; в этом файле
 * он обязан остаться, иначе вторая сборка получит ту же версию и Service Worker
 * не обновит кэш. Менять руками не нужно.
 */

const VERSION = '__SW_VERSION__';
const SHELL_CACHE = `mood-shell-${VERSION}`;
const DATA_CACHE = `mood-data-${VERSION}`;

/** Сколько последних ответов /api/schedule держим. */
const SCHEDULE_CACHE_LIMIT = 3;

const OFFLINE_URL = '/offline.html';

/**
 * Оболочка, которая должна быть в кэше всегда.
 *
 * '/' запрашивается отдельно: он отдаёт index.html, и без него офлайн-экран
 * был бы просто страницей «нет сети» вместо самого приложения.
 *
 * Самих бандлов здесь нет и быть не может: их имена содержат хеш и меняются
 * при каждой сборке. Они добавляются в install из манифеста сборки — см.
 * precacheBuildAssets.
 */
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png?v=2',
  '/icons/icon-512.png?v=2',
  '/icons/icon-maskable-512.png?v=2',
  '/icons/apple-touch-icon.png?v=2',
  '/icons/site-icon-192.png?v=2',
];

/** Манифест Vite: машинное описание того, что лежит в dist. */
const BUILD_MANIFEST_URL = '/.vite/manifest.json';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll падает целиком при любой ошибке, поэтому кладём по одному:
      // одна отсутствующая иконка не должна срывать установку оболочки.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            // Недоступно — приложение всё равно загрузится по сети в этот раз.
          }
        }),
      );

      // Бандлы и стили — отдельным шагом: их имена известны только из
      // манифеста сборки.
      await precacheBuildAssets(cache);

      // Новая версия вступает в силу сразу, а не после закрытия всех вкладок:
      // пользователь не возвращается к старому экрану иначе узнает об обновлении
      // только через принудительную перезагрузку DevTools.
      await self.skipWaiting();
    })(),
  );
});

/**
 * Кладёт в кэш всё, что перечислил манифест сборки.
 *
 * Зачем читать манифест, а не перечислить файлы руками: имена бандлов содержат
 * хеш содержимого и меняются при каждой сборке. Захардкодить их можно только
 * вручную, и тогда офлайн-оболочка открывалась бы с index.html, из которого не
 * подгрузился бы ни один скрипт и ни один стиль — то есть белый экран вместо
 * приложения.
 *
 * Отсутствие манифела — не повод отменять установку: приложение должно
 * открываться и по сети, а офлайн появится после следующей сборки, где
 * манифест будет.
 */
async function precacheBuildAssets(cache) {
  try {
    const response = await fetch(BUILD_MANIFEST_URL, { cache: 'reload' });
    // Ответ не-JSON или 404 — уходим на разбор index.html: точка в названии
    // файла означает, что статику положили неполной (см. precacheFromHtml).
    if (!response.ok) {
      await precacheFromHtml(cache);
      return;
    }

    const manifest = await response.json();
    if (!manifest || typeof manifest !== 'object') {
      await precacheFromHtml(cache);
      return;
    }

    const urls = new Set();

    for (const entry of Object.values(manifest)) {
      if (entry.file) urls.add(`/${entry.file}`);
      for (const css of entry.css ?? []) urls.add(`/${css}`);
      for (const asset of entry.assets ?? []) urls.add(`/${asset}`);
    }

    // Манифест сам в офлайне не нужен — занимал бы место и устаревал бы раньше
    // содержимого, ради которого существует.
    urls.delete(BUILD_MANIFEST_URL);

    await Promise.all(
      [...urls].map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          // Один отсутствующий файл не срывает остальные.
        }
      }),
    );
  } catch {
    // Манифеста нет или сеть недоступна — уходим на статику PRECACHE_URLS.
    await precacheFromHtml(cache);
  }
}

/**
 * Кладёт в кэш бандлы и стили, перечисленные прямо в index.html.
 *
 * Запасной путь, и он не косметический. Манифест сборки лежит в КА ТАЛОГЕ С
 * ТОЧКОЙ (`/.vite/manifest.json`), а такая публикация ломается молча и на
 * nginx, и на хостингах: `cp -r dist/*` точку не копирует, часть CDN и
 * статических хостингов прячет каталоги, начинающиеся с точки, а nginx с
 * типовым правилом «спрятать всё, что начинается с точки» отдаёт по этому пути
 * index.html — то есть ответ приходит, статус 200, и разбор молча падает
 * ниже по стеку.
 *
 * Последствие такого провала видно только в standalone и только при плохой
 * сети: оболочка в кэше есть (index.html), а скриптов и стилей в ней нет, и
 * приложение открывается белым экраном. Ровно это и было с Android.
 *
 * Разбор index.html не заменяет манифест: он не видит ленивых чанков и всех
 * файлов, а только те, что действительно подключены к первой загрузке. Но для
 * оболочки — этого достаточно, и работает оно везде, независимо от того, как
 * статику раздали.
 */
async function precacheFromHtml(cache) {
  try {
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) return;

    const html = await response.text();
    const urls = new Set();

    // Атрибуты, по которым в index.html перечислены бандлы и стили.
    for (const pattern of [
      /<script[^>]+src=["']([^"']+)["']/gi,
      /<link[^>]+href=["']([^"']+)["']/gi,
    ]) {
      let match = pattern.exec(html);
      while (match) {
        const url = match[1];
        // Только свои файлы и только абсолютные пути от корня: ссылка на
        // внешний домен не наш, а относительный путь надо привести к корню.
        if (url.startsWith('/') && !url.startsWith('//')) urls.add(url);
        match = pattern.exec(html);
      }
    }

    // Манифест и иконки из PRECACHE_URLS повторять не нужно, но безобидно;
    // ключи убираем, чтобы не кэшировать одно и то же дважды.
    for (const url of PRECACHE_URLS) urls.delete(url);

    await Promise.all(
      [...urls].map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          // Один отсутствующий файл не срывает остальные.
        }
      }),
    );
  } catch {
    // Ни манифеста, ни index.html: приложение откроется по сети, офлайн
    // появится после следующей сборки.
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // Чужие кэши (например, от другой версии эксперимента) не трогаем:
          // префиксы жёсткие, всё остальное не наше.
          .filter((name) => name.startsWith('mood-') && name !== SHELL_CACHE && name !== DATA_CACHE)
          .map((name) => caches.delete(name)),
      );

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // Ручное «применить обновление сейчас»: нужно на страницах, где вкладок
  // несколько и skipWaiting ждёт закрытия последней.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Кэшируются только GET. Любая мутация уходит в сеть целиком.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Чужие схемы и расширения не перехватываем: у blob:/data: origin вообще
  // равен 'null', а у chrome-extension:// он совпадает с чужим — обе ситуации
  // должны просто пройти мимо, а не попасть в наш кэш.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  // Выдача токена никогда не кэшируется: ответ содержит секрет, и кэш
  // браузера — не то место, где он должен лежать.
  if (url.pathname === '/api/pwa/issue') return;

  // /health — служебный ответ API, не статика: его кэширование дало бы
  // «живой» статус при упавшем процессе.
  if (url.pathname === '/health') return;

  // sw.js не кэшируется вовсе. Иначе обновление не доезжает: браузер получил бы
  // воркер из кэша, увидел бы старую версию и не установил новый. Именно поэтому
  // в URL воркера добавлен ?v=mv2fyyjk — но и без этого правила его быть
  // не должно.
  if (url.pathname === '/sw.js') return;

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/schedule') {
      event.respondWith(scheduleStrategy(request));
      return;
    }
    if (url.pathname === '/api/bootstrap') {
      event.respondWith(networkFirstWithTimeout(request, 8000));
      return;
    }
    // Остальные /api — мимо кэша целиком.
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/**
 * Оболочка: сначала кэш, обновление — в фоне.
 *
 * Фоновое обновление обязательно: без него пользователь после деплоя получил бы
 * старый бандл и не смог бы открыть приложение, пока не почистит кэш вручную.
 */
async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Обновляем в фоне, не дожидаясь результата: пользователь не должен ждать
    // сеть ради того, чтобы увидеть то, что уже есть.
    void refreshInBackground(cache, request);
    return cached;
  }

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}

async function refreshInBackground(cache, request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok && fresh.type === 'basic') {
      await cache.put(request, fresh);
    }
  } catch {
    // Сети нет — остаётся то, что в кэше. Это и есть смысл cache-first.
  }
}

/**
 * Навигационный запрос.
 *
 * Сеть первой, чтобы подхватить новую сборку. Фолбэк — НЕ сразу offline.html:
 * сначала пробуем оболочку из кэша, потому что приложение, умеющее открыться
 * без сети и показать последнее расписание, полезнее заглушки. offline.html
 * показываем только если оболочки тоже нет (первый запуск офлайн).
 */
async function navigationStrategy(request) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(request.url);
  // Оболочкой приложения считаются только корень и index.html. Служебные
  // страницы (/dev/, /test/) тоже navigation-запросы, но класть их в ключ '/'
  // нельзя: иначе после открытия такой страницы офлайн-приложение показывало бы
  // её вместо Mood.
  const isAppShell = url.pathname === '/' || url.pathname === '/index.html';

  try {
    const fresh = await fetch(request);
    if (fresh.ok && isAppShell) {
      await cache.put('/', fresh.clone());
    }
    return fresh;
  } catch {
    if (!isAppShell) {
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
      return new Response('Нет сети.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const shell = await cache.match('/');
    if (shell) return shell;

    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;

    return new Response('Нет сети и нет сохранённой копии приложения.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Сеть первой, но не дольше таймаута.
 *
 * Отдельная стратегия, а не network-first без таймаута: /api/bootstrap должен
 * ответить за секунды даже при мёртвом БАРС, и ждать там дефолтных 20 секунд
 * клиента бессмысленно.
 *
 * Но 3 секунды — слишком мало. Bootstrap ходит в БАРС, ts.mpei.ru и IMAP, и
 * при старте приложения он идёт одновременно ещё с шестью другими запросами;
 * на мобильном интернете он спокойно укладывается в 3.1–3.2 секунды. Обрыв
 * ровно на границе выглядел как «нет связи с сервером», хотя сеть была: ровно
 * тот случай, когда приложение врёт пользователю. 8 секунд — с запасом на
 * медленный канал, но всё ещё намного меньше дефолтных 20.
 */
async function networkFirstWithTimeout(request, timeoutMs) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(request, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({ error: 'offline', message: 'Нет связи с сервером.', needBarsLogin: false }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
}

/**
 * Расписание: вчерашнее мгновенно, свежее в фоне.
 *
 * Отдельная копия кэша для каждого сочетания startDate/endDate: приложение
 * спрашивает разные диапазоны, и смешивать их нельзя. Старые записи
 * подрезаются, иначе за semester накапливаются десятки мегабайт.
 */
async function scheduleStrategy(request) {
  const cache = await caches.open(DATA_CACHE);

  const cached = await cache.match(request);

  if (cached) {
    void refreshInBackground(cache, request);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      void trimCache(cache, SCHEDULE_CACHE_LIMIT);
    }
    return response;
  } catch {
    // Ни сети, ни кэша — синтетический 503 того же вида, что у API: клиент
    // покажет штатный ErrorState, а не упадёт на разборе пустого ответа.
    return new Response(
      JSON.stringify({
        error: 'schedule_unavailable',
        message: 'Нет сети и нет сохранённого расписания.',
        needBarsLogin: false,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
}

/**
 * Оставляет в кэше последние N записей.
 *
 * Порядок вставки в Cache Storage сохраняется, поэтому достаточно убрать всё
 * с начала списка.
 */
async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;

  for (const key of keys.slice(0, keys.length - limit)) {
    await cache.delete(key);
  }
}