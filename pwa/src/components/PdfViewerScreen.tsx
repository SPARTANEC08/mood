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
import { ArrowLeft, Download, Loader2 } from 'lucide-react';

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
  const [pageWidth, setPageWidth] = useState(contentWidth());
  const [pageHeight, setPageHeight] = useState(Math.round(contentWidth() * 1.414));
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onResize = () => {
      const width = contentWidth();
      setPageWidth(width);
      setPageHeight(Math.round(width * 1.414));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
        const width = contentWidth();
        setPageWidth(width);
        setPageHeight(Math.round((width / base.width) * base.height));
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

      <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[560px] space-y-3 px-3 pb-8 pt-2">
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
