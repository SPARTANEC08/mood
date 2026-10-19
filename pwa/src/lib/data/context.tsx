/**
 * DataProvider — владелец состояния общего кэша приложения и публичный хук
 * useAppData. Операции первого и второго уровня живут в data/tier1.ts и
 * data/tier2.ts; здесь — состояние, его рефы, эффекты и композиция экшенов.
 *
 * Публичный API (`DataProvider`, `useAppData`, форма AppData) не менялся, кроме
 * `refresh`: теперь он возвращает текст ошибки, чтобы экран мог показать тост.
 *
 * Фоновое обновление (visibilitychange) НИКОГДА не ставит loading: человек, уже
 * видевший данные, не должен снова получить скелетоны.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { TabId } from '@/components/TabBar';
import { getPwaTokenUserId } from '@/auth';
import { clearPreviewUrlCache } from '@/lib/api/files';
import { clearFileCache } from '@/lib/fileCache';
import { perfLog } from '@/lib/perf';
import type {
  ApiHomework,
  ApiImportant,
  AttendanceResponse,
  BarsMoreResponse,
  BootstrapProfile,
  GradesResponse,
  MailResponse,
  ScheduleResponse,
} from '@/types/api';
import {
  CACHE_KEYS,
  clearPreviewCache,
  loadTier1 as loadTier1Impl,
  persistCore as persistCoreImpl,
  readJson,
  readPersisted,
  refreshSchedule,
  reloadLists as reloadListsImpl,
  todayMoscow,
  VISIBILITY_THROTTLE_MS,
  writeJson,
  type PersistedCore,
  type Tier1Core,
} from './tier1';
import {
  loadTab as loadTabImpl,
  loadTier2 as loadTier2Impl,
  refreshBars as refreshBarsImpl,
  refreshMailOnly,
  TIER2_TTL_MS,
} from './tier2';

interface AppData {
  /**
   * Идентификатор человека. Доступен сразу из localStorage-кэша профиля, ещё до
   * ответа bootstrap, — по нему страницы читают свой локальный кэш (например,
   * выбранный день расписания).
   */
  userId: string;
  schedule: ScheduleResponse | null;
  homework: ApiHomework[];
  important: ApiImportant[];
  /** Оценки текущего семестра. */
  grades: GradesResponse | null;
  /** Пропуски. */
  attendance: AttendanceResponse | null;
  /** Рейтинг, задолженности, стипендия, приказы, библиотека. */
  barsMore: BarsMoreResponse | null;
  /** Письма ОСЭП. */
  mail: MailResponse | null;
  mailError: string | null;
  /** true, пока идёт первичная загрузка Tier 1. */
  loading: boolean;
  /** true, пока идёт обновление Tier 1. */
  refreshing: boolean;
  /** true, пока грузится Tier 2 (отдельный скелетон на своей вкладке). */
  barsLoading: boolean;
  /**
   * true, пока идёт ЛЮБАЯ загрузка Tier 2 — включая фоновую по возврату в
   * приложение. Именно это читает индикатор в шапке вкладки: скелетон
   * (barsLoading) показывает только первую загрузку, а обновление данных
   * происходит и молча.
   */
  barsRefreshing: boolean;
  /** Ошибка расписания — фатальная: без него приложение пустое. */
  error: string | null;
  /** Ошибка разделов БАРС — мягкая: вкладка показывает пустое состояние. */
  barsError: string | null;
  /**
   * Принудительное обновление расписания и списков [pull-to-refresh].
   *
   * Возвращает текст ошибки или null при успехе: экран сам решает, показывать
   * ли тост, чтобы не убирать уже нарисованную ленту.
   */
  refresh: () => Promise<string | null>;
  /**
   * Принудительное обновление снимка БАРС [pull-to-refresh на «Успеваемости» и
   * в «Кабинете»]. Идёт в МЭИ мимо TTL и возвращает текст ошибки или null.
   */
  refreshBars: () => Promise<string | null>;
  /** Перечитывает превью почты ОСЭП (без похода в IMAP на клиенте). */
  refreshMail: () => Promise<string | null>;
  loadTab: (tab: TabId) => void;
  /**
   * Перезапрашивает списки ДЗ и «Важного» [pull-to-refresh на «Заданиях»].
   * Возвращает текст ошибки или null.
   */
  reloadLists: () => Promise<string | null>;
}

const DataContext = createContext<AppData | null>(null);

