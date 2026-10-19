/**
 * Индикатор фонового обновления данных вкладки.
 *
 * ── Зачем он нужен ─────────────────────────────────────────────────────────
 *
 * Кнопки «Обновить» в интерфейсе нет, и данные обновляются сами: при заходе на
 * вкладку после TTL и при возврате в приложение (`visibilitychange`). Загрузка
 * намеренно НЕ поднимает скелетон — иначе человек, у которого уже есть данные,
 * видел бы мигание на каждом возврате. В результате обновление происходило
 * совершенно незаметно: экран не менялся никак, и понять, «оно вообще живое или
 * нет», было нельзя. Этот индикатор возвращает обратную связь, ничего не двигая.
 *
 * ── Почему с задержкой ─────────────────────────────────────────────────────
 *
 * Быстрый ответ (обычные 50–150 мс) вообще не должен рисовать индикатор: вспышка
 * на пол-кадра читается как дефект отрисовки, а не как «идёт загрузка». Поэтому
 * спиннер появляется, только если запрос длится дольше DELAY_MS.
 */

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/** Сколько запрос обязан длиться, чтобы индикатор вообще появился. */
const INDICATOR_DELAY_MS = 350;

/**
 * Задерживает появление флага.
 *
 * Возвращает true, если `active` держится дольше `delayMs`. Как только `active`
 * падает, флаг гаснет немедленно — исчезать индикатор должен без задержки,
 * иначе он «догоняет» уже показанные данные.
 */
export function useDelayedFlag(active: boolean, delayMs = INDICATOR_DELAY_MS): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);

  return visible;
}

/**
 * Крутящийся индикатор для правого слота шапки.
 *
 * Без текста намеренно: это та же роль, что у спиннера в навбаре iOS, он узнаётся
 * без подписи и не отъедает ширину у заголовка вкладки. Для скринридера рядом
 * живёт текстовое состояние.
 */
export function RefreshIndicator({ active }: { active: boolean }) {
  const visible = useDelayedFlag(active);

  return (
    <>
      {visible ? (
        <span
          className="animate-fade flex h-7 w-7 items-center justify-center"
          style={{ color: 'var(--accent)' }}
        >
          <LoaderCircle size={18} className="spinner" aria-hidden />
        </span>
      ) : null}

      <span className="sr-only" role="status" aria-live="polite">
        {visible ? 'Обновление данных' : ''}
      </span>
    </>
  );
}
