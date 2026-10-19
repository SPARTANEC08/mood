/**
 * Открытие PDF системным просмотрщиком браузера.
 *
 * ── Почему не свой просмотрщик ──────────────────────────────────────────────
 *
 * PDF.js с canvas мы пробовали: на iOS он требует своего UI, а на Android падал
 * на старых WebView (нет Promise.withResolvers) и оставлял белый экран. Для PDF
 * достаточно системного просмотра: Safari и Chrome рисуют документ штатно, дают
 * «Поделиться», зум и закрытие — и ничего не весят в бандле.
 *
 * ── Как обходим невозможность открыть URL с заголовком токена ───────────────
 *
 * Файлы лежат за авторизацией (`X-PWA-Token`), а браузер при открытии ссылки
 * заголовков не шлёт. Поэтому берём у сервера КОРОТКОЖИВУЮ подписанную ссылку
 * (`/api/files/share/:token`): она отдаёт файл без токена в заголовке — и токен
 * при этом в URL не попадает (в самой ссылке случайный одноразовый ключ).
 *
 * ── Android ─────────────────────────────────────────────────────────────────
 *
 * В Android-приложении (TWA) и в Custom Tab PDF не открывается вообще: Chrome
 * не рисует документ внутри вкладки, а `window.open` уходит в Custom Tab. Хуже
 * того, TWA не умеет скачивать файлы. Поэтому на Android мы не пытаемся открыть
 * PDF «в приложении», а показываем публичную ссылку на скачивание
 * (`Content-Disposition: attachment`) и в TWA подменяем её на intent-ссылку,
 * которая принудительно открывает системный Chrome: он скачает файл и откроет
 * его своим просмотрщиком.
 *
 * ── iOS ─────────────────────────────────────────────────────────────────────
 *
 * iOS разрешает открыть новое окно только СИНХРОННО внутри тапа: если сначала
 * сходить за ссылкой, а потом звать `window.open`, Safari сочтёт это popup-ом и
 * заблокирует. Поэтому окно просим сразу (`about:blank`), а адрес подставляем в
 * него, когда ссылка пришла.
 */

import { api } from '@/lib/api';
import { isIOS, isStandalone } from '@/lib/env';

export interface PdfOpenOutcome {
  kind: 'system' | 'fallback';
  /** Публичная ссылка на файл (для показа человеку). */
  url?: string;
  /** Куда вести ссылку на Android в TWA: intent в системный Chrome. */
  externalUrl?: string;
  /** Ссылка отдаёт файл как attachment (Android): кнопка «Скачать». */
  download?: boolean;
}

interface PdfFile {
  fileId: string;
  originalName: string;
}

function isAndroid(): boolean {
  return /Android/i.test(window.navigator.userAgent || '');
}

/** Абсолютный адрес подписанной ссылки на файл. */
export async function pdfShareUrl(fileId: string, download = false): Promise<string> {
  const { path } = await api.createFileShareLink(fileId, { download });
  return new URL(path, window.location.origin).href;
}

/**
 * Intent-ссылка, открывающая URL в системном Chrome.
 *
 * Из TWA обычная навигация остаётся внутри приложения, а `intent://` Chrome
 * передаёт системе: Android запускает браузер как отдельное приложение. Если
 * Chrome не установлен, сработает `browser_fallback_url` — та же https-ссылка.
 */
export function androidBrowserIntent(url: string): string {
  try {
    const parsed = new URL(url);
    const encodedFallback = encodeURIComponent(url);
    return `intent://${parsed.host}${parsed.pathname}${parsed.search}#Intent;scheme=${parsed.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodedFallback};end`;
  } catch {
    return url;
  }
}

/**
 * Открывает PDF.
 *
 * Возвращает `fallback` с публичной ссылкой, если открыть сам не смог: вызывающий
 * показывает кнопку, которую человек нажмёт руками.
 */
export async function openPdf(file: PdfFile): Promise<PdfOpenOutcome> {
  // Android: никакого window.open — показываем публичную ссылку на скачивание.
  if (isAndroid()) {
    const url = await pdfShareUrl(file.fileId, true);
    return {
      kind: 'fallback',
      url,
      externalUrl: isStandalone() ? androidBrowserIntent(url) : undefined,
      download: true,
    };
  }

  // iOS: и в Safari, и в установленном приложении надёжнее открыть PDF по
  // публичной inline-ссылке. window.open в standalone часто отдаёт пустой лист
  // Safari, а PDF в нём не рисуется. По тапу Safari откроет документ своим
  // просмотрщиком (с «Поделиться» и закрытием).
  if (isIOS()) {
    return { kind: 'fallback', url: await pdfShareUrl(file.fileId), download: false };
  }

  // Остальные standalone-браузеры: выводим себя из PWA навигацией.
  if (isStandalone()) {
    const url = await pdfShareUrl(file.fileId);
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.href = url;
    return { kind: 'system' };
  }

  // Обычный браузер на десктопе: окно просим синхронно, внутри тапа — иначе
  // браузер сочтёт его popup-ом и заблокирует.
  const viewer = window.open('about:blank', '_blank');
  if (!viewer) {
    return { kind: 'fallback', url: await pdfShareUrl(file.fileId) };
  }

  try {
    viewer.opener = null;
    viewer.location.replace(await pdfShareUrl(file.fileId));
    return { kind: 'system' };
  } catch (err) {
    // Ссылку не выдали (сеть/сессия) — закрываем пустое окно и отдаём ошибку
    // наверх: пустая вкладка на экране хуже сообщения.
    try {
      viewer.close();
    } catch {
      // закрыть чужое окно браузер может запретить — это не важно
    }
    throw err;
  }
}

/** Понятный текст ошибки открытия. */
export function pdfOpenErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/заблокир/i.test(message)) return 'Браузер заблокировал открытие. Нажмите ссылку ниже.';
  return 'Не удалось открыть документ. Проверьте соединение и попробуйте ещё раз.';
}
