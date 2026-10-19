/**
 * Низкоуровневый HTTP-клиент приложения: базовый URL, токен, таймауты и
 * разбор ответа/ошибок.
 *
 * Единственный способ авторизации — заголовок X-PWA-Token с токеном, выданным
 * при входе логином и паролем БАРС. Токен хранится в localStorage, а не в
 * cookie: cookie уехала бы на любой запрос домена, включая сторонние счётчики,
 * а заголовок живёт ровно там, где нужен.
 */

import { perfLog } from '@/lib/perf';
import { platformHeader } from '@/lib/platform';

export const BASE = '/api';

/** Ключ хранилища токена в localStorage. */
const PWA_TOKEN_STORAGE_KEY = 'mood_pwa_token';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** true = приложению нужно предложить вход в БАРС через бота. */
    readonly needBarsLogin = false,
    /** Что делать на фронтенде: показать вход, повторить или показать ошибку. */
    readonly kind: 'unauthorized' | 'cooldown' | 'conflict' | 'server' | 'network' = 'server',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Таймаут запроса: сетевой висящий запрос хуже явной ошибки. */
  timeoutMs?: number;
}

/**
 * Заголовок авторизации.
 *
 * Заголовок, а не query-параметр: токен — это пароль, и в query он попал бы в
 * access-логи сервера, историю браузера и заголовок Referer.
 */
export function authHeader(): Record<string, string> {
  const token = readPwaToken();
  return { ...(token ? { 'X-PWA-Token': token } : {}), ...platformHeader() };
}

/** Токен лежит в localStorage: он переживает перезагрузку и закрытие вкладки. */
export function readPwaToken(): string {
  try {
    return window.localStorage.getItem(PWA_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    // Приватный режим Safari и отключённое хранилище: считаем, что токена нет.
    return '';
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 20000 } = options;
  const startedAt = Date.now();

  // Отменяем запрос, если ответ не пришёл вовремя: иначе спиннер в интерфейсе
  // может крутиться бесконечно.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...authHeader(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';

    // Замер обрывается раньше, чем бросается ошибка: по этой строке сразу видно,
    // что запрос уперся в таймаут, а не в отказ сети.
    perfLog(`${method} ${path} ${aborted ? `timeout ${timeoutMs}ms` : 'network-error'}`, Date.now() - startedAt);

    throw new ApiError(
      aborted ? 'Сервер не ответил вовремя.' : 'Нет связи с сервером.',
      0,
      false,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('Сервер вернул некорректный ответ.', response.status);
    }
  }

  perfLog(`${method} ${path} ${response.status}`, Date.now() - startedAt);

  if (!response.ok) {
    const data = (payload ?? {}) as { message?: string; needBarsLogin?: boolean; retryAfterMs?: number };
    const kind =
      response.status === 401
        ? 'unauthorized'
        : response.status === 429
          ? 'cooldown'
          : response.status === 409
            ? 'conflict'
            : 'server';

    throw new ApiError(
      data.message ?? `Ошибка ${response.status}`,
      response.status,
      data.needBarsLogin === true,
      kind,
    );
  }

  return payload as T;
}
