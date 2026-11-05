/**
 * Тема оформления: тёмная, светлая и системная.
 *
 * Единственный источник правды о теме. Результат всегда сводится к атрибуту
 * `data-theme` («dark» или «light») на <html> — токены цвета живут в index.css,
 * а не в компонентах. Режим «system» лишь решает, какую из двух тем взять,
 * в зависимости от системной схемы устройства.
 *
 * До первого рендера то же самое делает ранний скрипт `public/theme-init.js`
 * (инлайн-скрипт запрещён CSP продакшена), поэтому вспышки темы нет. Здесь —
 * та же логика для рантайма: переключение, подписка на систему и хук.
 *
 * Производительность: режим читается из localStorage РОВНО ОДИН РАЗ при загрузке
 * модуля и дальше живёт в памяти (`currentMode`). На каждый рендер localStorage
 * не трогается — ни через getSnapshot, ни где-либо ещё: синхронный доступ к
 * storage в рендере блокировал бы поток и давал бы разные значения между вызовами.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { applyAccent } from './accent';

export type ThemeMode = 'dark' | 'light' | 'system';

/** Ключ выбора пользователя в localStorage. */
export const THEME_STORAGE_KEY = 'mood_theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Тема по умолчанию, когда в localStorage ничего нет. Именно тёмная: она
 * основная для приложения, и её же берёт ранний скрипт до первого кадра.
 */
const DEFAULT_MODE: ThemeMode = 'dark';

/** Цвет адресной строки/статус-бара. Должен совпадать с --app-bg каждой темы. */
const THEME_COLOR: Record<'dark' | 'light', string> = {
  dark: '#15131e',
  light: '#f4f2fb',
};

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

/** Однократное чтение выбора из storage. Дальше значение держим в памяти. */
function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return DEFAULT_MODE;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

// Кэш текущего режима. Обращения к localStorage происходят только здесь и в
// setThemeMode — не в рендере.
let currentMode: ThemeMode = readStoredMode();

const listeners = new Set<() => void>();

function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

/** Какую тему рисовать для данного режима (для «system» — по системе). */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Приводит документ к выбранному режиму. Идемпотентно. */
function applyToDocument(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;

  const theme = resolveTheme(mode);
  const root = document.documentElement;

  root.setAttribute('data-theme', theme);
  // Отдельный атрибут режима — переключателю он не нужен, но полезен для
  // отладки и для CSS-правил, которым важно «выбрана системная», а не итог.
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = theme;

  // Производные токены акцента зависят от темы: пересчитываем их здесь, а не
  // в компонентах. Без этого пользовательский цвет остался бы с коррекцией
  // для прежней темы и мог потерять контраст.
  applyAccent(theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Текущий режим из памяти (не читает storage). */
export function getThemeMode(): ThemeMode {
  return currentMode;
}

/**
 * Инициализация из рантайма. Дублирует theme-init.js, но идемпотентно:
 * гарантирует согласованность, если скрипт не отработал (например, стоят
 * старые кэши или он заблокирован).
 */
export function initTheme(): void {
  applyToDocument(currentMode);
}

/** Устанавливает и сохраняет режим, немедленно применяя его к документу. */
export function setThemeMode(mode: ThemeMode): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Приватный режим: выбор не переживёт перезагрузку, но применится сейчас.
    }
  }

  currentMode = mode;
  applyToDocument(mode);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Синхронизация между вкладками: если тему сменили в другой вкладке, storage
// бросит событие — обновляем кэш и DOM без чтения storage в рендере.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    currentMode = readStoredMode();
    applyToDocument(currentMode);
    emit();
  });
}

/**
 * Хук темы: текущий режим и переключатель.
 *
 * Подписка на смену системной схемы живёт в эффекте и снимается при
 * размонтировании, поэтому слушатель не накапливается при перемонтировании
 * переключателя. Реагируем только в режиме «Системная»: при явном выборе
 * система не должна незаметно перебивать решение пользователя.
 *
 * Компонент-потребитель тут один — переключатель в «Кабинете», — поэтому
 * ререндер при смене темы касается только его. Никакого React-контекста на
 * каждый компонент: цвет приложения меняет сам CSS через data-theme.
 */
export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribe, getThemeMode, () => DEFAULT_MODE);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      if (currentMode === 'system') applyToDocument('system');
    };

    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setMode = useCallback((next: ThemeMode) => setThemeMode(next), []);

  return [mode, setMode];
}
