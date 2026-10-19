/**
 * Уведомления от админа внутри приложения.
 *
 * Пока приложение открыто, раз в 30 секунд спрашиваем сервер: есть ли
 * непрочитанное объявление. Показываем его модальным окном с текстом и кнопкой
 * «Закрыть»; после закрытия сразу берём следующее из очереди.
 *
 * Почему опрос, а не push: у PWA нет своего push-канала в этой сборке, а одно
 * лёгкое GET-сравнение (файл читается из памяти процесса) дешевле, чем
 * поддержка WebPush и разрешений. Запрос идёт только когда вкладка видима.
 *
 * Компонент монтируется только для авторизованных в БАРС: сервер всё равно
 * отвечает 401 bars_login_required остальным, но лишний запрос на экране входа
 * не нужен.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { AppAnnouncement } from '@/types/api';

/** Период опроса, пока приложение открыто. */
const POLL_MS = 30_000;

export function AnnouncementGate() {
  const [item, setItem] = useState<AppAnnouncement | null>(null);
  const [closing, setClosing] = useState(false);
  /** Что показано прямо сейчас — чтобы опрос не подменял открытое окно. */
  const showing = useRef(false);

  const load = useCallback(async () => {
    if (showing.current) return;
    try {
      const { item: next } = await api.announcementNext();
      if (next && !showing.current) {
        showing.current = true;
        setItem(next);
      }
    } catch {
      // Нет сети / нет входа в БАРС — молчим и повторим при следующем опросе.
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);

    // Возврат в приложение — самый частый случай «человек давно не открывал».
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const close = useCallback(async () => {
    const current = item;
    if (!current || closing) return;

    setClosing(true);
    try {
      await api.dismissAnnouncement(current.id);
    } catch {
      // Сервер недоступен: закрываем локально, иначе окно не убрать.
    } finally {
      showing.current = false;
      setItem(null);
      setClosing(false);
      // Очередь: если админ отправил несколько — сразу показываем следующее.
      void load();
    }
  }, [closing, item, load]);

  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-5"
      role="dialog"
      aria-modal="true"
      aria-label="Уведомление"
    >
      <button
        type="button"
        aria-label="Закрыть"
        onClick={() => void close()}
        className="absolute inset-0 bg-black/45"
      />

      <div
        className="relative w-full max-w-[420px] rounded-[20px] p-5"
        style={{ background: 'var(--surface)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}
      >
        <h2 className="text-[17px] font-semibold">Уведомление</h2>
        <p
          className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {item.text}
        </p>

        <button
          type="button"
          onClick={() => {
            haptic('light');
            void close();
          }}
          disabled={closing}
          className="pressable mt-4 w-full rounded-[14px] py-3 text-[16px] font-semibold text-white active:pressable-active disabled:opacity-60"
          style={{ background: 'var(--accent)' }}
        >
          {closing ? 'Закрываем…' : 'Закрыть'}
        </button>
      </div>
    </div>
  );
}
