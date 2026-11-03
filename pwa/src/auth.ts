/**
 * Хранение PWA-токена и вход по логину БАРС.
 *
 * Схема входа. Приложение открывается как обычный сайт и как PWA с иконки, то
 * есть вне Telegram, где подписи Telegram (initData) не существует вовсе.
 * Поэтому личность подтверждается собственными учётными данными — логином и
 * паролем от личного кабинета БАРС. Сервер проверяет их по-настоящему, а не
 * доверяет на слово, и отдаёт токен на 90 дней.
 *
 * Где лежит токен. localStorage под ключом mood_pwa_token, и НЕ cookie: cookie
 * уехала бы на любой запрос домена, включая сторонние счётчики и аналитику, а
 * заголовок X-PWA-Token живёт ровно там, где нужен. Цена решения — токен виден
 * скриптам на этой странице, но страница и так отдаёт ему все данные
 * пользователя, поэтому дополнительного риска это не создаёт.
 *
 * Как живут два клиента. Бот и PWA — один и тот же человек, но входят они
 * независимо. Общая точка — sha256 от нормализованного логина БАРС; сервер по
 * нему находит ту же запись и отдаёт тот же userId. Один аккаунт можно
 * использовать одновременно в боте и PWA.
 */

import type { BootstrapProfile } from './types/api';
import { syncAccentWithAuth } from './lib/accent';
import { perfLog } from './lib/perf';
import { platformHeader } from './lib/platform';
import { CACHE_KEYS, clearPersistedData, clearPreviewCache, readJson } from './lib/data/tier1';
import { clearFileCache } from './lib/fileCache';
import { clearPreviewUrlCache } from './lib/api/files.ts';

const TOKEN_KEY = 'mood_pwa_token';
const EXPIRES_KEY = 'mood_pwa_token_expires';
const GUEST_KEY = 'mood_guest_mode';

/** Что сервер отдаёт при успешном входе. */
export interface PwaTokenResponse {
  token: string;
  expiresAt: number;
  userId: string;
  profile: BootstrapProfile;
}

/** Что сервер отдаёт, когда нужен код подтверждения. */
export interface TwoFactorChallenge {
  challengeId: string;
}

/**
 * Ошибка входа с кодом и машинным именем.
 *
 * Код ошибки обязателен отдельно от HTTP-статуса: клиенту нужно показать
 * «неверный пароль» отдельно от «подождите 15 минут». По одному статусу это
 * 401 и 429, и без машинного имени экран не сможет отличить эти случаи.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly error: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Токен, если он есть. */
export function getPwaToken(): string | null {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    // Приватный режим или заблокированное хранилище.
    return null;
  }
}

/** userId из подписанного токена — только для локальной проверки cache ownership. */
export function getPwaTokenUserId(): string | null {
  const token = getPwaToken();
  if (!token) return null;

  try {
    const encodedId = token.split('.')[0];
    if (!encodedId) return null;
    const base64 = encodedId.replace(/-/g, '+').replace(/_/g, '/');
    const userId = window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return /^[0-9a-f-]{36}$/i.test(userId) ? userId.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Сохраняет выданный токен. */
export function setPwaToken(token: string, expiresAt: number): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(EXPIRES_KEY, String(expiresAt));
  } catch {
    // Записать не удалось — приложение отработает эту сессию без токена и
    // снова спросит логин. Молчаливый отказ здесь лучше падения.
  }

  // Акцент — только для авторизованного приложения: после входа возвращаем
  // сохранённый цвет, до него остаётся встроенный фиолетовый.
  syncAccentWithAuth();
}

/**
 * Событие «сессия закончилась».
 *
 * Нужно потому, что токен стирается из модуля, а экран входа живёт в App.tsx
 * и про localStorage ничего не знает. Без события выход «сработал бы, но ничего
 * бы не показало»: приложение продолжило бы рендериться с данными, которые
 * сервер больше не отдаёт.
 */
export const SIGNED_OUT_EVENT = 'mood:signed-out';

function announceSignedOut(): void {
  try {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  } catch {
    // см. выше
  }
}

/** Забывает токен: он истёк, отозван выходом или приложение сменило устройство. */
export function clearPwaToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(EXPIRES_KEY);
    window.localStorage.removeItem(GUEST_KEY);
  } catch {
    // см. выше
  }

  clearPersistedData();
  clearFileCache();
  clearPreviewCache();
  clearPreviewUrlCache();

  // Экран входа снова фиолетовый: акцент — часть оформления приложения, а не
  // публичных страниц. Сам выбор в storage остаётся и вернётся после входа.
  syncAccentWithAuth();

  announceSignedOut();
}

/** Последний вход был гостевым: нужен только для выбора оболочки до bootstrap. */
export function isGuestMode(): boolean {
  try {
    return window.localStorage.getItem(GUEST_KEY) === '1';
  } catch {
    return false;
  }
}

export function setGuestMode(): void {
  try {
    window.localStorage.setItem(GUEST_KEY, '1');
  } catch {
    // Приватный режим: гость всё равно откроется по профилю из bootstrap.
  }

  // Гостю настройка акцента недоступна: гасим цвет, даже если на устройстве
  // остался выбор прошлого аккаунта.
  syncAccentWithAuth();
}

export function clearGuestMode(): void {
  try {
    window.localStorage.removeItem(GUEST_KEY);
  } catch {
    // см. выше
  }

  syncAccentWithAuth();
}

