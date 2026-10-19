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
 * (`/api/files/share/:token`): она отдаёт файл с `Content-Type: application/pdf`,
 * `Content-Disposition: inline` и поддержкой Range, без токена в заголовке — и
 * токен при этом в URL не попадает (в самой ссылке случайный одноразовый ключ).
 *
 * ── Про окна ────────────────────────────────────────────────────────────────
 *
 * iOS разрешает открыть новое окно только СИНХРОННО внутри тапа: если сначала
 * сходить за ссылкой, а потом звать `window.open`, Safari сочтёт это popup-ом и
 * заблокирует. Поэтому окно просим сразу (`about:blank`), а адрес подставляем в
 * него, когда ссылка пришла — так делает и штатный Safari, и установленное
 * приложение (там это системный лист Safari с «Готово»/«Поделиться»).
 */

import { api } from '@/lib/api';
import { isIOS, isStandalone } from '@/lib/env';

export type PdfOpenOutcome = 'system' | 'fallback';

interface PdfFile {
  fileId: string;
  originalName: string;
}

/** Абсолютный адрес подписанной ссылки на файл. */
export async function pdfShareUrl(fileId: string): Promise<string> {
  const { path } = await api.createFileShareLink(fileId);
  return new URL(path, window.location.origin).href;
}

/**
 * Открывает PDF в системном просмотрщике.
 *
 * Возвращает `fallback`, если окно открыть не удалось (браузер запретил или это
 * TWA): вызывающий показывает понятную ссылку, которую можно нажать самому.
 */
export async function openPdf(file: PdfFile): Promise<PdfOpenOutcome> {
  // Установленное приложение на Android — это TWA. window.open уходит в Custom
  // Tab, который PDF не рисует, поэтому выводим себя из области TWA навигацией:
  // тогда документ откроет Chrome целиком, со своим просмотрщиком.
  if (isStandalone() && !isIOS()) {
    const url = await pdfShareUrl(file.fileId);
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.href = url;
    return 'system';
  }

  // iOS (и Safari, и установленное приложение) и обычный браузер: окно просим
  // синхронно, внутри тапа — иначе iOS его блокирует.
  const viewer = window.open('about:blank', '_blank');
  if (!viewer) return 'fallback';

  try {
    viewer.opener = null;
    viewer.location.replace(await pdfShareUrl(file.fileId));
    return 'system';
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
