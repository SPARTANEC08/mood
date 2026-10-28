/**
 * Встроенный просмотр PDF для Android: непрерывный документ.
 *
 * Все страницы лежат в одном окне, листать кнопками не нужно. При этом в DOM
 * живут только страницы рядом с видимой областью: 91 canvas сразу — это
 * сотни мегабайт и фриз на телефоне.
 *
 * Зум и панорамирование — react-zoom-pan-pinch (transform, без пересчёта
 * layout). Поэтому увеличение не двигает страницы и не сбрасывает позицию.
 * iOS не трогаем: там системный просмотрщик Safari.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
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
const PAGE_GAP = 12;
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
  const [aspect, setAspect] = useState(1.414);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [visible, setVisible] = useState({ start: 1, end: 3 });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const controlsRef = useRef<ReactZoomPanPinchRef | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef(0);
  const stepRef = useRef(Math.round(contentWidth() * 1.414) + PAGE_GAP);

  const pageHeight = Math.round(baseWidth * aspect);
  const pageStep = pageHeight + PAGE_GAP;
  const contentHeight = Math.max(1, pages * pageStep);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    stepRef.current = pageStep;
  }, [pageStep]);

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

  const documentFile = useMemo(() => (fileData ? { data: fileData } : null), [fileData]);

  /* ── какие страницы держать в DOM ───────────────────────────────────── */

  const updateVisible = useCallback((state: { scale: number; positionX: number; positionY: number }) => {
    const wrapper = wrapperRef.current;
    const total = pagesRef.current;
    if (!wrapper || total === 0) return;

    const step = stepRef.current;
    const top = -state.positionY / state.scale;
    const height = wrapper.clientHeight / state.scale;

    const start = Math.max(1, Math.floor(top / step) - 1);
    const end = Math.min(total, Math.ceil((top + height) / step) + 1);
    const center = Math.min(total, Math.max(1, Math.floor((top + height / 2) / step) + 1));

    setVisible((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
    setPageNumber(center);
  }, []);

  const close = useCallback(() => {
    haptic('light');
    onClose();
  }, [onClose]);

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
              {pages > 0 ? `стр. ${pageNumber} / ${pages}` : 'PDF'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Уменьшить"
              disabled={zoomPercent <= MIN_ZOOM * 100}
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

      <div ref={wrapperRef} className="relative min-h-0 flex-1 overflow-hidden">
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
          <div className="h-full min-h-0">
          <Document
            className="h-full"
            file={documentFile}
            onLoadSuccess={(pdf) => {
              setPages(pdf.numPages);
              void pdf.getPage(1).then((page) => {
                const viewport = page.getViewport({ scale: 1 });
                setAspect(viewport.height / viewport.width);
              });
            }}
            onLoadError={() => setError('Не удалось открыть PDF. Попробуйте скачать файл.')}
            loading={null}
          >
            <TransformWrapper
              initialScale={MIN_ZOOM}
              minScale={MIN_ZOOM}
              maxScale={MAX_ZOOM}
              initialPositionX={0}
              initialPositionY={0}
              limitToBounds
              doubleClick={{ mode: 'toggle', step: 0.7 }}
              wheel={{ step: 0.1 }}
              pinch={{ step: 5 }}
              panning={{ velocityDisabled: true }}
              onInit={(ref) => {
                controlsRef.current = ref;
                updateVisible(ref.state);
              }}
              onTransform={(ref) => {
                setZoomPercent(Math.round(ref.state.scale * 100));
                updateVisible(ref.state);
              }}
            >
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: baseWidth, height: contentHeight }}
              >
                <div style={{ width: baseWidth }}>
                  {Array.from({ length: pages }, (_, index) => {
                    const number = index + 1;
                    const render = number >= visible.start && number <= visible.end;

                    return (
                      <div
                        key={number}
                        style={{ height: pageStep, paddingBottom: PAGE_GAP }}
                      >
                        {render ? (
                          <Page
                            pageNumber={number}
                            width={baseWidth}
                            devicePixelRatio={Math.min(2, window.devicePixelRatio || 1)}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            loading={null}
                          />
                        ) : (
                          <div
                            className="flex h-full items-center justify-center rounded-[4px]"
                            style={{ background: 'var(--surface-grouped)' }}
                          >
                            <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                              Страница {number}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </TransformComponent>
            </TransformWrapper>
          </Document>
          </div>
        )}
      </div>
    </div>
  );
}
