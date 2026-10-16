/**
 * InAppBrowser — встроенный просмотрщик файлов в стиле вкладки браузера.
 *
 * Зачем он вообще: раньше тап по файлу выносил человека из приложения в Safari
 * по короткоживущей share-ссылке. Это разрывало контекст (свернулось приложение,
 * потерялась позиция в списке), а в standalone-PWA вообще выглядело как «меня
 * выкинуло». Теперь файл открывается внутри PWA, а Safari остался лишь явным
 * пунктом в overflow-меню.
 *
 * ── Ключевые решения ─────────────────────────────────────────────────────────
 *
 * 1. Портал в document.body. `position: fixed` внутри `transform`-трека
 *    SwipePager (расписание) позиционируется относительно трека, а не экрана, и
 *    вьюер уезжал бы вместе с лентой. Портал выносит узел за пределы любого
 *    трансформированного предка.
 *
 * 2. Три режима рендера и один вход. Тап по ЛЮБОМУ файлу открывает этот
 *    компонент; он сам решает, показать картинку, PDF или карточку действий.
 *    Снаружи про типы знать не нужно.
 *
 * 3. Никаких window.open с blob-URL. На iOS это роняет webview или открывает
 *    пустую страницу. Системный share-sheet и `<a download>` решают задачу
 *    нативно.
 *
 * 4. Один объектный URL на просмотр, отзыв при закрытии/переключении. URL
 *    скачивания отдельный и с отложенным отзывом (см. стратегию скачивания).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Download, File as FileIcon, X } from 'lucide-react';

import { ApiError, api, deliverFileToSystem } from '@/lib/api';
import { getCachedFile } from '@/lib/fileCache';
import { haptic, isDataSaver } from '@/lib/env';
import type { ServerFileRef } from '@/types/api';

type Mode = 'image' | 'fallback';

interface Props {
  /** Файлы того же списка — по ним листается вьюер. */
  files: ServerFileRef[];
  initialIndex: number;
  onClose: () => void;
}

interface LoadedFile {
  fileId: string;
  url: string;
  blob: Blob;
}

/** Картинки, которые показываются нативно. Прочие image/* падают в fallback. */
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

/** Спиннер показывается только после этой задержки: мгновенный из кэша не мигает. */
const SPINNER_DELAY_MS = 300;
const TOAST_MS = 2400;
const SWIPE_DOWN_CLOSE_PX = 110;
const SWIPE_H_CHANGE_PX = 60;
const EDGE_ZONE_PX = 24;
const MAX_ZOOM = 4;
const DOUBLE_TAP_MS = 300;

function modeFor(file: ServerFileRef): Mode {
  if (IMAGE_MIME.test(file.mimeType)) return 'image';
  return 'fallback';
}

/** «84569» → «83 КБ». Локальная копия: тянуть сюда весь FileAttachmentList нельзя
 *  (он импортирует этот компонент — вышел бы цикл). */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 КБ';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * Доставка файла системе живёт в lib/api/files.ts (`deliverFileToSystem`):
 * одна реализация на тап в списке и на кнопку во вьюере. Раньше здесь была
 * своя копия, а в списке — вообще только blob-навигация, чем и был вызван
 * баг с перезагрузкой при возврате из системного PDF-просмотрщика.
 *
 * Подписка на медиазапрос удалена: шапка теперь одинакова на любой ширине —
 * одна кнопка действия помещается даже на самом узком экране. */

