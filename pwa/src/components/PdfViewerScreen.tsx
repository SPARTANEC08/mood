/**
 * Встроенный просмотр PDF для Android.
 *
 * Зачем свой вьюер. На Android Chrome/TWA не рисует PDF внутри вкладки, а
 * скачивание в TWA часто заканчивается файлом, который негде открыть. Поэтому
 * на Android PDF рендерится здесь же: pdf.js → canvas, без внешнего браузера и
 * без скачивания.
 *
 * iOS не трогаем: там системный просмотрщик Safari работает штатно и даёт
 * «Поделиться», зум и закрытие.
 *
 * Страницы рендерятся лениво: в тестовом PDF 91 страница, и рисовать их все
 * сразу на телефоне — верный способ получить фриз и out of memory.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Loader2, ZoomIn, ZoomOut } from 'lucide-react';

import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { ServerFileRef } from '@/types/api';

import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url';

type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

const MAX_WIDTH = 560;
const PAGE_MARGIN = 24;

function contentWidth(): number {
  return Math.max(240, Math.min(MAX_WIDTH, window.innerWidth) - PAGE_MARGIN);
}

/** Одна страница: серый placeholder, пока не попала в поле зрения. */
function PdfPage({
  doc,
  pageNumber,
  width,
  estimatedHeight,
}: {
  doc: PdfDocument;
  pageNumber: number;
  width: number;
  estimatedHeight: number;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(estimatedHeight);
  const [failed, setFailed] = useState(false);

  // При смене масштаба placeholder должен сразу получить новую высоту,
  // иначе страницы «прыгают» и скролл уезжает.
  useEffect(() => {
    setHeight(estimatedHeight);
  }, [estimatedHeight]);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' },
    );

    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = page.getViewport({ scale });
        setHeight(viewport.height);

        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const context = canvas.getContext('2d');
        if (!context) return;

        context.scale(dpr, dpr);
        task = page.render({ canvasContext: context, viewport });
        await (task as unknown as { promise: Promise<void> }).promise;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, pageNumber, width]);

  return (
    <div
      ref={holderRef}
      className="mx-auto overflow-hidden rounded-[6px] bg-white shadow-sm"
      style={{ width, height }}
    >
      {visible && !failed ? (
        <canvas ref={canvasRef} className="block" />
      ) : (
        <div className="flex h-full items-center justify-center">
          {failed ? (
            <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              Страница не отрисовалась
            </span>
          ) : (
            <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              Страница {pageNumber}
            </span>
          )}
        </div>
      )}
    </div>
  );
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
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState(0);
  const [baseWidth, setBaseWidth] = useState(contentWidth());
  /** Отношение высоты первой страницы к ширине: пропорции placeholder-ов. */
  const [aspect, setAspect] = useState(1.414);
  const [zoom, setZoom] = useState(1);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const pinchRef = useRef<{ startDistance: number; startZoom: number; lastZoom: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  /*
   * Pinch-to-zoom. Слушатели вешаем нативно и с passive:false: React-обработчик
   * touchmove не даёт гарантии, что браузер не начнёт свой зум/скролл, а нам
   * нужно полностью забрать жест двумя пальцами себе.
   *
   * Обновление масштаба через requestAnimationFrame: touchmove приходит
   * десятки раз в секунду, и setState на каждое событие перерисовывал бы все
   * placeholder-ы страниц.
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distance = (touches: TouchList): number => {
      const [a, b] = [touches[0], touches[1]];
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const clamp = (value: number): number => Math.min(3, Math.max(1, value));

    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinchRef.current = {
        startDistance: distance(event.touches),
        startZoom: zoomRef.current,
        lastZoom: zoomRef.current,
      };
    };

    const onMove = (event: TouchEvent): void => {
      const pinch = pinchRef.current;
      if (!pinch || event.touches.length !== 2) return;

      event.preventDefault();
      const current = distance(event.touches);
      if (pinch.startDistance <= 0) return;

      pinch.lastZoom = clamp(pinch.startZoom * (current / pinch.startDistance));

      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        if (pinchRef.current) setZoom(pinchRef.current.lastZoom);
      });
    };

    const onEnd = (event: TouchEvent): void => {
      if (!pinchRef.current || event.touches.length >= 2) return;

      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setZoom(pinchRef.current.lastZoom);
      pinchRef.current = null;
    };

    element.addEventListener('touchstart', onStart, { passive: false });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', onEnd, { passive: true });

    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', onEnd);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setBaseWidth(contentWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const pageWidth = Math.round(baseWidth * zoom);
  const pageHeight = Math.round(pageWidth * aspect);

  useEffect(() => {
    let cancelled = false;
    let loadedDoc: PdfDocument | null = null;
    let objectUrl: string | null = null;

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
          objectUrl = fetched.url;
          data = await fetched.blob.arrayBuffer();
        }

        if (cancelled) return;

        const module = await import('pdfjs-dist/legacy/build/pdf');
        // Vite/Rolldown отдают CJS-пакет как { default: api }: без этой
        // развилки GlobalWorkerOptions/getDocument оказываются не там.
        const pdfjs = ((module as unknown as { default?: typeof module }).default ??
          module) as typeof module;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

        loadedDoc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) {
          void loadedDoc.destroy();
          return;
        }

        // Размер первой страницы задаёт пропорции placeholder-ов.
        const first = await loadedDoc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        setPages(loadedDoc.numPages);
        setDoc(loadedDoc);
        setProgress(null);
      } catch {
        if (!cancelled) {
          setError('Не удалось открыть PDF. Попробуйте скачать файл.');
          setProgress(null);
        }
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    })();

    return () => {
      cancelled = true;
      void loadedDoc?.destroy();
    };
  }, [file.fileId, srcUrl]);

  const close = useCallback(() => {
    haptic('light');
    onClose();
  }, [onClose]);

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
            <p className="truncate text-[16px] font-semibold leading-tight">{file.originalName}</p>
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {pages > 0 ? `${pages} стр.` : 'PDF'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Уменьшить"
              disabled={zoom <= 1}
              onClick={() => setZoom((value) => Math.max(1, Math.round((value - 0.25) * 100) / 100))}
              className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              <ZoomOut size={18} aria-hidden />
            </button>

            <button
              type="button"
              aria-label="Сбросить масштаб"
              onClick={() => setZoom(1)}
              className="pressable min-w-[42px] rounded-full px-1 py-1 text-[11px] font-semibold active:pressable-active"
              style={{ color: 'var(--text-secondary)' }}
            >
              {Math.round(zoom * 100)}%
            </button>

            <button
              type="button"
              aria-label="Увеличить"
              disabled={zoom >= 3}
              onClick={() => setZoom((value) => Math.min(3, Math.round((value + 0.25) * 100) / 100))}
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

      <div
        ref={scrollRef}
        className="scroll-hidden min-h-0 flex-1 overflow-auto overscroll-contain"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        <div className="mx-auto space-y-3 px-3 pb-8 pt-2" style={{ width: pageWidth + 24 }}>

          {error ? (
            <div className="surface rounded-[14px] px-4 py-5 text-center">
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
          ) : null}

          {!error && progress !== null ? (
            <div className="surface rounded-[14px] px-4 py-6 text-center">
              <Loader2 size={22} className="mx-auto animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
              <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Загрузка PDF… {progress}%
              </p>
            </div>
          ) : null}

          {!error && progress === null && !doc ? (
            <div className="surface rounded-[14px] px-4 py-6 text-center">
              <Loader2 size={22} className="mx-auto animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
              <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Открываем PDF…
              </p>
            </div>
          ) : null}

          {doc
            ? Array.from({ length: pages }, (_, index) => (
                <PdfPage
                  key={index + 1}
                  doc={doc}
                  pageNumber={index + 1}
                  width={pageWidth}
                  estimatedHeight={pageHeight}
                />
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
