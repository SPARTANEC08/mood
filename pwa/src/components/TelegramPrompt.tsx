/**
 * Приглашение подключить Telegram при входе.
 *
 * Показывается при КАЖДОМ заходе в приложение, пока бот не привязан: в
 * приложении уведомления о баллах, письмах, приказах и стипендии приходят только
 * в Telegram, и без привязки человек о них просто не узнаёт.
 *
 * ── Почему отказ не запоминается ────────────────────────────────────────────
 *
 * Раньше «Позже» прятало лист на 30 дней, и часть людей так и не подключала
 * бота. Теперь отказ действует только до конца текущего захода: закрыл — и лист
 * вернётся при следующем открытии приложения. Как только привязка появится,
 * приглашение исчезнет навсегда.
 *
 * ── Что считается «заходом» ─────────────────────────────────────────────────
 *
 * И монтирование (открытие/перезагрузка), и возврат к приложению из фона
 * (`visibilitychange`). Установленное приложение на телефоне часто не
 * перезагружается, а просто разворачивается — без второго триггера лист
 * появлялся бы только после полного перезапуска.
 */

import { useCallback, useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';

import { BottomSheet } from '@/components/ui';
import { haptic, openLink } from '@/lib/env';

/**
 * Имя бота для deep link `t.me/<bot>?start=<userId>`.
 *
 * Та же переменная сборки, что и в «Кабинете»: при смене бота правится одно
 * место, а не два.
 */
const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'mood_mpei_bot';

/** Пауза перед показом: лист не должен выскакивать в кадре загрузки. */
const SHOW_DELAY_MS = 1200;

export function TelegramPrompt({
  userId,
  telegramId,
}: {
  userId: string;
  telegramId: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const connected = typeof telegramId === 'number' || !userId;

  /** Показ с задержкой: сначала человек видит приложение, потом приглашение. */
  useEffect(() => {
    if (connected) return;

    let timer = 0;
    const show = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
    };

    show();

    // Возврат в приложение из фона — тоже заход.
    const onVisible = () => {
      if (document.visibilityState === 'visible') show();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connected]);

  // Подключили Telegram, пока лист был открыт (например, вернулись из бота) —
  // закрываем сразу: приглашать больше не к чему.
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);

  const close = useCallback(() => {
    haptic('light');
    setOpen(false);
  }, []);

  const connect = useCallback(() => {
    haptic('medium');
    setOpen(false);
    openLink(`https://t.me/${TELEGRAM_BOT_USERNAME}?start=${userId}`);
  }, [userId]);

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title="Уведомления в Telegram"
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={connect}
            className="pressable flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[17px] font-semibold text-white active:pressable-active"
            style={{ background: 'var(--accent)' }}
          >
            <Send size={17} aria-hidden />
            Подключить Telegram
          </button>

          <button
            type="button"
            onClick={close}
            className="pressable w-full rounded-[14px] py-3 text-[16px] font-semibold active:pressable-active"
            style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}
          >
            Позже
          </button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          aria-hidden
        >
          <Bell size={21} />
        </span>

        <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Подключите Telegram — и Mood пришлёт, когда появятся новые баллы, письма,
          приказы или изменится стипендия. Это одна кнопка в боте, приложение
          остаётся тем же.
        </p>
      </div>
    </BottomSheet>
  );
}