export function DataProvider({
  bootstrap,
  children,
}: {
  /**
   * Профиль из bootstrap. Читается для двух вещей: проверки, что кэш в
   * localStorage принадлежит именно этому человеку, и сохранения профиля рядом
   * с данными (по нему на следующем запуске читается userId).
   */
  bootstrap: { profile: BootstrapProfile };
  children: ReactNode;
}) {
  /**
   * Восстановленный кэш читается ОДИН раз, до первого рендера.
   *
   * Инициализатор useState — единственное место, где чтение localStorage
   * синхронно: любое чтение в useEffect случилось бы уже после отрисовки, и
   * человек увидел бы скелетоны вместо своего расписания.
   */
  const [restored] = useState<{ userId: string; core: PersistedCore } | null>(() => {
    const startedAt = Date.now();
    const activeUserId = getPwaTokenUserId();
    const profile = readJson<BootstrapProfile>(CACHE_KEYS.profile);
    if (!activeUserId || !profile?.userId || profile.userId !== activeUserId) {
      perfLog('cache-read miss', Date.now() - startedAt);
      return null;
    }

    const core = readPersisted(profile.userId);
    perfLog('cache-read', Date.now() - startedAt);
    return core ? { userId: profile.userId, core } : null;
  });

  const [schedule, setSchedule] = useState<ScheduleResponse | null>(restored?.core.schedule ?? null);
  const [homework, setHomework] = useState<ApiHomework[]>(restored?.core.homework ?? []);
  const [important, setImportant] = useState<ApiImportant[]>(restored?.core.important ?? []);
  const [barsMore, setBarsMore] = useState<BarsMoreResponse | null>(null);
  const [grades, setGrades] = useState<GradesResponse | null>(null);
  const [attendance, setAttendance] = useState<AttendanceResponse | null>(null);
  const [mail, setMail] = useState<MailResponse | null>(null);
  const [mailError, setMailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(restored?.core.schedule == null);
  const [refreshing, setRefreshing] = useState(false);
  const [barsLoading, setBarsLoading] = useState(false);
  /** Сколько загрузок Tier 2 идёт прямо сейчас (см. barsRefreshing в AppData). */
  const [barsBusy, setBarsBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [barsError, setBarsError] = useState<string | null>(null);

  /** userId, под которым лежит кэш: нужен для записи в те же ключи. */
  const cacheUserId = useRef(restored?.userId ?? '');
  /**
   * Последние известные данные первого уровня.
   *
   * Нужны, чтобы функции загрузки не зависели от значений state: иначе
   * useCallback пересоздавал бы их на каждое изменение данных, а вместе с ними
   * переподписывался бы слушатель возврата к приложению.
   */
  const coreRef = useRef<Tier1Core>({
    schedule: restored?.core.schedule ?? null,
    homework: restored?.core.homework ?? [],
    important: restored?.core.important ?? [],
  });
  /** Момент последнего успешного обновления Tier 1. */
  const tier1At = useRef(restored?.core.savedAt ?? 0);
  /** Московская дата на момент последнего обновления: смена дня = новый день. */
  const dayAt = useRef<string>(todayMoscow());
  /** Вкладка, на которой человек находится сейчас: для фонового Tier 2. */
  const activeTab = useRef<TabId>('schedule');
  /** Когда каждая вкладка обновлялась последний раз (0 = ни разу). */
  const tier2At = useRef<Partial<Record<TabId, number>>>({});

  // Наборы рефов/сеттеров собираются ОДИН раз на рендер и переиспользуются во
  // всех колбэках. Ссылки (useRef) и сеттеры (useState) стабильны, поэтому
  // колбэки с пустым списком зависимостей захватывают корректные объекты, а
  // дублирующихся литералов в бандле не остаётся.
  const t1Refs = { coreRef, tier1At, dayAt };
  const t1Setters = { setSchedule, setHomework, setImportant, setLoading, setRefreshing, setError };
  const t2Refs = { tier2At };
  const t2GateRefs = { tier2At, activeTab };
  const t2Setters = {
    setGrades,
    setAttendance,
    setBarsMore,
    setMail,
    setMailError,
    setBarsLoading,
    setBarsBusy,
    setBarsError,
  };

  /** Записывает расписание и списки в localStorage. */
  const persistCore = useCallback(() => persistCoreImpl(cacheUserId.current, coreRef), []);

  const loadTier1 = useCallback(
    (opts: { silent: boolean; forceSchedule?: boolean }) =>
      loadTier1Impl(opts, t1Refs, t1Setters, persistCore),
    [],
  );

  const reloadLists = useCallback(
    () => reloadListsImpl(coreRef, { setHomework, setImportant }),
    [],
  );

  const loadTier2 = useCallback(
    (tab: 'grades' | 'profile', opts: { background?: boolean } = {}) =>
      loadTier2Impl(tab, opts, t2Refs, t2Setters),
    [],
  );

  const loadTab = useCallback((tab: TabId) => loadTabImpl(tab, t2GateRefs, t2Setters), []);

  const refreshBars = useCallback(() => refreshBarsImpl(t2Refs, t2Setters), []);

  const refreshMail = useCallback(() => refreshMailOnly(t2Setters), []);

  const refresh = useCallback(
    () =>
      refreshSchedule(
        t1Refs,
        { setRefreshing, setError, setSchedule },
        reloadLists,
        persistCore,
      ),
    [reloadLists, persistCore],
  );

  // Первичная загрузка — один раз на открытие приложения.
  useEffect(() => {
    void loadTier1({ silent: false });
  }, [loadTier1]);

  /**
   * Профиль и кэш.
   *
   * Пока bootstrap не пришёл, профиль неизвестен, и восстановленный кэш мог
   * принадлежать другому человеку на этом же устройстве. Как только известен
   * настоящий userId, несовпадение обнаруживается и кэш выбрасывается.
   */
  useEffect(() => {
    const profile = bootstrap.profile;
    if (!profile.userId) return;

    writeJson(CACHE_KEYS.profile, profile);

    const known = cacheUserId.current;
    // Усыновляем userId: теперь persistCore пишет в его ключи, даже если он
    // пришёл позже первой загрузки.
    cacheUserId.current = profile.userId;

    if (known === profile.userId) return;

    /*
     * Профиль ещё не был известен (первый вход или чистое хранилище). Загрузка
     * Tier 1 могла успеть записать расписание под ПУСТЫМ ключом (
     * `mood_cache_schedule:`), потому что userId пришёл только сейчас. Это и
     * делало второе открытие медленным: профиль в localStorage находился, а
     * расписания под настоящим userId не было — и приложение снова ждало сеть.
     * Перезаписываем только что загруженный кэш под настоящим ключом.
     */
    if (!known) {
      persistCore();
      return;
    }

    // Кэш принадлежит другому человеку: забываем его и грузим заново. Файлы и
    // превью тоже: в них видно содержимое чужого задания.
    clearFileCache();
    clearPreviewCache();
    clearPreviewUrlCache();
    coreRef.current = { schedule: null, homework: [], important: [] };
    setSchedule(null);
    setHomework([]);
    setImportant([]);
    setLoading(true);
    void loadTier1({ silent: false });
  }, [bootstrap.profile, loadTier1, persistCore]);

  /**
   * Возврат к приложению после сворачивания.
   *
   * Обновление тихое: скелетонов после первого кадра не бывает, человек видит
   * прежние данные, пока не придут новые. Смена московского дня форсит
   * перезапрос расписания даже внутри throttle.
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      const dayChanged = todayMoscow() !== dayAt.current;

      if (dayChanged || now - tier1At.current > VISIBILITY_THROTTLE_MS) {
        void loadTier1({ silent: true, forceSchedule: dayChanged });
      }

      const tab = activeTab.current;
      if (tab !== 'grades' && tab !== 'profile') return;

      const last = tier2At.current[tab] ?? 0;
      // Возврат к приложению — background: без скелетонов и спиннеров.
      if (!last || now - last > TIER2_TTL_MS) void loadTier2(tab, { background: true });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadTier1, loadTier2]);

  const value = useMemo<AppData>(
    () => ({
      userId: bootstrap.profile.userId || restored?.userId || '',
      schedule,
      homework,
      important,
      grades,
      attendance,
      barsMore,
      mail,
      mailError,
      loading,
      refreshing,
      barsLoading,
      barsRefreshing: barsBusy > 0,
      error,
      barsError,
      refresh,
      refreshBars,
      refreshMail,
      loadTab,
      reloadLists,
    }),
    [
      bootstrap.profile.userId,
      restored?.userId,
      schedule,
      homework,
      important,
      grades,
      attendance,
      barsMore,
      mail,
      mailError,
      loading,
      refreshing,
      barsLoading,
      barsBusy,
      error,
      barsError,
      refresh,
      refreshBars,
      refreshMail,
      loadTab,
      reloadLists,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/** Доступ к общему кэшу. Бросает ошибку, если вызван вне провайдера. */
export function useAppData(): AppData {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useAppData() вызван вне DataProvider');
  }
  return ctx;
}
