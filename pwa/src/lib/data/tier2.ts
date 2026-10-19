/**
 * Tier 2 — ленивый путь: оценки, пропуски, снимок БАРС и почта.
 *
 * Данные запрашиваются только когда человек открыл соответствующую вкладку.
 * TTL (20 мин) и throttle фонового обновления (15 мин, в tier1) не менялись.
 * Состояние держит провайдер (data/context.tsx), здесь — операции.
 *
 * Фоновое обновление никогда не поднимает barsLoading: скелетон зарезервирован
 * под действие пользователя. «Что-то грузится» показывает счётчик barsBusy —
 * его читает индикатор в шапке вкладки, и он честно горит и на фоновом проходе.
 */

import type { Dispatch, SetStateAction } from 'react';

import type { TabId } from '@/components/TabBar';
import { ApiError, api } from '@/lib/api';
import type {
  AttendanceResponse,
  BarsMoreResponse,
  GradesResponse,
  MailResponse,
} from '@/types/api';

/**
 * Через сколько минут вкладка перестаёт считаться «свежей».
 *
 * Ровно TTL снимка на сервере: если локальный throttle короче, приложение будет
 * регулярно упираться в «снимок всё ещё тот же» и нагружать сеть вхолостую.
 */
export const TIER2_TTL_MS = 20 * 60 * 1000;

export interface Tier2Refs {
  tier2At: { current: Partial<Record<TabId, number>> };
}

