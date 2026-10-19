/**
 * Работа с файлами: превью, просмотр, скачивание, загрузка, удаление.
 *
 * Файлы закрыты токеном, поэтому содержимое забирает fetch (или XHR с
 * прогрессом при загрузке), а не обычная ссылка. Объектный URL создаётся на
 * каждое действие и отзывается вызывающим кодом: отзывать сразу после клика
 * нельзя — скачивание оборвётся, а держать навсегда — утечка памяти.
 */

import { getCachedFile, putCachedFile } from '@/lib/fileCache';
import { isDataSaver } from '@/lib/env';
import type { ServerFileRef } from '@/types/api';
import { ApiError, BASE, authHeader, readPwaToken, request } from './http.ts';

/** Отчёт о прогрессе загрузки: сколько байт уже пришло и сколько всего. */
export type DownloadProgress = (loaded: number, total: number) => void;

/**
 * Сырая загрузка файла: сеть, без кэша.
 *
 * Вынесена отдельно от `fetchFile`: её регистрируют в fileCache, чтобы фоновая
 * предзагрузка шла ровно тем же кодом, что и обычное открытие, и не разошлась с
 * ним по заголовкам или разбору ошибок.
 *
 * Прогресс читается из потока вручную: у `fetch` нет события `progress`, а
 * `response.blob()` отдаёт результат только целиком. Без ручного чтения
 * прогресс-бар во вьюере не сдвинулся бы до самого конца загрузки — то есть
 * показывал бы «0%», а потом исчезал.
 */
