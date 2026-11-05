/**
 * REST API для PWA.
 *
 * Сервер живёт в одном процессе с фоновым нотификатором и переиспользует
 * сервисы приложения (userStore, кэш расписания, скрапер БАРС, OWA). Отдельная
 * копия этих сервисов разошлась бы с нотификатором по данным, поэтому здесь
 * только транспорт: проверка PWA-токена, выбор пользователя, вызов готовых
 * функций и сериализация. Telegram-бота в этом процессе нет — см.
 * `backend/server/main.ts` и `tg/bot.ts`.
 *
 * Запуск: npm run api (порт API_PORT, по умолчанию 3000)
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { AuthError, authHook } from './middleware/auth.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerLegalRoutes } from './routes/legal.ts';
import { registerGuestRoutes } from './routes/guest.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerScheduleRoutes } from './routes/schedule.ts';
import { registerBarsRoutes } from './routes/bars.ts';
import { registerMailRoutes } from './routes/mail.ts';
import { registerHomeworkRoutes } from './routes/homework.ts';
import { registerImportantRoutes } from './routes/important.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerThemeRoutes } from './routes/themes.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAnnouncementRoutes } from './routes/announcements.ts';
import { setupActivityTracking } from './devStats.ts';
import { GroupNotReadyError } from './routes/studentContext.ts';
import { MAX_FILE_SIZE_BYTES } from '../../db/storage/fileStore.ts';

function requestPathForLog(url: string): string {
  return apiPathname(url).replace(/^\/api\/files\/share\/[^/]+/, '/api/files/share/[redacted]');
}

/**
 * Путь запроса без query.
 *
 * Нельзя сравнивать сырой `request.url` с '/api': Fastify матчит и
 * `/%61pi/admin/stats`, и absolute-form `http://host/api/...`, а проверка по
 * префиксу строки их пропускает. Приводим к pathname через URL — тогда защита
 * не зависит от кодирования.
 */
function apiPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0] || '/';
  }
}

/**
 * Публичные адреса фронтендов: только они идут в CORS.
 *
 * Результат кэшируется по строке окружения: `allowedOrigins()` вызывается в
 * CORS-колбэке на каждый запрос с Origin, а разбор двух URL и Set на каждом
 * запросе — лишняя работа на ровном месте.
 */
let originsCache: { key: string; value: string[] } | null = null;

function allowedOrigins(): string[] {
  const cacheKey = [
    process.env.PWA_URL ?? '',
    process.env.APP_URL ?? '',
    process.env.NODE_ENV ?? '',
  ].join('|');
  if (originsCache?.key === cacheKey) return originsCache.value;

  const list: string[] = [];

  // Адрес PWA. Задаётся один: Mini App больше нет, отдельной раздачи тоже.
  for (const [envName, value] of [
    ['PWA_URL', process.env.PWA_URL],
    ['APP_URL', process.env.APP_URL],
  ] as const) {
    const raw = value?.trim();
    if (!raw) continue;

    try {
      const url = new URL(raw);
      const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !isLocalHttp) {
        console.warn(`[API] ${envName} должен использовать HTTPS — CORS origin не добавлен`);
        continue;
      }
      list.push(url.origin);
    } catch {
      console.warn(`[API] ${envName} задан, но не разбирается как URL — CORS не настроен`);
    }
  }

  // Локальная разработка фронтенда. В проде этих origin быть не должно:
  // они не дают токен, но расширяют поверхность без пользы.
  if (process.env.NODE_ENV !== 'production') {
    list.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  const origins = [...new Set(list)];
  originsCache = { key: cacheKey, value: origins };
  return origins;
}

/**
 * Единый обработчик ошибок.
 *
 * Смысловые коды (401/403/429/503) отдаются как есть — фронтенд по ним
 * решает, что показать. Неожиданные ошибки превращаются в 500 без деталей:
 * стек и внутренние адреса наружу не уходят.
 */
function setupErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AuthError) {
      return reply.code(error.code).send({
        error: error.error,
        message: error.message,
        needBarsLogin: error.error === 'bars_login_required',
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    }

    if (error instanceof GroupNotReadyError) {
      return reply
        .code(409)
        .send({ error: 'group_not_ready', message: error.message, needBarsLogin: true });
    }

    // Тело запроса не прошло валидацию Fastify.
    const status = (error as { statusCode?: number })?.statusCode;
    if (status === 400) {
      // Логируется код и текст: пустой ответ «400 Некорректный запрос» по
      // умолчанию неотличим от десятка разных причин, а разбираться придётся
      // вслепую. Имя ошибки при этом наружу не уходит.
      const detail = error as { code?: string; message?: string };
      console.error(`[API] 400: ${detail.code ?? 'bad_request'}`);
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'Некорректный запрос.' });
    }

    // Не печатаем исходный объект ошибки: Axios/Fastify ошибки могут содержать
    // URL, конфиг запроса и заголовки внешней сессии.
    const detail = error as { name?: string; code?: string; statusCode?: number };
    console.error('[API] необработанная ошибка:', {
      name: detail?.name ?? 'Error',
      code: detail?.code,
      statusCode: detail?.statusCode,
    });
    return reply
      .code(500)
      .send({ error: 'internal_error', message: 'Внутренняя ошибка сервера.' });
  });
}

/**
 * Замер времени обработки запроса.
 *
 * Нужен, чтобы отличить «медленный сервер» от «медленный БАРС, почта или РУЗ».
 * Без него в журнале видно только, что запрос кто-то открыл, а где именно он
 * провёл сорок минут — не видно.
 *
 * Логируются не все запросы, а два случая:
 *  - дольше SLOW_REQUEST_MS — их и нужно искать;
 *  - все, если в окружении стоит API_PERF_LOG=1 (точный режим разбора).
 *
 * По умолчанию Fastify молчит (`logger: false`): в журнале systemd процесс и так
 * пишет десятки строк за круг опроса БАРС, и лог каждого запроса забил бы его
 * бесполезными строками. Здесь — только исключения, и они как раз те, что
 * стоит читать.
 */
const SLOW_REQUEST_MS = 1000;

function perfLogEnabled(): boolean {
  return process.env.API_PERF_LOG === '1';
}

function setupRequestTiming(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    // Метка времени на самом запросе: в этот момент обработчик ещё не начался.
    (request as FastifyRequest & { moodStartedAt?: number }).moodStartedAt = Date.now();
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = (request as FastifyRequest & { moodStartedAt?: number }).moodStartedAt;
    if (!startedAt) return;

    const ms = Date.now() - startedAt;
    if (ms < SLOW_REQUEST_MS && !perfLogEnabled()) return;

    console.log(`[API] ${request.method} ${requestPathForLog(request.url)} ${reply.statusCode} ${ms}ms`);
  });
}

/**
 * Пути /api, открытые без токена.
 *
 * Это ровно те маршруты, по которым ещё некого проверять: вход, регистрация
 * и продолжение входа кодом из БАРС. Всё остальное требует PWA-токена.
 *
 * Перечисление точное, а не «всё, что начинается на /api/auth»: /api/auth/me
 * и logout как раз требуют токена, и случайно открытый маршрут здесь означал бы
 * запрос без проверки прав.
 */