export interface Tier2Setters {
  setGrades: Dispatch<SetStateAction<GradesResponse | null>>;
  setAttendance: Dispatch<SetStateAction<AttendanceResponse | null>>;
  setBarsMore: Dispatch<SetStateAction<BarsMoreResponse | null>>;
  setMail: Dispatch<SetStateAction<MailResponse | null>>;
  setMailError: Dispatch<SetStateAction<string | null>>;
  setBarsLoading: Dispatch<SetStateAction<boolean>>;
  /**
   * Счётчик идущих загрузок Tier 2 (не флаг!).
   *
   * Фоновый проход может наложиться на заход по TTL, и одиночный флаг погас бы
   * вместе с первым завершившимся запросом, хотя второй ещё в пути. Счётчик
   * честно держит индикатор в шапке, пока не завершится последний.
   */
  setBarsBusy: Dispatch<SetStateAction<number>>;
  setBarsError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Tier 2: разделы БАРС и почта для конкретной вкладки.
 *
 * Запросы зависят от вкладки: «Успеваемость» не интересует почта, а «Кабинету»
 * не нужны оценки и пропуски.
 */
export async function loadTier2(
  tab: 'grades' | 'profile',
  opts: { background?: boolean },
  refs: Tier2Refs,
  setters: Tier2Setters,
): Promise<void> {
  const background = opts.background === true;

  setters.setBarsBusy((n) => n + 1);

  // Скелетон зарезервирован под действие пользователя: фон НИКОГДА не ставит
  // loading. Человек, уже видевший данные, не должен получить скелетон.
  if (!background) setters.setBarsLoading(true);

  try {
    const [gradesRes, attendanceRes, moreRes, mailRes] = await Promise.allSettled([
      tab === 'grades' ? api.grades() : Promise.resolve(null),
      tab === 'grades' ? api.attendance() : Promise.resolve(null),
      api.barsMore(),
      tab === 'profile' ? api.mail() : Promise.resolve(null),
    ]);

    let barsFailed = false;

    if (gradesRes.status === 'fulfilled' && gradesRes.value) setters.setGrades(gradesRes.value);
    else if (gradesRes.status === 'rejected') barsFailed = true;

    if (attendanceRes.status === 'fulfilled' && attendanceRes.value) setters.setAttendance(attendanceRes.value);
    else if (attendanceRes.status === 'rejected') barsFailed = true;

    if (moreRes.status === 'fulfilled') setters.setBarsMore(moreRes.value);
    else barsFailed = true;

    if (mailRes.status === 'fulfilled' && mailRes.value) {
      setters.setMail(mailRes.value);
      setters.setMailError(null);
    } else if (mailRes.status === 'rejected') {
      // Почта часто отвечает «слишком часто» — это не отказ разделов БАРС.
      setters.setMailError(
        mailRes.reason instanceof ApiError ? mailRes.reason.message : 'Почта недоступна.',
      );
    }

    if (barsFailed) {
      const reason =
        moreRes.status === 'rejected'
          ? moreRes.reason
          : gradesRes.status === 'rejected'
            ? gradesRes.reason
            : attendanceRes.status === 'rejected'
              ? attendanceRes.reason
              : new Error('Неизвестная ошибка БАРС.');
      setters.setBarsError(
        reason instanceof ApiError ? reason.message : 'Личный кабинет БАРС временно недоступен.',
      );
    } else {
      setters.setBarsError(null);
    }

    refs.tier2At.current[tab] = Date.now();
  } finally {
    // Снимаем ровно свой счёт и свой скелетон: параллельный проход снимет свои.
    if (!background) setters.setBarsLoading(false);
    setters.setBarsBusy((n) => Math.max(0, n - 1));
  }
}

/**
 * Заявка вкладки на Tier 2. Повторный заход не перезапрашивает, пока не истёк
 * TIER2_TTL_MS, поэтому листание туда-сюда не ходит в сеть.
 *
 * Почта — исключение: её превью читается из памяти сервера (его держит
 * нотификатор), поэтому дешёвое и обновляется при КАЖДОМ заходе на «Кабинет».
 * Так новые письма (и пуш о них) совпадают с тем, что видно в интерфейсе, без
 * похода в IMAP и без кнопки «обновить».
 */
export function loadTab(
  tab: TabId,
  refs: Tier2Refs & { activeTab: { current: TabId } },
  setters: Tier2Setters,
): void {
  refs.activeTab.current = tab;
  if (tab !== 'grades' && tab !== 'profile') return;

  if (tab === 'profile') void refreshMailOnly(setters);

  const last = refs.tier2At.current[tab] ?? 0;
  if (last && Date.now() - last < TIER2_TTL_MS) return;

  // Заход пользователя на вкладку — foreground: скелетон уместен.
  void loadTier2(tab, { background: false }, refs, setters);
}

/**
 * Читает превью почты (без IMAP) и кладёт в состояние. Фоном, без скелетонов.
 *
 * Счётчик barsBusy здесь НЕ трогается намеренно: почта перечитывается при
 * каждом заходе на «Кабинет», и индикатор в шапке превратился бы в постоянный
 * мигающий элемент, который ничего не сообщает. Для ручного обновления (жест
 * вниз) спиннер рисует сам pull-to-refresh.
 */
export async function refreshMailOnly(
  setters: Pick<Tier2Setters, 'setMail' | 'setMailError'>,
): Promise<string | null> {
  try {
    const fresh = await api.mail();
    setters.setMail(fresh);
    setters.setMailError(null);
    return null;
  } catch (err: unknown) {
    const message = err instanceof ApiError ? err.message : 'Почта недоступна.';
    setters.setMailError(message);
    return message;
  }
}

/**
 * Принудительное обновление снимка БАРС (оценки, пропуски, рейтинг).
 *
 * Работает по жесту «потянуть вниз» на «Успеваемости» и в «Кабинете»: без
 * force сервер отдал бы снимок двадцатиминутной давности, и жест «обновил» бы
 * экран теми же данными. Один запрос вместо трёх — сервер собирает снимок
 * целиком. Почту отсюда игнорируем намеренно: у неё собственный кулдаун, а
 * «Кабинет» дозапрашивает её отдельно (refreshMailOnly).
 *
 * Списки ДЗ и «Важного» здесь НЕ перезапрашиваются: ни один из этих экранов их
 * не показывает, а жест на каждой вкладке не должен стоить лишнего похода в
 * JSON-сторы (раньше это были два запроса из трёх на «Успеваемости»).
 *
 * Возвращает текст ошибки или null: экран сам решает, показать ли тост.
 */
export async function refreshBars(
  refs: Tier2Refs,
  setters: Tier2Setters,
): Promise<string | null> {
  setters.setBarsBusy((n) => n + 1);
  setters.setBarsError(null);

  let message: string | null = null;

  try {
    const snapshot = await api.barsRefresh();

    setters.setGrades(snapshot.grades);
    setters.setAttendance(snapshot.attendance);
    setters.setBarsMore(snapshot.more);
    // Почту здесь НЕ трогаем: она приходит только из превью нотификатора
    // (GET /api/mail), а принудительное обновление БАРС не должно её дёргать.

    refs.tier2At.current.grades = Date.now();
    refs.tier2At.current.profile = Date.now();
  } catch (err: unknown) {
    message = err instanceof ApiError ? err.message : 'Не удалось обновить данные БАРС.';
    setters.setBarsError(message);
  } finally {
    setters.setBarsLoading(false);
    setters.setBarsBusy((n) => Math.max(0, n - 1));
  }

  return message;
}
