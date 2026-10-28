/**
 * Встроенный просмотр PDF для Android.
 *
 * Постраничный режим. Причина — зум: если в DOM лежат 91 страница и менять их
 * ширину на каждый жест, браузер пересчитывает высоты всех страниц, и скролл
 * улетает с 10-й на 100-ю. Здесь рендерится одна страница: зум — это transform
 * поверх canvas во время жеста и один пересчёт после его окончания.
 *
 * iOS не трогаем: там системный просмотрщик Safari.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Loader2, ZoomIn, ZoomOut } from 'lucide-react';

import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { ServerFileRef } from '@/types/api';

import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url';

type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

const MAX_WIDTH = 560;
const PAGE_MARGIN = 24;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

function contentWidth(): number {
  return Math.max(240, Math.min(MAX_WIDTH, window.innerWidth) - PAGE_MARGIN);
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
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
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [previewScale, setPreviewScale] = useState(1);
  const [baseWidth, setBaseWidth] = useState(contentWidth());
  const [aspect, setAspect] = useState(1.414);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('1');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const previewScaleRef = useRef(1);
  const pagesRef = useRef(0);
  const scrollRatioRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    previewScaleRef.current = previewScale;
  }, [previewScale]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    const onResize = () => setBaseWidth(contentWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ── загрузка документа ─────────────────────────────────────────────── */

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
        // Vite/Rolldown отдают CJS-пакет как { default: api }.
        const pdfjs = ((module as unknown as { default?: typeof module }).default ??
          module) as typeof module;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

        loadedDoc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) {
          void loadedDoc.destroy();
          return;
        }

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

  /* ── рендер одной страницы ──────────────────────────────────────────── */

  useEffect(() => {
    const pdfDoc = doc;
    const canvas = canvasRef.current;
    if (!pdfDoc || !canvas) return;

    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const base = page.getViewport({ scale: 1 });
        const targetWidth = Math.round(baseWidth * zoom);
        const viewport = page.getViewport({ scale: targetWidth / base.width });
        setAspect(base.height / base.width);

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

        // После смены масштаба возвращаем центр страницы туда, где он был.
        const ratio = scrollRatioRef.current;
        const scroller = scrollRef.current;
        if (ratio && scroller) {
          requestAnimationFrame(() => {
            scroller.scrollLeft = ratio.x * scroller.scrollWidth - scroller.clientWidth / 2;
            scroller.scrollTop = ratio.y * scroller.scrollHeight - scroller.clientHeight / 2;
            scrollRatioRef.current = null;
          });
        }
      } catch {
        if (!cancelled) setError('Страница не отрисовалась. Попробуйте ещё раз.');
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, zoom, baseWidth]);

  /* ── жесты: pinch-zoom и свайп между страницами ─────────────────────── */

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let pinch: { distance: number; zoom: number } | null = null;
    let swipe: { x: number; y: number; at: number } | null = null;
    let pinched = false;

    const distance = (touches: TouchList): number => {
      const [a, b] = [touches[0], touches[1]];
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onStart = (event: TouchEvent): void => {
      pinched = false;

      if (event.touches.length === 2) {
        pinch = { distance: distance(event.touches), zoom: zoomRef.current };
        event.preventDefault();
        return;
      }

      if (event.touches.length === 1) {
        const touch = event.touches[0]!;
        swipe = { x: touch.clientX, y: touch.clientY, at: Date.now() };
      }
    };

    const onMove = (event: TouchEvent): void => {
      if (!pinch || event.touches.length !== 2) return;

      event.preventDefault();
      pinched = true;
      const current = distance(event.touches);
      if (pinch.distance <= 0) return;

      const target = clampZoom(pinch.zoom * (current / pinch.distance));
      setPreviewScale(target / zoomRef.current);
    };

    const onEnd = (event: TouchEvent): void => {
      if (pinch) {
        if (event.touches.length >= 2) return;

        const scroller = scrollRef.current;
        if (scroller) {
          scrollRatioRef.current = {
            x: (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth),
            y: (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight),
          };
        }

        const ratio = previewScaleRef.current;
        pinch = null;
        setPreviewScale(1);
        setZoom((value) => clampZoom(value * ratio));
        return;
      }

      // Свайп между страницами — только без зума и без pinch.
      if (!swipe || pinched || zoomRef.current > 1) {
        swipe = null;
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      const elapsed = Date.now() - swipe.at;
      swipe = null;

      if (elapsed > 700) return;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

      if (dx < 0) setPageNumber((value) => Math.min(pagesRef.current, value + 1));
      else setPageNumber((value) => Math.max(1, value - 1));
      scrollRef.current?.scrollTo({ top: 0, left: 0 });
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
    };
  }, []);

  const close = useCallback(() => {
    haptic('light');
    onClose();
  }, [onClose]);

  function changeZoom(next: number): void {
    const scroller = scrollRef.current;
    if (scroller) {
      scrollRatioRef.current = {
        x: (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth),
        y: (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight),
      };
    }
    setZoom(clampZoom(next));
  }

  function goToPage(next: number): void {
    haptic('light');
    setPageNumber(Math.min(pages, Math.max(1, next)));
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }

  function submitJump(): void {
    const parsed = Number.parseInt(jumpValue, 10);
    if (!Number.isFinite(parsed)) return;

    goToPage(parsed);
    setJumpOpen(false);
  }

  const pageWidth = Math.round(baseWidth * zoom);
  const pageHeight = Math.round(pageWidth * aspect);

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
              disabled={zoom <= MIN_ZOOM}
              onClick={() => changeZoom(zoom - 0.25)}
              className="pressable rounded-full p-1.5 active:pressable-active disabled:opacity-30"
              style={{ color: 'var(--accent)' }}
            >
              <ZoomOut size={18} aria-hidden />
            </button>

            <button
              type="button"
              aria-label="Сбросить масштаб"
              onClick={() => changeZoom(1)}
              className="pressable min-w-[42px] rounded-full px-1 py-1 text-[11px] font-semibold active:pressable-active"
              style={{ color: 'var(--text-secondary)' }}
            >
              {Math.round(zoom * 100)}%
            </button>

            <button
              type="button"
              aria-label="Увеличить"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => changeZoom(zoom + 0.25)}
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
        <div className="flex min-h-full items-start justify-center px-3 py-2">
          {error ? (
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
          ) : progress !== null ? (
            <div className="surface w-full max-w-[420px] rounded-[14px] px-4 py-6 text-center">
              <Loader2 size={22} className="mx-auto animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
              <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Загрузка PDF… {progress}%
              </p>
            </div>
          ) : !doc ? (
            <div className="surface w-full max-w-[420px] rounded-[14px] px-4 py-6 text-center">
              <Loader2 size={22} className="mx-auto animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
              <p className="mt-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Открываем PDF…
              </p>
            </div>
          ) : (
            <div
              className="origin-top bg-white shadow-sm"
              style={{
                width: pageWidth,
                height: pageHeight,
                transform: `scale(${previewScale})`,
                transition: previewScale === 1 ? 'transform 120ms ease-out' : 'none',
              }}
            >
              <canvas ref={canvasRef} className="block" />
            </div>
          )}
        </div>
      </div>

      {doc && pages > 1 ? (
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
                onClick={() => goToPage(1)}
                className="pressable flex-1 rounded-[10px] py-2 text-[12px] font-semibold active:pressable-active"
                style={{ background: 'var(--surface-grouped)', color: 'var(--accent)' }}
              >
                В начало
              </button>
              <button
                type="button"
                onClick={() => goToPage(pages)}
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
