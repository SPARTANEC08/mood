/**
 * Встроенный просмотр PDF для Android.
 *
 * Рендер — react-pdf (тот же pdf.js), жесты — react-zoom-pan-pinch. Свой зум и
 * скролл больше не пишем: библиотека делает pinch, pan и плавный transform без
 * пересчёта layout. Из-за самодельного пересчёта страниц и прыгало с 10-й на
 * 100-ю.
 *
 * Постраничный режим: одна страница, навигация кнопками, свайпом и вводом
 * номера. iOS не трогаем — там системный просмотрщик Safari.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from 'react-zoom-pan-pinch';

import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { ServerFileRef } from '@/types/api';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/*
 * Старые Android WebView не знают Promise.withResolvers, а pdf.js 3.11 его
 * использует. Полифилл до первого рендера страницы.
 */
if (
  typeof Promise !== 'undefined' &&
  typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function'
) {
  (Promise as unknown as { withResolvers: () => unknown }).withResolvers = () => {
    let resolve: (value: unknown) => void = () => undefined;
    let reject: (reason?: unknown) => void = () => undefined;
    const promise = new Promise((res, rej) => {
      resolve = res as (value: unknown) => void;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const MAX_WIDTH = 560;
const PAGE_MARGIN = 24;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function contentWidth(): number {
  return Math.max(240, Math.min(MAX_WIDTH, window.innerWidth) - PAGE_MARGIN);
}

export function PdfViewerScreen({
  file,
  srcUrl,
  onClose,
  onFallback,
}: {
  file: ServerFileRef;
  /** Готовый URL (тестовая страница): без авторизации и API. */
  srcUrl?: string;
  onClose: () => void;
  /** Скачать/открыть системно, если встроенный просмотр не удался. */
  onFallback?: () => void;
}) {
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [pages, setPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [baseWidth, setBaseWidth] = useState(contentWidth());
  const [zoomPercent, setZoomPercent] = useState(100);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('1');

  const controlsRef = useRef<ReactZoomPanPinchRef | null>(null);

  useEffect(() => {
    const onResize = () => setBaseWidth(contentWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ── загрузка файла ─────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        let data: ArrayBuffer;

        if (srcUrl) {
          const response = await fetch(srcUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          data = await response.arrayBuffer();
        } else {
          const fetched = await api.fetchFile(file.fileId, (loaded, total) => {
            if (total > 0) setProgress(Math.min(99, Math.round((loaded / total) * 100)));
          });
          data = await fetched.blob.arrayBuffer();
        }

        if (cancelled) return;
        setFileData(new Uint8Array(data));
        setProgress(null);
      } catch {
        if (!cancelled) {
          setError('Не удалось открыть PDF. Попробуйте скачать файл.');
          setProgress(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.fileId, srcUrl]);

  const documentFile = useMemo(
    () => (fileData ? { data: fileData } : null),
    [fileData],
  );

  useEffect(() => {
    // Новая страница — новый TransformWrapper (key), зум сбрасывается.
    setZoomPercent(100);
  }, [pageNumber]);

  const close = useCallback(() => {
    haptic('light');
    onClose();
  }, [onClose]);

  function goToPage(next: number): void {
    haptic('light');
    setPageNumber(Math.min(pages, Math.max(1, next)));
  }

  function submitJump(): void {
    const parsed = Number.parseInt(jumpValue, 10);
    if (!Number.isFinite(parsed)) return;
    goToPage(parsed);
    setJumpOpen(false);
  }

  function zoomIn(): void {
    controlsRef.current?.zoomIn(0.25);
  }

  function zoomOut(): void {
    controlsRef.current?.zoomOut(0.25);
  }

  function resetZoom(): void {
    controlsRef.current?.resetTransform();
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col"
      style={{ background: 'var(--app-bg)' }}
      role="dialog"
      aria-modal="true"
    >
      <header
        className="shrink-0 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top))]"
        style={{ background: 'var(--app-bg)' }}
      >
        <div className="mx-auto flex max-w-[560px] items-center gap-2">
          <button
            type="button"
            aria-label="Назад"
            onClick={close}
            className="pressable -ml-1 shrink-0 rounded-full p-1.5 active:pressable-active"
            style={{ color: 'var(--accent)' }}
          >
            <ArrowLeft size={22} aria-hidden />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">{file.originalName}</p>
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {pages > 0 ? `${pageNumber} / ${pages}` : 'PDF'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Уменьшить"
              disabled={zoomPercent <= 100}
              onClick={zoomOut}
              className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              <ZoomOut size={18} aria-hidden />
            </button>

            <button
              type="button"
              aria-label="Сбросить масштаб"
              onClick={resetZoom}
              className="pressable min-w-[42px] rounded-full px-1 py-1 text-[11px] font-semibold active:pressable-active"
              style={{ color: 'var(--text-secondary)' }}
            >
              {zoomPercent}%
            </button>

            <button
              type="button"
              aria-label="Увеличить"
              disabled={zoomPercent >= MAX_ZOOM * 100}
              onClick={zoomIn}
              className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              <ZoomIn size={18} aria-hidden />
            </button>
          </div>

          {onFallback ? (
            <button
              type="button"
              aria-label="Скачать"
              onClick={() => {
                haptic('light');
                onFallback();
              }}
              className="pressable shrink-0 rounded-full p-2 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <Download size={19} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full items-start justify-center px-3 py-2">
            <div className="surface w-full max-w-[420px] rounded-[14px] px-4 py-5 text-center">
              <p className="text-[14px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
              <div className="mt-3 flex justify-center gap-2">
                {onFallback ? (
                  <button
                    type="button"
                    onClick={onFallback}
                    className="pressable rounded-[11px] px-4 py-2 text-[13px] font-semibold text-white active:pressable-active"
                    style={{ background: 'var(--accent)' }}
                  >
                    Скачать
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={close}
                  className="pressable rounded-[11px] px-4 py-2 text-[13px] font-semibold active:pressable-active"
                  style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
                >
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        ) : progress !== null || !documentFile ? (
          <div className="flex h-full items-start justify-center px-3 py-2">
            <div className="surface w-full max-w-[420px] rounded-[14px] px-4 py-6 text-center">
              <Loader2 size={22} className="mx-auto animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
              <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {progress !== null ? `Загрузка PDF… ${progress}%` : 'Открываем PDF…'}
              </p>
            </div>
          </div>
        ) : (
          <Document
            file={documentFile}
            onLoadSuccess={({ numPages }) => setPages(numPages)}
            onLoadError={() => setError('Не удалось открыть PDF. Попробуйте скачать файл.')}
            loading={null}
          >
            <TransformWrapper
              key={pageNumber}
              initialScale={MIN_ZOOM}
              minScale={MIN_ZOOM}
              maxScale={MAX_ZOOM}
              centerOnInit
              limitToBounds
              doubleClick={{ mode: 'toggle', step: 0.7 }}
              wheel={{ step: 0.1 }}
              pinch={{ step: 5 }}
              panning={{ velocityDisabled: true }}
              onInit={(ref) => {
                controlsRef.current = ref;
              }}
              onTransform={(ref) => setZoomPercent(Math.round(ref.state.scale * 100))}
            >
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: '100%', display: 'flex', justifyContent: 'center' }}
              >
                <Page
                  pageNumber={pageNumber}
                  width={baseWidth}
                  devicePixelRatio={Math.min(2, window.devicePixelRatio || 1)}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  loading={null}
                />
              </TransformComponent>
            </TransformWrapper>
          </Document>
        )}
      </div>

      {pages > 1 ? (
        <footer
          className="shrink-0 border-t px-4 pb-[calc(env(safe-area-inset-bottom)+8px)] pt-2"
          style={{ borderColor: 'var(--separator-soft)', background: 'var(--app-bg)' }}
        >
          <div className="mx-auto flex max-w-[560px] items-center justify-between">
            <button
              type="button"
              aria-label="Предыдущая страница"
              disabled={pageNumber <= 1}
              onClick={() => goToPage(pageNumber - 1)}
              className="pressable flex items-center gap-1 rounded-full px-3 py-2 text-[13px] font-semibold active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              <ChevronLeft size={18} aria-hidden />
              Назад
            </button>

            <button
              type="button"
              aria-label="Перейти к странице"
              onClick={() => {
                haptic('light');
                setJumpValue(String(pageNumber));
                setJumpOpen(true);
              }}
              className="pressable rounded-full px-3 py-2 text-[12px] font-semibold active:pressable-active"
              style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
            >
              {pageNumber} / {pages}
            </button>

            <button
              type="button"
              aria-label="Следующая страница"
              disabled={pageNumber >= pages}
              onClick={() => goToPage(pageNumber + 1)}
              className="pressable flex items-center gap-1 rounded-full px-3 py-2 text-[13px] font-semibold active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              Вперёд
              <ChevronRight size={18} aria-hidden />
            </button>
          </div>
        </footer>
      ) : null}

      {jumpOpen ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 px-5">
          <div className="surface w-full max-w-[340px] rounded-[18px] p-4">
            <h2 className="text-[17px] font-semibold">Перейти к странице</h2>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Всего {pages} стр.
            </p>

            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={pages}
              value={jumpValue}
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitJump();
              }}
              className="mt-3 w-full rounded-[11px] px-3 py-2.5 text-[18px] font-semibold outline-none"
              style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
              autoFocus
            />

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  goToPage(1);
                  setJumpOpen(false);
                }}
                className="pressable flex-1 rounded-[10px] py-2 text-[12px] font-semibold active:pressable-active"
                style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
              >
                В начало
              </button>
              <button
                type="button"
                onClick={() => {
                  goToPage(pages);
                  setJumpOpen(false);
                }}
                className="pressable flex-1 rounded-[10px] py-2 text-[12px] font-semibold active:pressable-active"
                style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
              >
                В конец
              </button>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setJumpOpen(false)}
                className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold active:pressable-active"
                style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={submitJump}
                className="pressable flex-1 rounded-[12px] py-2.5 text-[15px] font-semibold text-white active:pressable-active"
                style={{ background: 'var(--accent)' }}
              >
                Перейти
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
