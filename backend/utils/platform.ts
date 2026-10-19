/**
 * Платформа клиента: по ней в /dev и в дневном отчёте считается разбивка
 * iOS / Android / Web.
 *
 * ── Откуда берётся значение ─────────────────────────────────────────────────
 *
 * 1. Кастомный заголовок `X-PWA-Platform`: его шлёт PWA (`pwa/src/lib/platform.ts`).
 *    Он честнее User-Agent: на iPad с «Request Desktop Site» и в standalone-режиме
 *    UA притворяется десктопным Mac, а заголовок остаётся верным.
 * 2. Если заголовка нет (старые сборки в кэше SW) — разбирается `User-Agent`.
 * 3. Если нет ни того ни другого — `unknown`. Пустой UA не должен ронять
 *    обработку: старые записи и служебные клиенты остаются без платформы.
 *
 * Модуль не знает про Fastify: на вход идут только заголовки запроса.
 */

/** Платформа клиента. `unknown` — не определили (нет UA/заголовка). */
export type UserPlatform = 'ios' | 'android' | 'web' | 'unknown';

/** Все возможные значения — для подсчётов и проверки заголовка. */
export const USER_PLATFORMS: readonly UserPlatform[] = ['ios', 'android', 'web', 'unknown'];

/** Заголовки запроса в том виде, в каком их отдаёт Node/Fastify. */
export interface PlatformHeaders {
  [name: string]: string | string[] | undefined;
}

function header(headers: PlatformHeaders, name: string): string {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/** Платформа из кастомного заголовка. Неизвестное значение — undefined. */
function fromHeader(headers: PlatformHeaders): UserPlatform | undefined {
  const value = header(headers, 'x-pwa-platform').toLowerCase();
  return (USER_PLATFORMS as readonly string[]).includes(value) ? (value as UserPlatform) : undefined;
}

/**
 * Платформа из User-Agent.
 *
 * Порядок проверок важен: Android содержит «Linux», а iPhone — «Mac OS X»,
 * поэтому конкретные признаки идут раньше общих.
 */
export function detectPlatformFromUserAgent(userAgent: string): UserPlatform {
  const ua = userAgent.trim();
  if (!ua) return 'unknown';

  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ в режиме планшета: «Macintosh» + мобильный движок.
  if (/Macintosh/i.test(ua) && /Mobile/i.test(ua)) return 'ios';

  if (/Android/i.test(ua)) return 'android';

  // Браузер на настольной ОС или любой другой клиент со своим UA.
  return 'web';
}

/**
 * Платформа запроса: кастомный заголовок, иначе User-Agent, иначе unknown.
 */
export function detectPlatform(headers: PlatformHeaders): UserPlatform {
  return fromHeader(headers) ?? detectPlatformFromUserAgent(header(headers, 'user-agent'));
}