/** Истёк ли токен по известной метке времени. */
export function isPwaTokenExpired(now: number = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(EXPIRES_KEY);
    if (!raw) return false;
    const expiresAt = Number(raw);
    if (!Number.isFinite(expiresAt)) return false;
    return now >= expiresAt;
  } catch {
    return false;
  }
}

/** Есть ли рабочий токен. */
export function hasUsablePwaToken(): boolean {
  return getPwaToken() !== null && !isPwaTokenExpired();
}

interface AuthFailure {
  error: string;
  message: string;
  challengeId?: string;
  retryAfterMs?: number;
}

/** Тело ответа: успех, отказ или требование кода подтверждения. */
type AuthPayload = Partial<AuthFailure> & Partial<PwaTokenResponse>;

/**
 * Один POST к эндпоинту входа.
 *
 * Тело разбирается здесь, а не вызывающим кодом, по одной причине: `need_2fa`
 * — это не ошибка, а ВТОРАЯ СТРАНИЦА входа. Сервер уже пошёл в БАРС, запрос там
 * висит и ждёт кода; повторный вход с тем же паролем был бы лишним походом и
 * выдал бы другую сессию. Поэтому challengeId обязан дойти до экрана ввода кода
 * вместе с фактом «нужен код», а не потеряться в общем разборе ошибок.
 */
async function postAuth(
  path: string,
  payload: unknown,
): Promise<PwaTokenResponse | { challengeId: string }> {
  const startedAt = Date.now();
  perfLog(`auth ${path} start`);

  let response: Response;

  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...platformHeader() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // Таймаут и обрыв сети неразличимы для пользователя, и различать их незачем.
    perfLog(`auth ${path} failed ${Date.now() - startedAt}ms`);
    throw new AuthError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 'network');
  }

  let body: AuthPayload | null = null;

  try {
    body = (await response.json()) as AuthPayload;
  } catch {
    // ответ не JSON — ниже отдастся по коду статуса
  }

  // Итог входа: по этой строке видно, сколько занял поход в БАРС и чем он кончился.
  // Особенно важен случай need_2fa — он означает, что БАРС ответил быстро и
  // дальше человек ждёт уже СМС, а не сеть.
  perfLog(`auth ${path} ${response.ok ? 'ok' : body?.error ?? response.status}`, Date.now() - startedAt);

  if (response.ok) {
    const issued = body as PwaTokenResponse;

    // Ответ входа может принадлежать другому аккаунту (например, после
    // истечения токена). Не восстанавливаем чужие данные/файлы из общего
    // browser storage и in-memory cache на этом устройстве.
    const cachedProfile = readJson<BootstrapProfile>(CACHE_KEYS.profile);
    if (cachedProfile?.userId !== issued.userId) clearPersistedData();
    clearFileCache();
    clearPreviewCache();
    clearPreviewUrlCache();

    setPwaToken(issued.token, issued.expiresAt);
    return issued;
  }

  if (body?.error === 'need_2fa') {
    return { challengeId: body.challengeId ?? '' };
  }

  throw new AuthError(
    body?.message ?? `Ошибка ${response.status}`,
    body?.error ?? 'unknown',
    body?.retryAfterMs,
  );
}

/**
 * Вход по логину и паролю БАРС.
 *
 * Возвращает либо токен, либо `{ challengeId }` — в этом случае вход не
 * завершён, пока не введён код из БАРС.
 *
 * Запись заводится автоматически, если её ещё нет: отдельного «регистрационного»
 * шага у человека больше нет.
 */
export async function loginWithPassword(
  login: string,
  password: string,
  consents: string[] = [],
): Promise<PwaTokenResponse | { challengeId: string }> {
  return postAuth('/api/auth/login', { login, password, consents });
}

/** Продолжение входа кодом из БАРС. */
export async function confirmTwoFactor(
  challengeId: string,
  code: string,
): Promise<PwaTokenResponse> {
  return postAuth('/api/auth/2fa', { challengeId, code }) as Promise<PwaTokenResponse>;
}

/**
 * Выход с устройства.
 *
 * Ошибка игнорируется намеренно: токен всё равно стирается локально, и если
 * сервер недоступен, человек должен выйти из приложения, а не застрять на нём.
 */
export async function logout(): Promise<void> {
  const token = getPwaToken();

  /*
   * Сначала снимаем подписку на push, пока токен ещё действителен.
   *
   * Иначе устройство осталось бы подписанным на аккаунт, с которого человек
   * вышел, и следующий владелец телефона получал бы чужие оценки на экран
   * блокировки. Импорт динамический: lib/push тянет API-клиент, который сам
   * зависит от этого модуля, и статический импорт замкнул бы цикл.
   */
  try {
    if (token) {
      const { disablePush } = await import('./lib/push');
      await disablePush();
    }
  } catch {
    // Не смогли отписаться — не повод не выходить.
  }

  try {
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-PWA-Token': token, Accept: 'application/json' },
      });
    }
  } catch {
    // сервер не ответил — см. выше
  } finally {
    clearPwaToken();
  }
}

/** Отличить успешный вход от требования кода одним признаком. */
export function isTwoFactorRequired(
  result: PwaTokenResponse | { challengeId: string },
): result is { challengeId: string } {
  return typeof (result as { challengeId?: string }).challengeId === 'string';
}
