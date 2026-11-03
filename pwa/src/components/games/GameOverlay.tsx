import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink, Gamepad2 } from 'lucide-react';

import { haptic, openLink } from '@/lib/env';

/** Игра живёт на отдельном сервере и в отдельном origin — токен Mood ей недоступен. */
const GAME_URL = 'https://109-120-129-61.sslip.io/games/block-blast/';
const GAME_ORIGIN = 'https://109-120-129-61.sslip.io';

interface CloseMessage {
  type?: string;
}

/**
 * Полноэкранный оверлей с игрой.
 *
 * iframe намеренно кросс-оригинный: игра не может прочитать localStorage и
 * PWA-токен, а её скрипты и реклама не попадают в CSP основного приложения.
 * Кнопка «Вернуться в Mood» внутри игры присылает `mood:close-game`, мы
 * подтверждаем получение и закрываем оверлей.
 */
export function GameOverlay({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(() => {
    haptic('light');
    closeRef.current();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== GAME_ORIGIN) return;

      const data = event.data as CloseMessage | null;
      if (data?.type !== 'mood:close-game') return;

      // Подтверждаем игре, что родитель обработал просьбу: тогда её запасной
      // вариант с новой вкладкой не сработает.
      const source = event.source as Window | null;
      source?.postMessage({ type: 'mood:close-game-ack' }, event.origin);
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /*
   * Кнопка «Назад» в Android и жест назад в браузере должны закрывать игру,
   * а не выкидывать из PWA. Пушим отдельную запись истории и снимаем её при
   * закрытии, чтобы не оставлять мусор в истории.
   */
  useEffect(() => {
    window.history.pushState({ moodGame: 'block-blast' }, '');

    const onPopState = () => closeRef.current();
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (window.history.state?.moodGame === 'block-blast') {
        window.history.back();
      }
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Block Pop"
      className="fixed inset-x-0 top-0 z-[90] flex flex-col bg-[#080d21]"
      style={{ height: 'var(--app-height, 100dvh)' }}
    >
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Закрыть игру"
          className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/80 active:pressable-active"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        >
          <ArrowLeft size={19} aria-hidden />
        </button>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-[14px] font-semibold text-white">Block Pop</p>
          <p className="text-[11px] text-white/45">Игра внутри Mood</p>
        </div>

        <button
          type="button"
          onClick={() => {
            haptic('light');
            openLink(GAME_URL);
          }}
          aria-label="Открыть игру в браузере"
          className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/60 active:pressable-active"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        >
          <ExternalLink size={17} aria-hidden />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#080d21] text-white/60">
            <Gamepad2 size={30} className="animate-pulse" aria-hidden />
            <p className="text-[13px]">Загружаем игру…</p>
          </div>
        ) : null}

        <iframe
          src={GAME_URL}
          title="Block Pop"
          className="h-full w-full border-0"
          allow="fullscreen; autoplay; gamepad; clipboard-write"
          referrerPolicy="no-referrer"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>,
    document.body,
  );
}