function isPublicApiPath(request: { url: string; method: string }): boolean {
  const route = apiPathname(request.url);

  // Короткоживущая share-ссылка на файл: открывается в Safari без заголовка,
  // авторизация — сам одноразовый токен в пути (см. routes/files.ts).
  if (request.method === 'GET' && route.startsWith('/api/files/share/')) return true;

  // Публичный конфиг входа: TTL токена и рубильник регистрации. Нужен
  // экрану входа до появления токена, секретов не содержит.
  if (request.method === 'GET' && route === '/api/auth/config') return true;

  // Тексты документов нужны до входа: экран логина показывает ссылки.
  if (request.method === 'GET' && route === '/api/legal/documents') return true;

  // Гостю токен ещё не выдан: поиск группы и создание сессии открыты.
  if (request.method === 'GET' && route === '/api/guest/groups') return true;
  if (request.method === 'POST' && route === '/api/guest/session') return true;

  if (request.method !== 'POST') return false;

  return route === '/api/auth/login'
    || route === '/api/auth/register'
    || route === '/api/auth/2fa';
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // API слушает localhost за nginx. Доверяем только loopback proxy, чтобы
    // Fastify вычислял client IP справа налево по цепочке X-Forwarded-For;
    // публичный клиент не мог подделать owner-key антибрутфорса.
    trustProxy: '127.0.0.1',
    // Тело ограничено: записи ДЗ и объявлений небольшие, а крупный payload
    // не нужен и только тратит память процесса бота. Загрузка файлов идёт
    // отдельным маршрутом multipart со своим потолком (см. registerFileRoutes).
    bodyLimit: 256 * 1024,
  });

  // Потолки задаются здесь, а не в маршруте: @fastify/multipart применяет их
  // на разбор потока, и слишком большой файл должен отклоняться до того, как
  // целиком ляжет в память процесса. Размер берётся из fileStore, чтобы
  // разбор потока и saveFile не разъехались.
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 4 },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Запросы без Origin (например, health-check с VPS) пропускаем.
      if (!origin) return cb(null, true);
      const allowed = allowedOrigins();
      cb(null, allowed.includes(origin));
    },
    credentials: false,
    // PATCH и DELETE обязательны: /api/important/:id и /api/homework/:id уже
    // существуют, а без них кросс-доменный запрос упирается в preflight и
    // браузер блокирует его целиком. В dev это не проявлялось — Vite проксирует
    // /api и запрос уходит same-origin. Соответствие самому списку роутов —
    // единственный способ не разъехаться с ним снова.
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-PWA-Token', 'X-PWA-Platform'],
  });

  // Расписание и bootstrap персональны. SW/HTTP-кэши должны различать ответы
  // по токену, иначе на общем устройстве можно получить кэш другой учётной
  // записи. Публичные login/2FA/share-ответы никогда не кэшируются.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!apiPathname(request.url).startsWith('/api/')) return payload;

    if (isPublicApiPath(request)) {
      reply.header('Cache-Control', 'no-store');
      return payload;
    }

    const current = reply.getHeader('Vary');
    const varyValues = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!varyValues.some((value) => value.toLowerCase() === 'x-pwa-token')) {
      reply.header('Vary', [...varyValues, 'X-PWA-Token'].join(', '));
    }

    return payload;
  });

  // Замеры идут первым хуком: время считается от входа в обработчик, а не от
  // первого хука — иначе в счёт попала бы и проверка токена, и CORS.
  setupRequestTiming(app);

  // Проверка PWA-токена на всём /api — ни один обработчик не должен работать
  // без сессии. Исключения перечислены явно: см. isPublicApiPath.
  app.addHook('onRequest', async (request, reply) => {
    const path = apiPathname(request.url);
    if (path !== '/api' && !path.startsWith('/api/')) return;
    if (isPublicApiPath(request)) return;

    await authHook(request, reply);
  });

  // Сбор активности для /dev — новым хуком, после authHook (там уже стоит
  // request.userId) и до маршрутов (Fastify фиксирует хуки на маршруте при его
  // регистрации). Существующие хуки и маршруты не меняются.
  setupActivityTracking(app);

  setupErrorHandler(app);

  // Служебный эндпоинт без авторизации: для проверки живости процесса.
  app.get('/health', async () => ({ status: 'ok', uptime: Math.floor(process.uptime()) }));

  await registerAuthRoutes(app);
  await registerLegalRoutes(app);
  await registerGuestRoutes(app);
  registerAccountRoutes(app);
  await registerScheduleRoutes(app);
  await registerBarsRoutes(app);
  await registerMailRoutes(app);
  await registerHomeworkRoutes(app);
  await registerImportantRoutes(app);
  await registerFileRoutes(app);
  await registerNotificationRoutes(app);
  registerPushRoutes(app);
  registerThemeRoutes(app);
  registerAdminRoutes(app);
  registerAnnouncementRoutes(app);

  return app;
}

/**
 * Поднимает сервер на порту из API_PORT.
 * Возвращает инстанс, чтобы вызывающая сторона могла его остановить.
 */
export async function startServer(): Promise<FastifyInstance> {
  const port = Number(process.env.API_PORT ?? 3000);
  const host = process.env.API_HOST ?? '127.0.0.1';

  const app = await buildServer();
  await app.listen({ port, host });

  console.log(`[API] PWA API слушает http://${host}:${port}`);
  return app;
}

// Автономный запуск: node dist/api.js или npx tsx backend/server/index.ts
const isDirectRun = process.argv[1]?.includes('server/index') || process.argv[1]?.endsWith('api.ts');

if (isDirectRun) {
  startServer().catch((err: unknown) => {
    console.error('[API] не удалось запустить сервер:', err);
    process.exit(1);
  });
}
