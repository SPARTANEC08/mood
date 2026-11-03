/**
 * Демо нового PDF-просмотрщика для /preview/pdf.html.
 *
 * Задача страницы — показать на реальном iPhone и Android, как будет выглядеть
 * единый экран PDF: непрерывный скролл, виртуализация страниц, свой тулбар,
 * системное «Поделиться» через Web Share API и запасной вариант «Открыть
 * системно». Это не продакшн-компонент: моковые экраны действий нужны только
 * для наглядности на десктопе.
 */

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  FolderDown,
  Loader2,
  Printer,
  Send,
  Share2,
} from 'lucide-react';

import { initDocument } from '@/lib/env';
import { initTheme } from '@/lib/theme';
import { bindViewportHeight } from '@/lib/viewport';

import '../styles.css';

type Platform = 'ios' | 'android';

const SRC = '/preview/sample.pdf';
const FILE_NAME = 'Сборник задач по физике.pdf';
const TOTAL_PAGES = 91;
const MAX_PAGE_WIDTH = 620;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;

interface PendingAnchor {
  originX: number;
  originY: number;
  ratio: number;
  midX: number;
  midY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Готовые страницы: в проде их рендерит сервер, здесь — статический набор. */
function pageImageUrl(page: number): string {
  return `/preview/pages/page-${String(page).padStart(3, '0')}.webp`;
}

initDocument();
initTheme();
bindViewportHeight();

function detectPlatform(): Platform {
  const forced = new URLSearchParams(window.location.search).get('platform');
  if (forced === 'ios' || forced === 'android') return forced;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'ios';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'ios';
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

function PdfReader({
  platform,
  embedded = false,
}: {
  platform: Platform;
  /** true — вписан в рамку телефона на десктопе; false — полноэкранно. */
  embedded?: boolean;
}) {
  const isIOS = platform === 'ios';
  const isTouchDevice = useMemo(
    () => 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    [],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const blobRef = useRef<Blob | null>(null);
  const baseWidthRef = useRef(340);
  const zoomRef = useRef(MIN_ZOOM);
  const pendingAnchorRef = useRef<PendingAnchor | null>(null);
  const currentPageRef = useRef(1);
  const visibilityRef = useRef(new Map<number, boolean>());
  const previewSlotRef = useRef<HTMLElement | null>(null);

  const [numPages] = useState(TOTAL_PAGES);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState(340);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const pageWidthRef = useRef(340);
  pageWidthRef.current = pageWidth;
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1, 2, 3]));
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('1');
  const [shareOpen, setShareOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  currentPageRef.current = currentPage;

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 2600);
  }, []);

  /* Ширина страницы по ширине области просмотра. */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return undefined;

    const measure = () => {
      const base = Math.max(240, Math.min(MAX_PAGE_WIDTH, root.clientWidth - 24));
      baseWidthRef.current = base;
      setPageWidth(Math.round(base * zoomRef.current));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const clearPreviewTransform = useCallback(() => {
    const slot = previewSlotRef.current;
    if (!slot) return;
    slot.style.transition = 'none';
    slot.style.transform = '';
    slot.style.transformOrigin = '';
    slot.style.willChange = 'auto';
    slot.style.zIndex = '';
    slot.style.position = '';
    slot.style.overflow = '';
    previewSlotRef.current = null;
  }, []);

  /**
   * Ставит новый масштаб и запоминает точку, которая должна остаться под
   * пальцем. Сам скролл поправим в useLayoutEffect после пересчёта страниц:
   * иначе браузер сначала покажет прыжок, а потом новую ширину.
   */
  const applyZoom = useCallback(
    (targetZoom: number, originX: number, originY: number, midX: number, midY: number) => {
      const root = scrollRef.current;
      if (!root) return;

      const nextZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - zoomRef.current) < 0.001) {
        clearPreviewTransform();
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const nextWidth = Math.round(baseWidthRef.current * nextZoom);
      if (nextWidth === pageWidthRef.current) {
        clearPreviewTransform();
        return;
      }

      pendingAnchorRef.current = {
        originX,
        originY,
        ratio: nextZoom / zoomRef.current,
        midX: midX - rootRect.left,
        midY: midY - rootRect.top,
      };

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      setPageWidth(nextWidth);
    },
    [clearPreviewTransform],
  );

  const toggleZoomAt = useCallback(
    (clientX: number, clientY: number) => {
      const content = contentRef.current;
      if (!content) return;

      const contentRect = content.getBoundingClientRect();
      const targetZoom = zoomRef.current > 1.05 ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
      applyZoom(
        targetZoom,
        clientX - contentRect.left,
        clientY - contentRect.top,
        clientX,
        clientY,
      );
    },
    [applyZoom],
  );

  /* После смены ширины страниц возвращаем точку жеста под палец. */
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const root = scrollRef.current;
    if (!pending || !root) return;

    pendingAnchorRef.current = null;
    const maxLeft = Math.max(0, root.scrollWidth - root.clientWidth);
    const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
    root.scrollLeft = clamp(pending.originX * pending.ratio - pending.midX, 0, maxLeft);
    root.scrollTop = clamp(pending.originY * pending.ratio - pending.midY, 0, maxTop);
    clearPreviewTransform();
  }, [pageWidth, clearPreviewTransform]);

  /**
   * Pinch и двойной тап.
   *
   * Один палец при 100% — обычный нативный скролл. Два пальца — CSS-зум
   * визуального слоя без перерисовки PDF; после жеста ширина страниц
   * фиксируется, а scrollLeft/scrollTop восстанавливают точку под пальцем.
   */
  useEffect(() => {
    const root = scrollRef.current;
    const content = contentRef.current;
    if (!root || !content) return undefined;

    let pinch: {
      startDist: number;
      startZoom: number;
      originX: number;
      originY: number;
      midX: number;
      midY: number;
      lastScale: number;
      lastDx: number;
      lastDy: number;
    } | null = null;
    let tapStart: { x: number; y: number } | null = null;
    let moved = false;
    let lastTap: { x: number; y: number; time: number } | null = null;

    const distance = (a: Touch, b: Touch): number =>
      Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const midpoint = (a: Touch, b: Touch): { x: number; y: number } => ({
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    });

    const onTouchStart = (event: TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, [role="button"]')) return;

      if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        const mid = midpoint(a, b);
        const contentRect = content.getBoundingClientRect();

        pinch = {
          startDist: Math.max(1, distance(a, b)),
          startZoom: zoomRef.current,
          originX: mid.x - contentRect.left,
          originY: mid.y - contentRect.top,
          midX: mid.x,
          midY: mid.y,
          lastScale: 1,
          lastDx: 0,
          lastDy: 0,
        };
        tapStart = null;
        moved = false;

        // Во время жеста увеличиваем только страницу под пальцами, а не весь
        // контент из 91 страницы: огромный transform-слой — это и есть OOM.
        const slot = (document.elementFromPoint(mid.x, mid.y) as HTMLElement | null)?.closest<HTMLElement>(
          '[data-page]',
        );
        if (slot) {
          const slotRect = slot.getBoundingClientRect();
          previewSlotRef.current = slot;
          slot.style.position = 'relative';
          slot.style.overflow = 'visible';
          slot.style.zIndex = '30';
          slot.style.transition = 'none';
          slot.style.transformOrigin = `${mid.x - slotRect.left}px ${mid.y - slotRect.top}px`;
          slot.style.willChange = 'transform';
        }

        event.preventDefault();
      } else if (event.touches.length === 1) {
        const touch = event.touches[0];
        tapStart = { x: touch.clientX, y: touch.clientY };
        moved = false;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (pinch && event.touches.length >= 2) {
        event.preventDefault();
        const [a, b] = [event.touches[0], event.touches[1]];
        const mid = midpoint(a, b);
        const targetZoom = clamp(
          (pinch.startZoom * distance(a, b)) / pinch.startDist,
          MIN_ZOOM,
          MAX_ZOOM,
        );
        const visualScale = targetZoom / pinch.startZoom;
        const dx = mid.x - pinch.midX;
        const dy = mid.y - pinch.midY;

        const slot = previewSlotRef.current;
        if (slot) {
          slot.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${visualScale})`;
        }
        pinch.lastScale = visualScale;
        pinch.lastDx = dx;
        pinch.lastDy = dy;
        return;
      }

      if (!pinch && tapStart && event.touches.length === 1) {
        const touch = event.touches[0];
        if (Math.hypot(touch.clientX - tapStart.x, touch.clientY - tapStart.y) > 8) {
          moved = true;
        }
      }
    };

    const finishPinchOrTap = (event: TouchEvent) => {
      if (pinch) {
        if (event.touches.length >= 2) return;
        const targetZoom = clamp(pinch.startZoom * pinch.lastScale, MIN_ZOOM, MAX_ZOOM);
        const rootRect = root.getBoundingClientRect();

        if (Math.abs(targetZoom - pinch.startZoom) < 0.001) {
          clearPreviewTransform();
        } else {
          const nextWidth = Math.round(baseWidthRef.current * targetZoom);
          if (nextWidth === pageWidthRef.current) {
            clearPreviewTransform();
          } else {
            pendingAnchorRef.current = {
              originX: pinch.originX,
              originY: pinch.originY,
              ratio: targetZoom / pinch.startZoom,
              midX: pinch.midX - rootRect.left + pinch.lastDx,
              midY: pinch.midY - rootRect.top + pinch.lastDy,
            };
            zoomRef.current = targetZoom;
            setZoom(targetZoom);
            setPageWidth(nextWidth);
          }
        }

        pinch = null;
        tapStart = null;
        moved = false;
        return;
      }

      if (event.touches.length > 0) return;

      if (tapStart && !moved) {
        const touch = event.changedTouches[0];
        if (touch) {
          const now = Date.now();
          if (
            lastTap &&
            now - lastTap.time < 300 &&
            Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 30
          ) {
            lastTap = null;
            toggleZoomAt(touch.clientX, touch.clientY);
          } else {
            lastTap = { x: touch.clientX, y: touch.clientY, time: now };
          }
        }
      }

      tapStart = null;
      moved = false;
    };

    const onTouchCancel = () => {
      if (pinch) {
        clearPreviewTransform();
        pinch = null;
      }
      tapStart = null;
      moved = false;
    };

    const preventSafariGesture = (event: Event) => event.preventDefault();

    root.addEventListener('touchstart', onTouchStart, { passive: false });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', finishPinchOrTap, { passive: false });
    root.addEventListener('touchcancel', onTouchCancel, { passive: false });
    root.addEventListener('gesturestart', preventSafariGesture);
    root.addEventListener('gesturechange', preventSafariGesture);

    return () => {
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', finishPinchOrTap);
      root.removeEventListener('touchcancel', onTouchCancel);
      root.removeEventListener('gesturestart', preventSafariGesture);
      root.removeEventListener('gesturechange', preventSafariGesture);
    };
  }, [clearPreviewTransform, toggleZoomAt, numPages]);

  useEffect(() => {
    if (numPages > 0) showNotice('Pinch или двойной тап — масштаб');
  }, [numPages, showNotice]);


  useEffect(() => {
    let alive = true;
    fetch(SRC)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (alive) blobRef.current = blob;
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  /* Рендерим только страницы рядом с экраном. */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || numPages === 0) return undefined;

    visibilityRef.current.clear();
    setVisiblePages(new Set([currentPageRef.current]));

    const limit = zoom > 1.05 ? 2 : 3;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (Number.isFinite(page) && page > 0) {
            visibilityRef.current.set(page, entry.isIntersecting);
          }
        }

        const visible = [...visibilityRef.current.entries()]
          .filter(([, isVisible]) => isVisible)
          .map(([page]) => page);

        if (visible.length === 0) visible.push(currentPageRef.current);
        visible.sort(
          (a, b) => Math.abs(a - currentPageRef.current) - Math.abs(b - currentPageRef.current),
        );
        setVisiblePages(new Set(visible.slice(0, limit)));
      },
      {
        root,
        rootMargin: zoom > 1.05 ? '320px 0px' : '800px 0px',
        threshold: 0.01,
      },
    );

    root.querySelectorAll<HTMLElement>('[data-page]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [numPages, pageWidth, zoom]);

  const updateCurrentPage = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;

    const rootTop = root.getBoundingClientRect().top;
    let best = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    root.querySelectorAll<HTMLElement>('[data-page]').forEach((node) => {
      const distance = Math.abs(node.getBoundingClientRect().top - rootTop - 8);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(node.dataset.page);
      }
    });

    setCurrentPage(best);
  }, []);

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      updateCurrentPage();
    });
  }, [updateCurrentPage]);

  const jumpTo = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(1, page), Math.max(1, numPages));
      const root = scrollRef.current;
      const element = root?.querySelector<HTMLElement>(`[data-page="${target}"]`);
      if (root && element) {
        root.scrollTo({ top: element.offsetTop - 12, behavior: 'smooth' });
      }
      setCurrentPage(target);
      setJumpOpen(false);
    },
    [numPages],
  );

  const share = useCallback(async () => {
    setSharing(true);
    let systemShare = false;

    try {
      let blob = blobRef.current;
      if (!blob) {
        const response = await fetch(SRC);
        blob = await response.blob();
        blobRef.current = blob;
      }

      const file = new File([blob], FILE_NAME, { type: 'application/pdf' });
      if (
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] })
      ) {
        systemShare = true;
        await navigator.share({ files: [file], title: FILE_NAME });
        return;
      }
    } catch {
      // Отмена системного меню — не ошибка и не повод показывать мок.
    } finally {
      setSharing(false);
    }

    if (systemShare) return;

    // На десктопе Web Share с файлами часто недоступен — показываем мок.
    setShareOpen(true);
  }, []);

  const pages = useMemo(() => Array.from({ length: numPages }, (_, index) => index + 1), [numPages]);
  const estimatedHeight = Math.round(pageWidth * 1.414);

  return (
    <div
      className={
        embedded
          ? 'relative flex h-full w-full flex-col overflow-hidden'
          : 'fixed inset-0 z-[80] flex flex-col overflow-hidden'
      }
      style={{ background: '#111113', color: 'var(--text-primary, #f5f5f7)' }}
    >
      {/* ── Шапка ─────────────────────────────────────────────────────────── */}
      <header
        className="relative z-20 flex shrink-0 items-center gap-1.5 border-b px-2.5 pb-2.5"
        style={{
          paddingTop: embedded ? (isIOS ? 44 : 30) : 'max(14px, env(safe-area-inset-top))',
          borderColor: 'rgba(255,255,255,0.09)',
          background: 'rgba(24,24,27,0.92)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <button
          type="button"
          aria-label="Назад"
          onClick={() => showNotice('В приложении кнопка вернёт к списку файлов')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full active:bg-white/10"
          style={{ color: isIOS ? '#0a84ff' : '#8ab4f8' }}
        >
          <ArrowLeft size={22} aria-hidden />
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold leading-tight">{FILE_NAME}</p>
          <p className="mt-0.5 text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,0.52)' }}>
            {numPages > 0
              ? `${currentPage} / ${numPages} стр.${zoom > 1.05 ? ` · ${Math.round(zoom * 100)}%` : ''}`
              : 'PDF'}
          </p>
        </div>

        <button
          type="button"
          aria-label="Поделиться"
          onClick={() => void share()}
          disabled={sharing}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full active:bg-white/10 disabled:opacity-50"
          style={{ color: isIOS ? '#0a84ff' : '#8ab4f8' }}
        >
          {sharing ? <Loader2 size={20} className="animate-spin" aria-hidden /> : <Share2 size={20} aria-hidden />}
        </button>
      </header>

      {/* ── Область документа ────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onDoubleClick={(event) => {
          if (isTouchDevice) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest('button, a')) return;
          event.preventDefault();
          toggleZoomAt(event.clientX, event.clientY);
        }}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        style={{
          background: '#1b1b1f',
          touchAction: 'pan-x pan-y',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div ref={contentRef} className="px-3 pb-28 pt-3" style={{ minWidth: pageWidth + 24 }}>
          {pages.map((page) => (
            <div
              key={page}
              data-page={page}
              className="mx-auto mb-3 overflow-hidden rounded-[3px] bg-white shadow-[0_10px_30px_rgba(0,0,0,0.28)]"
              style={{ width: pageWidth, height: estimatedHeight }}
            >
              {visiblePages.has(page) ? (
                <img
                  src={pageImageUrl(page)}
                  alt={`Страница ${page}`}
                  draggable={false}
                  decoding="async"
                  loading={page <= currentPage + 2 ? 'eager' : 'lazy'}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'fill',
                    userSelect: 'none',
                  }}
                />
              ) : (
                <div
                  className="animate-pulse"
                  style={{
                    height: estimatedHeight,
                    background:
                      'repeating-linear-gradient(180deg, #f4f4f5 0px, #f4f4f5 9px, #ececee 10px, #ececee 11px)',
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Плавающая навигация по страницам — вне скролла, всегда на экране */}
      {numPages > 1 ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}
        >
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-white/10 bg-black/72 p-1 shadow-xl backdrop-blur-xl">
            <button
              type="button"
              aria-label="Предыдущая страница"
              disabled={currentPage <= 1}
              onClick={() => jumpTo(currentPage - 1)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 active:bg-white/12 disabled:opacity-30"
            >
              <ChevronLeft size={20} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => {
                setJumpValue(String(currentPage));
                setJumpOpen(true);
              }}
              className="rounded-full px-3 py-1.5 text-[12px] font-semibold tabular-nums text-white/90 active:bg-white/12"
            >
              {currentPage} / {numPages}
            </button>
            <button
              type="button"
              aria-label="Следующая страница"
              disabled={currentPage >= numPages}
              onClick={() => jumpTo(currentPage + 1)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 active:bg-white/12 disabled:opacity-30"
            >
              <ChevronRight size={20} aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-40 flex justify-center px-5">
          <div className="rounded-full bg-black/85 px-4 py-2 text-center text-[12px] text-white shadow-lg">
            {notice}
          </div>
        </div>
      ) : null}

      {/* ── Переход к странице ────────────────────────────────────────────── */}
      {jumpOpen ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 px-6" onClick={() => setJumpOpen(false)}>
          <div
            className="w-full max-w-[300px] rounded-[20px] border border-white/10 bg-[#202024] p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-[17px] font-semibold">Перейти к странице</h2>
            <p className="mt-1 text-[12px] text-white/50">Всего {numPages} стр.</p>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={numPages}
              value={jumpValue}
              autoFocus
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') jumpTo(Number(jumpValue));
              }}
              className="mt-3 w-full rounded-[12px] border border-white/10 bg-white/8 px-3 py-2.5 text-[18px] font-semibold outline-none"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setJumpOpen(false)}
                className="flex-1 rounded-[12px] bg-white/8 py-2.5 text-[14px] font-semibold"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => jumpTo(Number(jumpValue))}
                className="flex-1 rounded-[12px] py-2.5 text-[14px] font-semibold text-white"
                style={{ background: isIOS ? '#0a84ff' : '#8ab4f8' }}
              >
                Перейти
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Демонстрация системного меню ──────────────────────────────────── */}
      {shareOpen ? (
        <div className="absolute inset-0 z-[60] flex items-end bg-black/45" onClick={() => setShareOpen(false)}>
          <div
            className={`w-full border-t border-white/10 bg-[#202024] p-4 ${
              isIOS ? 'rounded-t-[26px]' : 'rounded-t-[20px]'
            }`}
            style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/25" />
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-red-500/15">
                <FileText size={22} className="text-red-400" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold">{FILE_NAME}</p>
                <p className="text-[11px] text-white/45">PDF · 1,5 МБ</p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { icon: FolderDown, label: 'В Файлы' },
                { icon: Printer, label: 'Печать' },
                { icon: Send, label: 'Отправить' },
                { icon: Copy, label: 'Копия' },
              ].map(({ icon: Icon, label }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setShareOpen(false);
                    showNotice('В приложении здесь откроется системное меню');
                  }}
                  className="flex flex-col items-center gap-2 rounded-[12px] px-1 py-2 active:bg-white/8"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/8">
                    <Icon size={21} style={{ color: isIOS ? '#0a84ff' : '#8ab4f8' }} aria-hidden />
                  </span>
                  <span className="text-[11px] text-white/75">{label}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShareOpen(false)}
              className="mt-4 w-full rounded-[13px] bg-white/8 py-3 text-[15px] font-semibold"
            >
              Отмена
            </button>
            <p className="mt-2 text-center text-[10px] leading-snug text-white/35">
              Это демонстрация меню. На реальном устройстве откроется системное меню{' '}
              {isIOS ? 'iOS' : 'Android'}.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DeviceFrame({
  platform,
  label,
  children,
}: {
  platform: Platform;
  label: string;
  children: ReactNode;
}) {
  const isIOS = platform === 'ios';

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`relative h-[760px] w-[370px] overflow-hidden border-black bg-black shadow-[0_40px_100px_rgba(0,0,0,0.65)] ${
          isIOS ? 'rounded-[54px] border-[10px]' : 'rounded-[40px] border-[8px]'
        }`}
      >
        <div className={`absolute inset-0 overflow-hidden ${isIOS ? 'rounded-[44px]' : 'rounded-[32px]'}`}>
          {children}
        </div>

        {isIOS ? (
          <div className="pointer-events-none absolute left-1/2 top-2.5 z-30 h-[26px] w-[112px] -translate-x-1/2 rounded-full bg-black" />
        ) : (
          <div className="pointer-events-none absolute left-1/2 top-2 z-30 h-3 w-3 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10" />
        )}

        <div
          className={`pointer-events-none absolute bottom-2 left-1/2 z-30 h-1 -translate-x-1/2 rounded-full bg-white/55 ${
            isIOS ? 'w-28' : 'w-24'
          }`}
        />
      </div>
      <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/45">{label}</span>
    </div>
  );
}

function DesktopDemo() {
  return (
    <div className="min-h-screen bg-[#0b0b0d] text-white">
      <div className="mx-auto max-w-[1120px] px-8 py-10">
        <header className="mb-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-violet-400">
            Демо · PDF
          </p>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight">
            Один просмотрщик для iOS и Android
          </h1>
          <p className="mt-2 max-w-[720px] text-[14px] leading-relaxed text-white/55">
            Так PDF будет выглядеть в приложении: непрерывный скролл, только видимые страницы,
            свой тулбар и системное «Поделиться». Страницы здесь — готовые изображения:
            телефон не парсит PDF и не пересчитывает разрешение при зуме.
          </p>
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/60">
            <Check size={14} className="text-emerald-400" aria-hidden />
            mood-app.ru/preview/pdf.html
          </p>
        </header>

        <div className="flex items-start justify-center gap-14">
          <DeviceFrame platform="ios" label="iPhone · iOS">
            <PdfReader platform="ios" embedded />
          </DeviceFrame>
          <DeviceFrame platform="android" label="Android">
            <PdfReader platform="android" embedded />
          </DeviceFrame>
        </div>

        <div className="mx-auto mt-10 grid max-w-[860px] gap-3 sm:grid-cols-3">
          {[
            ['Только нужное', 'Назад, страница и «Поделиться» — без «Скачать» и лишних меню.'],
            ['Системное меню', 'Кнопка «Поделиться» вызывает родное меню iOS или Android.'],
            ['Жесты', 'Pinch и двойной тап: зум к точке жеста, без кнопок +/−.'],
          ].map(([title, text]) => (
            <div key={title} className="rounded-[14px] border border-white/8 bg-white/[0.035] p-4">
              <p className="text-[13px] font-semibold">{title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-white/45">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PdfDemoApp() {
  const isDesktop = useIsDesktop();
  const platform = useMemo(detectPlatform, []);

  if (isDesktop) return <DesktopDemo />;

  return (
    <div className="h-full bg-[#111113]">
      <PdfReader platform={platform} />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Не найден элемент #root');

createRoot(container).render(
  <StrictMode>
    <PdfDemoApp />
  </StrictMode>,
);