export function InAppBrowser({ files, initialIndex, onClose }: Props) {
  const fileCount = files.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, fileCount - 1)));
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [preview, setPreview] = useState<{ fileId: string; url: string } | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [showSpinner, setShowSpinner] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  /** true, когда оригинал отложен из-за экономии трафика (Save-Data). */
  const [deferred, setDeferred] = useState(false);
  const [closing, setClosing] = useState(false);
  const [toast, setToast] = useState<{ text: string; onRetry?: () => void } | null>(null);

  const file = files[index];
  const mode = file ? modeFor(file) : 'fallback';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dragLayerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const downloadGuard = useRef(false);
  // Файлы читаются в эффектах через ref: иначе новая ссылка на массив при
  // каждом ререндере родителя перезапускала бы загрузку и отзывала URL.
  const filesRef = useRef(files);
  filesRef.current = files;

  // ── Тост ───────────────────────────────────────────────────────────────────
  const showToast = useCallback((text: string, onRetry?: () => void) => {
    setToast({ text, onRetry });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // ── Открытие/закрытие ──────────────────────────────────────────────────────
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    // Даём анимации закрытия доиграть (220 мс), затем размонтируемся.
    window.setTimeout(onClose, 220);
  }, [onClose]);

  // ── Загрузка текущего файла ────────────────────────────────────────────────
  const loadOriginal = useCallback(
    async (target: ServerFileRef, alive: () => boolean) => {
      const res = await api.fetchFile(target.fileId, (loadedBytes, total) => {
        if (alive() && total > 0) setProgress(Math.min(1, loadedBytes / total));
      });
      // Вьюер успел закрыться, пока шла сеть — URL уже никто не увидит,
      // поэтому отзываем здесь, а не оставляем висеть до лучших времён.
      if (!alive()) {
        res.revoke();
      }
      return res;
    },
    [],
  );

  const resetTransforms = useCallback(() => {
    scaleRef.current = 1;
    txRef.current = 0;
    tyRef.current = 0;
    pointers.current.clear();
    gesture.current.mode = 'none';
    const img = imgRef.current;
    if (img) {
      img.style.transition = 'none';
      img.style.transform = 'translate3d(0, 0, 0) scale(1)';
      img.style.willChange = 'auto';
    }
    const layer = dragLayerRef.current;
    if (layer) {
      layer.style.transition = 'none';
      layer.style.transform = '';
    }
    const back = backdropRef.current;
    if (back) back.style.opacity = '';
    setDeferred(false);
  }, []);

  useEffect(() => {
    if (!file) return;

    let alive = true;
    let objectUrl: string | null = null;
    let spinnerTimer: number | null = null;
    const isAlive = () => alive;

    resetTransforms();
    setLoaded(null);
    setPreview(null);
    setPhase('loading');
    setErrorText(null);
    setShowSpinner(false);
    setProgress(null);

    const mode = modeFor(file);
    const cached = getCachedFile(file.fileId);

    // Файл в режиме fallback (docx, zip, …) не грузим вообще: чтобы показать
    // карточку с именем и размером, содержимое не нужно. Оно понадобится только
    // при «Скачать»/«Поделиться» — и загрузится тогда, по требованию. Иначе
    // открытие вкладки тянуло бы десяток мегабайт ради одной надписи.
    if (mode === 'fallback') {
      setPhase('ready');
      return () => {
        alive = false;
      };
    }

    // Превью для картинки показываем сразу, независимо от того, догрузится ли
    // оригинал: пользователь не должен смотреть в пустоту.
    if (mode === 'image') {
      api
        .previewUrl(file.fileId)
        .then((url) => {
          if (alive) setPreview({ fileId: file.fileId, url });
        })
        .catch(() => undefined);
    }

    if (cached) {
      // В кэше — мгновенно, без спиннера и прогресса.
      objectUrl = URL.createObjectURL(cached);
      setLoaded({ fileId: file.fileId, url: objectUrl, blob: cached });
      setPhase('ready');
    } else if (mode === 'image' && isDataSaver()) {
      // Экономия трафика: оригинал не тянем, показываем превью и кнопку.
      setPhase('ready');
      setDeferred(true);
    } else {
      spinnerTimer = window.setTimeout(() => {
        if (alive) setShowSpinner(true);
      }, SPINNER_DELAY_MS);

      loadOriginal(file, isAlive)
        .then((res) => {
          if (!alive) {
            res.revoke();
            return;
          }
          objectUrl = res.url;
          setLoaded({ fileId: file.fileId, url: res.url, blob: res.blob });
          setPhase('ready');
          setProgress(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setShowSpinner(false);
          setPhase('error');
          setErrorText(err instanceof ApiError ? err.message : 'Не удалось открыть файл.');
        })
        .finally(() => {
          if (spinnerTimer) window.clearTimeout(spinnerTimer);
        });
    }

    // Соседей (±1) подгружаем в fileCache — свайп тогда мгновенный.
    if (!isDataSaver() && mode === 'image') {
      const list = filesRef.current;
      for (const delta of [1, -1]) {
        const neighbor = list[index + delta];
        if (neighbor && modeFor(neighbor) === 'image') {
          void api.prefetchFile(neighbor.fileId, neighbor.size);
        }
      }
    }

    return () => {
      alive = false;
      if (spinnerTimer) window.clearTimeout(spinnerTimer);
      // Отзыв ровно того URL, что показывал этот файл: превью-URL живёт в кэше
      // api и переиспользуется миниатюрой в списке — его трогать нельзя.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Зависимость — идентификатор файла, а не объект/массив: их ссылка может
    // меняться на каждом ререндере, а содержимое — нет.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.fileId, index, loadOriginal, resetTransforms]);

  // ── Кнопка действия: системное «Поделиться» (иначе — скачивание) ────────────
  //
  // Наверху одна кнопка. Она открывает системное окно «Поделиться» с файлом —
  // на iOS это единственный надёжный способ «Сохранить в Файлы» / «Отправить
  // в…». Если системы поделиться нет (или она отказала), файл просто
  // скачивается якорем.
  //
  // Про жест: `navigator.share` обязан вызываться синхронно внутри тапа, иначе
  // iOS отвечает NotAllowedError. Для картинки и PDF blob уже загружен (вьюер
  // их показывает), поэтому share вызывается без await. Сеть ждём только в
  // режиме fallback, где файл намеренно не грузится до нажатия.
  const actionRef = useRef<() => void>(() => {});

  const onAction = useCallback(() => {
    if (!file) return;
    haptic('medium');

    const name = file.originalName || `file-${file.fileId}`;
    const ready = loaded?.fileId === file.fileId ? loaded.blob : getCachedFile(file.fileId);

    if (ready) {
      deliverFileToSystem(ready, name, file.mimeType);
      return;
    }

    if (downloadGuard.current) return;
    downloadGuard.current = true;

    void api
      .fetchFile(file.fileId)
      .then((res) => {
        res.revoke();
        deliverFileToSystem(res.blob, name, file.mimeType);
      })
      .catch((err: unknown) => {
        showToast(err instanceof ApiError ? err.message : 'Не удалось скачать файл', () =>
          actionRef.current(),
        );
      })
      .finally(() => {
        downloadGuard.current = false;
      });
  }, [file, loaded, showToast]);

  // Ссылка на обработчик для кнопки «Повторить» в тосте: сам себя useCallback
  // в замыкании не видит.
  actionRef.current = onAction;

  // ── Фокус-трап и Escape ─────────────────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [requestClose]);

  // ── Жесты (картинка) ────────────────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);
  const gesture = useRef({
    startX: 0,
    startY: 0,
    startDist: 1,
    startScale: 1,
    baseTx: 0,
    baseTy: 0,
    mode: 'none' as 'none' | 'pending' | 'pan' | 'hswipe' | 'vswipe' | 'pinch',
    edge: false,
    lastTap: 0,
    lastTapX: 0,
    lastTapY: 0,
  });

  const applyImage = useCallback((scale: number, tx: number, ty: number, animate: boolean) => {
    const img = imgRef.current;
    if (!img) return;
    img.style.transition = animate ? 'transform 0.2s var(--ease-ios)' : 'none';
    img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    // will-change включается только пока есть что анимировать: постоянный
    // композитный слой на фотографии держал бы лишнюю видеопамять.
    img.style.willChange = scale !== 1 || tx !== 0 || ty !== 0 ? 'transform' : 'auto';
  }, []);

  const resetDragLayer = useCallback((animate: boolean) => {
    const layer = dragLayerRef.current;
    if (layer) {
      layer.style.transition = animate ? 'transform 0.22s var(--ease-ios)' : 'none';
      layer.style.transform = '';
    }
    const back = backdropRef.current;
    if (back) back.style.opacity = '';
  }, []);

  const changeIndex = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= fileCount) return;
      haptic('light');
      setIndex(next);
    },
    [fileCount, index],
  );

  const toggleZoom = useCallback(() => {
    if (scaleRef.current > 1) {
      scaleRef.current = 1;
      txRef.current = 0;
      tyRef.current = 0;
      applyImage(1, 0, 0, true);
    } else {
      scaleRef.current = 2.25;
      applyImage(2.25, 0, 0, true);
    }
  }, [applyImage]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;

    if (pointers.current.size === 1) {
      g.startX = event.clientX;
      g.startY = event.clientY;
      g.baseTx = txRef.current;
      g.baseTy = tyRef.current;
      g.edge = event.clientX < EDGE_ZONE_PX;
      g.mode = 'pending';
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.startScale = scaleRef.current;
      g.mode = 'pinch';
    }
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const g = gesture.current;

      if (pointers.current.size >= 2 && g.mode === 'pinch') {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const scale = Math.min(MAX_ZOOM, Math.max(1, g.startScale * (dist / g.startDist)));
        scaleRef.current = scale;
        applyImage(scale, txRef.current, tyRef.current, false);
        return;
      }

      if (pointers.current.size !== 1) return;

      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;

      if (g.mode === 'pending') {
        if (scaleRef.current > 1) {
          g.mode = 'pan';
        } else if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          g.mode = Math.abs(dx) > Math.abs(dy) ? 'hswipe' : 'vswipe';
        }
      }

      if (g.mode === 'pan') {
        txRef.current = g.baseTx + dx;
        tyRef.current = g.baseTy + dy;
        applyImage(scaleRef.current, txRef.current, tyRef.current, false);
      } else if (g.mode === 'hswipe') {
        const layer = dragLayerRef.current;
        // На краях лента идёт вчетверо медленнее — жест читается как граница.
        const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === fileCount - 1);
        if (layer) layer.style.transform = `translateX(${dx * (atEdge ? 0.25 : 1)}px)`;
      } else if (g.mode === 'vswipe') {
        const offset = Math.max(0, dy);
        const layer = dragLayerRef.current;
        const back = backdropRef.current;
        if (layer) layer.style.transform = `translateY(${offset}px)`;
        if (back) back.style.opacity = String(Math.max(0.15, 1 - offset / 400));
      }
    },
    [applyImage, fileCount, index],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.delete(event.pointerId);
      const g = gesture.current;

      // После щипка остался один палец — логично продолжить панорамирование
      // увеличенной картинки, а не считать жест завершённым.
      if (pointers.current.size === 1 && g.mode === 'pinch') {
        const remaining = [...pointers.current.values()][0];
        g.startX = remaining.x;
        g.startY = remaining.y;
        g.baseTx = txRef.current;
        g.baseTy = tyRef.current;
        g.mode = 'pan';
        return;
      }

      if (pointers.current.size > 0) return;

      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      const wasMode = g.mode;
      g.mode = 'none';

      if (wasMode === 'vswipe') {
        resetDragLayer(true);
        if (dy > SWIPE_DOWN_CLOSE_PX) requestClose();
        return;
      }

      if (wasMode === 'hswipe') {
        resetDragLayer(true);
        if (dx > SWIPE_H_CHANGE_PX) {
          if (g.edge && index === 0) requestClose();
          else changeIndex(-1);
        } else if (dx < -SWIPE_H_CHANGE_PX) {
          changeIndex(1);
        }
        return;
      }

      if (wasMode === 'pan') {
        // Масштаб 1× не оставляем сдвинутым: картинка должна вернуться в центр.
        if (scaleRef.current <= 1.01) {
          scaleRef.current = 1;
          txRef.current = 0;
          tyRef.current = 0;
          applyImage(1, 0, 0, true);
        }
        return;
      }

      // Ничего не двигали: возможно, это двойной тап.
      if (wasMode === 'pending' && Math.abs(dx) < 6 && Math.abs(dy) < 6) {
        const now = Date.now();
        if (now - g.lastTap < DOUBLE_TAP_MS && Math.hypot(event.clientX - g.lastTapX, event.clientY - g.lastTapY) < 32) {
          g.lastTap = 0;
          toggleZoom();
        } else {
          g.lastTap = now;
          g.lastTapX = event.clientX;
          g.lastTapY = event.clientY;
        }
      }
    },
    [applyImage, changeIndex, index, requestClose, resetDragLayer, toggleZoom],
  );

  // Пока показываем превью, оригинал картинки догружается фоном — src
  // подменяется автоматически, как только blob готов.
  const imageSrc = loaded?.fileId === file?.fileId ? loaded.url : preview?.fileId === file?.fileId ? preview.url : null;

  const dots = useMemo(() => files.map((f) => f.fileId), [files]);

  if (!file) return null;

  return createPortal(
    <div ref={rootRef} data-hub-file-viewer className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={`Просмотр ${file.originalName}`}>
      {/* Подложка. Отдельным слоем: при свайпе вниз именно она проявляется. */}
      <motion.div
        ref={backdropRef}
        className="absolute inset-0 bg-black/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: closing ? 0 : 1 }}
        transition={{ duration: 0.2 }}
        onClick={requestClose}
        aria-hidden
      />

      <motion.div
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={{ background: 'var(--app-bg)', borderRadius: '14px 14px 0 0' }}
        initial={{ y: '100%', opacity: 0.6 }}
        animate={closing ? { y: '100%', opacity: 0 } : { y: 0, opacity: 1 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      >
        {/* Слой жестов: двигается целиком (шапка + контент), как страница Safari. */}
        <div ref={dragLayerRef} className="flex min-h-0 flex-1 flex-col">
          {/*
            Шапка опущена ниже кромки экрана: сверху — область статус-бара и
            чёлка, и прижатые к самому верху кнопки на телефоне было трудно
            достать большим пальцем. К safe-area добавляем собственный отступ,
            чтобы элементы не липли к вырезу.
          */}
          <div
            className="relative z-10 flex items-center gap-2 px-3 pb-2.5"
            style={{
              paddingTop: 'max(30px, calc(env(safe-area-inset-top) + 26px))',
              background: 'var(--surface-blur)',
              backdropFilter: 'blur(12px)',
              borderBottom: '1px solid var(--separator-soft)',
            }}
          >
            <IconButton label="Закрыть просмотр" onClick={requestClose}>
              <X size={22} aria-hidden />
            </IconButton>

            {/*
              У фото в шапке только название файла (без псевдо-URL и без
              копирования ссылки): псевдо-адрес путал, а имя и так понятнее.
              Сам просмотр фото (зум, свайп, закрытие) не менялся.
            */}
            <h1
              className="min-w-0 flex-1 truncate text-center text-[14px] font-medium"
              title={file.originalName}
            >
              {file.originalName}
            </h1>

            {/* Одна кнопка действия: системное окно «Поделиться», при отказе —
                скачивание. */}
            <IconButton label="Поделиться файлом" onClick={onAction}>
              <Download size={21} aria-hidden />
            </IconButton>
          </div>

          {/* Тонкая полоса прогресса: показывается только если загрузка реально
              идёт (state progress появляется после старта сети). */}
          {progress !== null ? (
            <div className="h-0.5 w-full" style={{ background: 'var(--separator-soft)' }} aria-hidden>
              <div
                className="h-full transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%`, background: 'var(--accent)' }}
              />
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {mode === 'image' ? (
              <div
                className="flex h-full w-full items-center justify-center overflow-hidden"
                style={{ touchAction: 'none' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {imageSrc ? (
                  <img
                    ref={imgRef}
                    src={imageSrc}
                    alt={file.originalName}
                    draggable={false}
                    decoding="async"
                    fetchPriority="high"
                    className="max-h-full max-w-full select-none object-contain"
                    style={{ transform: 'translate3d(0,0,0) scale(1)' }}
                  />
                ) : null}

                {deferred ? (
                  <div className="absolute inset-x-0 bottom-6 flex justify-center px-6">
                    <button
                      type="button"
                      onClick={() => {
                        haptic('light');
                        setDeferred(false);
                        setShowSpinner(true);
                        const alive = () => true;
                        loadOriginal(file, alive)
                          .then((res) => {
                            setLoaded({ fileId: file.fileId, url: res.url, blob: res.blob });
                            setPhase('ready');
                          })
                          .catch(() => showToast('Не удалось загрузить файл'))
                          .finally(() => setShowSpinner(false));
                      }}
                      className="pressable rounded-full px-5 py-2.5 text-[15px] font-medium text-white active:pressable-active"
                      style={{ background: 'var(--accent)' }}
                    >
                      Загрузить полностью
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === 'fallback' ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <FileIcon size={52} style={{ color: 'var(--text-tertiary)' }} aria-hidden />
                <p className="text-[16px] font-medium">{file.originalName}</p>
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {humanSize(file.size)} · {file.mimeType}
                </p>
                <button
                  type="button"
                  onClick={onAction}
                  className="pressable mt-2 flex items-center gap-2 rounded-[14px] px-6 py-3 text-[16px] font-semibold text-white active:pressable-active"
                  style={{ background: 'var(--accent)' }}
                >
                  <Download size={18} aria-hidden />
                  Скачать
                </button>
              </div>
            ) : null}

            {showSpinner && phase === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
                <div
                  className="spinner h-7 w-7 rounded-full border-2 border-t-transparent"
                  style={{ borderColor: 'var(--separator)', borderTopColor: 'transparent' }}
                />
              </div>
            ) : null}

            {phase === 'error' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--app-bg)] px-8 text-center">
                <p className="text-[15px]" style={{ color: 'var(--text-secondary)' }}>{errorText}</p>
                <button
                  type="button"
                  onClick={() => {
                    haptic('light');
                    setPhase('loading');
                    setShowSpinner(true);
                    loadOriginal(file, () => true)
                      .then((res) => {
                        setLoaded({ fileId: file.fileId, url: res.url, blob: res.blob });
                        setPhase('ready');
                      })
                      .catch(() => setPhase('error'))
                      .finally(() => setShowSpinner(false));
                  }}
                  className="pressable rounded-full px-5 py-2 text-[15px] font-medium active:pressable-active"
                  style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}
                >
                  Повторить
                </button>
              </div>
            ) : null}
          </div>

          {/* Нижняя панель: точки-соседи, safe-area. */}
          {fileCount > 1 ? (
            <div
              className="flex items-center justify-center gap-2 border-t py-2"
              style={{
                borderColor: 'var(--separator-soft)',
                background: 'var(--surface-blur)',
                paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
              }}
            >
              {dots.map((id, i) => (
                <button
                  key={id}
                  type="button"
                  aria-label={`Файл ${i + 1} из ${fileCount}`}
                  aria-current={i === index}
                  onClick={() => {
                    haptic('light');
                    setIndex(i);
                  }}
                  className="pressable h-2 w-2 rounded-full active:pressable-active"
                  style={{
                    background: i === index ? 'var(--accent)' : 'var(--separator)',
                    transform: i === index ? 'scale(1.15)' : 'none',
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        {toast ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(24px+env(safe-area-inset-bottom))] z-40 flex justify-center px-6">
            <div
              className="animate-fade pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2.5 text-[14px] text-white"
              style={{ background: 'rgba(0,0,0,0.82)' }}
              role="status"
            >
              <span>{toast.text}</span>
              {toast.onRetry ? (
                <button
                  type="button"
                  onClick={() => { setToast(null); toast.onRetry?.(); }}
                  className="font-semibold"
                  style={{ color: 'var(--accent)' }}
                >
                  Повторить
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </motion.div>
    </div>,
    document.body,
  );
}

/** Кнопка шапки вкладки. Декоративная иконка — aria-hidden, действие — в label. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full active:pressable-active"
      style={{ color: 'var(--accent)' }}
    >
      {children}
    </button>
  );
}
