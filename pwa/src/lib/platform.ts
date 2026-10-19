/**
 * Платформа клиента для заголовка X-PWA-Platform.
 *
 * Сервер и сам умеет читать User-Agent, но на iPad с включённым «Request
 * Desktop Site» и в standalone-режиме UA притворяется настольным Mac — по нему
 * устройство не отличить от компьютера. Поэтому приложение сообщает платформу
 * явно, а сервер использует заголовок как основной источник (см.
 * backend/utils/platform.ts).
 */

export type ClientPlatform = 'ios' | 'android' | 'web';

/**
 * iOS, включая iPadOS.
 *
 * iPadOS 13+ притворяется десктопным Mac («Macintosh»), поэтому одного UA мало:
 * планшет выдаёт мультитач, которого у настоящего Mac не бывает.
 */
export function detectClientPlatform(): ClientPlatform {
  const nav = window.navigator;
  const ua = nav.userAgent || '';

  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';

  const isIpad = /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  if (isIpad) return 'ios';

  if (/Android/i.test(ua)) return 'android';

  return 'web';
}

/** Заголовок платформы для запросов к API. */
export function platformHeader(): Record<string, string> {
  try {
    return { 'X-PWA-Platform': detectClientPlatform() };
  } catch {
    // Отсутствие navigator (SSR/тест) не должно ронять запрос.
    return {};
  }
}