async function downloadFileBlob(fileId: string, onProgress?: DownloadProgress): Promise<Blob> {
  const response = await fetch(`${BASE}/files/${encodeURIComponent(fileId)}`, {
    headers: authHeader(),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Ошибка ${response.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // ответ не JSON — оставляем код статуса
    }
    throw new ApiError(message, response.status, false, 'server');
  }

  // Без обработчика прогресса и без тела отдаём blob напрямую: лишний разбор
  // потока только замедлил бы открытие.
  if (!onProgress || !response.body) return response.blob();

  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  return new Blob(chunks as BlobPart[], {
    type: response.headers.get('Content-Type') ?? undefined,
  });
}

/**
 * Превью изображения: маленький JPEG вместо оригинала.
 *
 * Ошибка превью не ошибка файла: 404, 415 (не изображение) и 503 (sharp не
 * установлен) означают одно — бери оригинал. Поэтому метод сам переключается
 * на полный файл, а не пробрасывает отказ наверх.
 */
const PREVIEW_WIDTH = 800;

const previewUrls = new Map<string, string>();

/** Очищает URL превью при смене авторизованного пользователя. */
export function clearPreviewUrlCache(): void {
  for (const url of previewUrls.values()) URL.revokeObjectURL(url);
  previewUrls.clear();
}

async function downloadPreviewBlob(fileId: string): Promise<Blob> {
  const response = await fetch(
    `${BASE}/files/${encodeURIComponent(fileId)}/preview?w=${PREVIEW_WIDTH}`,
    { headers: authHeader() },
  );

  if (!response.ok) throw new ApiError('Превью недоступно.', response.status, false, 'server');

  return response.blob();
}

/**
 * Превью фотографии для показа в ленте и как «первый кадр» во вьюере.
 *
 * Возвращает blob-URL всегда: если превью построить не удалось, метод молча
 * берёт оригинал. Вызывающему коду не нужно знать, отработало превью или нет —
 * в обоих случаях он получает картинку, которую можно показать.
 *
 * URL живёт в модульной карте бессрочно и НЕ отзывается вызывающим: одно и то
 * же превью переиспользуют и миниатюра в списке, и полноэкранный просмотр.
 * Отзыв «по месту» сломал бы миниатюру, которая ещё на экране.
 */
export async function previewUrl(fileId: string): Promise<string> {
  const cached = previewUrls.get(fileId);
  if (cached) return cached;

  let blob: Blob;

  try {
    blob = await downloadPreviewBlob(fileId);
  } catch {
    blob = await downloadFileBlob(fileId);
  }

  const url = URL.createObjectURL(blob);
  previewUrls.set(fileId, url);

  return url;
}

/** Результат `fetchFile`: готовый объектный URL и способ его отозвать. */
export interface FetchedFile {
  url: string;
  blob: Blob;
  /** Отозвать URL. Не раньше, чем `<img>`/`<iframe>` перестал его показывать. */
  revoke: () => void;
  /** Blob пришёл из памяти: сеть не участвовала, показывать можно мгновенно. */
  fromCache: boolean;
}

/**
 * Файл для просмотра: сначала память, потом сеть.
 *
 * Это единственный путь, которым InAppBrowser получает содержимое. Объектный
 * URL создаётся на открытие и отзывается вьюером при закрытии/переключении —
 * наружу он не выходит: доставкой файла системе занимается `deliverFileToSystem`
 * (share-sheet, а не blob-навигация).
 *
 * `onProgress` пробрасывается в сетевую ветку: если файл уже в кэше, прогресса
 * не будет вовсе — и это правильно, ждать нечего.
 */
export async function fetchFile(fileId: string, onProgress?: DownloadProgress): Promise<FetchedFile> {
  const cached = getCachedFile(fileId);
  if (cached) {
    const url = URL.createObjectURL(cached);
    return { url, blob: cached, revoke: () => URL.revokeObjectURL(url), fromCache: true };
  }

  const blob = await downloadFileBlob(fileId, onProgress);
  // Крупные файлы putCachedFile отбросит сам — это осознанно (см. fileCache).
  putCachedFile(fileId, blob);

  const url = URL.createObjectURL(blob);

  return { url, blob, revoke: () => URL.revokeObjectURL(url), fromCache: false };
}

/**
 * Кладёт файл-соседа в кэш заранее, без создания объектного URL.
 *
 * Нужно, чтобы свайп к следующему изображению был мгновенным. Качаем только
 * картинки: PDF на 20 МБ «на всякий случай» — это трафик и память, которых
 * пользователь не просил. Экономия трафика и гигантские файлы (больше потолка
 * кэша) отсекаются сразу, чтобы не тянуть то, что всё равно не покажется быстро.
 *
 * Промис никогда не отклоняется: это фон без наблюдателя, ошибка здесь не
 * должна ломать открытый вьюер.
 */
export async function prefetchFile(fileId: string, size: number): Promise<void> {
  if (isDataSaver()) return;
  if (getCachedFile(fileId)) return;
  // Больше потолка одного файла кэш всё равно не примет — качать нет смысла.
  if (size > 20 * 1024 * 1024) return;

  try {
    const blob = await downloadFileBlob(fileId);
    putCachedFile(fileId, blob);
  } catch {
    // Сосед не подгрузился — свайп просто покажет спиннер и догрузит по сети.
  }
}

/**
 * Отзыв объектного URL скачивания отложен: мгновенный revoke обрывает
 * скачивание в Safari/Chrome. Плюс страховочный таймер, если страница так и не
 * станет видимой повторно (десктоп при обычном скачивании).
 */
const DOWNLOAD_REVOKE_MS = 60_000;

/** Есть ли Web Share API уровня 2 (файлы). canShare в lib.dom объявлен
 *  обязательным, поэтому наличие проверяется приведением типа, а не truthiness. */
function canShareFiles(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof (navigator as Navigator & { canShare?: unknown }).canShare === 'function';
}

/**
 * Якорь с download — фолбэк, когда системы «Поделиться» с файлами нет
 * (десктопные браузеры). Объектный URL отзывается по возврату страницы в
 * видимость, а не по таймеру: к этому моменту система уже забрала файл.
 * Таймер остаётся предохранителем.
 */
function saveBlobAsFile(blob: Blob, name: string, mimeType?: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = name || 'file';
  if (mimeType) link.type = mimeType;

  document.body.appendChild(link);
  link.click();
  link.remove();

  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    document.removeEventListener('visibilitychange', onVisibility);
    URL.revokeObjectURL(url);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') revoke();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.setTimeout(revoke, DOWNLOAD_REVOKE_MS);
}

/**
 * Отдаёт готовый blob системе.
 *
 * Сначала системное окно «Поделиться» с файлом (Web Share Level 2): только оно
 * не трогает историю webview. Якорь с download здесь ненадёжен — iOS и
 * Android в standalone-PWA игнорируют атрибут `download` для blob:-URL и
 * ПЕРЕХОДЯТ на него; это настоящая навигация, и возврат «назад» из системного
 * просмотрщика перезагружает приложение (теряется вкладка, открытая запись,
 * день расписания). Якорь остаётся только фолбэком для браузеров без share.
 *
 * Вызывать по возможности синхронно из обработчика тапа: `navigator.share`
 * требует пользовательского жеста, а `await` перед ним может его истратить.
 */
export function deliverFileToSystem(blob: Blob, name: string, mimeType?: string): void {
  const fileName = name || 'file';
  const type = mimeType || blob.type || 'application/octet-stream';

  try {
    const file = new File([blob], fileName, { type });
    if (canShareFiles() && navigator.canShare({ files: [file] })) {
      void navigator.share({ files: [file], title: fileName }).catch((err: unknown) => {
        // Закрытие окна «Поделиться» — нормальное действие, а не ошибка.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        saveBlobAsFile(blob, fileName, type);
      });
      return;
    }
  } catch {
    // canShare/share недоступны или бросили — уходим на скачивание якорем.
  }

  saveBlobAsFile(blob, fileName, type);
}

/**
 * Отдаёт файл системе по тапу.
 *
 * Объектный URL, созданный `fetchFile` для показа, здесь не нужен: система
 * получает сам Blob (через File), поэтому URL отзывается сразу, а свой URL
 * создаёт только фолбэк-якорь. Так blob не висит в памяти до таймера.
 */
export async function downloadFile(fileId: string, fileName: string, mimeType?: string): Promise<void> {
  const { blob, revoke } = await fetchFile(fileId);
  revoke();
  deliverFileToSystem(blob, fileName, mimeType);
}

/**
 * Открывает PDF системным просмотрщиком в отдельном browsing context.
 *
 * Сначала синхронно открываем пустую вкладку из пользовательского тапа, затем
 * получаем короткоживущую inline share-ссылку сервера и направляем вкладку на
 * неё. Так исходный документ PWA остаётся живым, а сам PDF открывается viewer-ом
 * браузера; API/share-ссылка не кэшируется service worker-ом.
 */
export interface FileShareLink {
  path: string;
  expiresAt: number;
  disposition?: 'inline' | 'attachment';
}

/**
 * Создаёт короткоживущую ссылку на файл.
 *
 * `download: true` — публичная ссылка на скачивание (attachment). Нужна Android:
 * PDF в TWA/Custom Tab не рисуется, а по attachment системный браузер скачивает
 * файл и открывает его своим просмотрщиком.
 */
export function createFileShareLink(
  fileId: string,
  options: { download?: boolean } = {},
): Promise<FileShareLink> {
  return request<FileShareLink>(`/files/${encodeURIComponent(fileId)}/share`, {
    method: 'POST',
    body: options.download ? { download: true } : {},
  });
}

export async function openFileInSystemViewer(fileId: string): Promise<void> {
  const viewer = window.open('about:blank', '_blank');

  if (!viewer) {
    throw new Error('Браузер заблокировал окно просмотра файла.');
  }

  try {
    const { path: sharePath } = await createFileShareLink(fileId);

    viewer.opener = null;
    viewer.location.replace(new URL(sharePath, window.location.origin).href);
  } catch (err: unknown) {
    viewer.close();
    throw err;
  }
}

/**
 * Загрузка файла в хранилище сервера с отчётом о прогрессе.
 *
 * Именно XMLHttpRequest, а не fetch: у fetch в браузере нет события прогресса
 * (ReadableStream для тела запроса есть не везде и не на iPhone Safari). Без
 * прогресса человек не видит, что файл куда-то едет.
 */
export function uploadFile(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ServerFileRef> {
  return new Promise<ServerFileRef>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/files/upload`);

    const token = readPwaToken();
    if (token) xhr.setRequestHeader('X-PWA-Token', token);
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total);
    };

    xhr.onload = () => {
      let payload: { file?: ServerFileRef; message?: string } = {};

      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // ответ не JSON — ниже отдастся по коду статуса
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload.file) {
        resolve(payload.file);
        return;
      }

      reject(
        new ApiError(
          payload.message ?? `Не удалось загрузить файл (ошибка ${xhr.status}).`,
          xhr.status,
          false,
          xhr.status === 0 ? 'network' : 'server',
        ),
      );
    };

    // onerror и onabort ловят обрыв связи и отмену: без них промис остался бы
    // в состоянии pending навсегда и форма была бы заблокирована.
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером.', 0, false, 'network'));
    xhr.onabort = () => reject(new ApiError('Загрузка отменена.', 0, false, 'network'));

    xhr.send(form);
  });
}

/** Удаление файла, который ещё не прикреплён ни к одной записи. */
export function deleteFile(fileId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}
