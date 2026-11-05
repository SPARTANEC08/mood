/**
 * Тема оформления: режим (светлая/тёмная/системная) и выбранная палитра.
 *
 * Единственный источник правды. Результат всегда сводится к атрибуту
 * `data-theme` («dark» или «light») и набору CSS-переменных на <html>.
 * Палитра приходит из `lib/themes.ts` / `lib/themeColors.ts`, поэтому цвета
 * не размазаны по компонентам.
 *
 * До первого рендера то же самое делает внешний `public/theme-init.js`
 * (инлайн-скрипт запрещён CSP продакшена). Он читает уже вычисленные токены из
 * localStorage, поэтому формулы цвета здесь и там не дублируются.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  applyThemeTokens,
  clearThemeTokens,
  readSelectedTheme,
  themeAuthAllowed,
  writeSelectedTheme,
  writeStoredTokens,
} from './themes';
import {
  availableThemeModes,
  deriveAllTokens,
  resolveVariantKey,
  themeModeAvailable,
  type ThemeDefinition,
  type ThemeVariantKey,
} from './themeColors';
import { defaultOfficialTheme } from './officialThemes';

export type ThemeMode = 'dark' | 'light' | 'system';

/** Ключ выбора пользователя в localStorage. */
export const THEME_STORAGE_KEY = 'mood_theme';

/** Ключи авторизации: ранний скрипт и этот модуль должны понимать одно и то же. */
const TOKEN_KEY = 'mood_pwa_token';
const GUEST_KEY = 'mood_guest_mode';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Тема по умолчанию, когда в localStorage ничего нет: тёмная. */
const DEFAULT_MODE: ThemeMode = 'dark';

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return DEFAULT_MODE;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

let currentMode: ThemeMode = readStoredMode();
let currentTheme: ThemeDefinition = readSelectedTheme();

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

/** Фактический вариант выбранной темы: у одноvariant-темы он принудительный. */
export function effectiveVariant(): ThemeVariantKey {
  return resolveVariantKey(currentTheme, currentMode, prefersDark());
}

/**
 * Приводит документ к выбранному режиму и палитре. Идемпотентно.
 *
 * На экране входа, в 2FA и у гостя кастомные токены не выставляются: остаётся
 * фирменная фиолетовая палитра из index.css.
 */
function applyToDocument(): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const authorized = themeAuthAllowed();

  if (!authorized) {
    const base = resolveTheme(currentMode);
    root.setAttribute('data-theme', base);
    root.setAttribute('data-theme-mode', currentMode);
    root.removeAttribute('data-theme-id');
    root.style.colorScheme = base;
    clearThemeTokens();
    return;
  }

  const variant = effectiveVariant();
  root.setAttribute('data-theme', variant);
  root.setAttribute('data-theme-mode', currentMode);
  root.setAttribute('data-theme-id', currentTheme.id);
  root.style.colorScheme = variant;

  const tokens = deriveAllTokens(currentTheme);
  const active = tokens[variant] ?? tokens.dark ?? tokens.light;
  if (!active) {
    clearThemeTokens();
    return;
  }

  // Ранний скрипт следующей загрузки возьмёт готовые токены и не будет
  // пересчитывать цвета заново.
  applyThemeTokens(active);
  writeStoredTokens(tokens);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Текущий режим из памяти (не читает storage). */
export function getThemeMode(): ThemeMode {
  return currentMode;
}

/** Текущая тема из памяти. */
export function getSelectedTheme(): ThemeDefinition {
  return currentTheme;
}

/** Инициализация из рантайма: дублирует theme-init.js, но идемпотентно. */
export function initTheme(): void {
  applyToDocument();
}

/** Устанавливает и сохраняет режим, немедленно применяя его к документу. */
export function setThemeMode(mode: ThemeMode): void {
  if (!themeModeAvailable(currentTheme, mode)) return;

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Приватный режим: выбор не переживёт перезагрузку, но применится сейчас.
    }
  }

  currentMode = mode;
  applyToDocument();
  emit();
}

/** Применяет и сохраняет тему. */
export function setTheme(theme: ThemeDefinition): void {
  currentTheme = theme;
  writeSelectedTheme(theme);
  applyToDocument();
  emit();
}

/** Возвращает официальную тему по умолчанию. */
export function resetTheme(): void {
  setTheme(defaultOfficialTheme());
}

/**
 * Согласует тему с текущим входом.
 *
 * Зовётся после входа/выхода, смены гостевого режима и из ранней инициализации:
 * один вход — одна тема, без «протёкшего» цвета с прошлого аккаунта.
 */
export function syncThemeWithAuth(): void {
  applyToDocument();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Синхронизация между вкладками.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      currentMode = readStoredMode();
      applyToDocument();
      emit();
      return;
    }

    if (event.key === 'mood_theme_selected') {
      currentTheme = readSelectedTheme();
      applyToDocument();
      emit();
      return;
    }

    if (event.key === TOKEN_KEY || event.key === GUEST_KEY) {
      applyToDocument();
      emit();
    }
  });
}

/**
 * Хук режима: текущий режим и переключатель.
 *
 * Подписчиков мало (карточка настроек), поэтому ререндер касается только её —
 * остальной интерфейс перекрашивает CSS.
 */
export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribe, getThemeMode, () => DEFAULT_MODE);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      // В режиме «Системная» пересчитываем вариант; у одноvariant-темы
      // фактический вариант всё равно принудительный, поэтому лишнего нет.
      applyToDocument();
      emit();
    };

    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setMode = useCallback((next: ThemeMode) => setThemeMode(next), []);

  return [mode, setMode];
}

/** Хук выбранной палитры. */
export function useThemePreset(): {
  theme: ThemeDefinition;
  applyTheme: (theme: ThemeDefinition) => void;
  resetTheme: () => void;
  availableModes: Array<'system' | ThemeVariantKey>;
  effective: ThemeVariantKey;
} {
  const theme = useSyncExternalStore(subscribe, getSelectedTheme, defaultOfficialTheme);
  const apply = useCallback((next: ThemeDefinition) => setTheme(next), []);
  const reset = useCallback(() => resetTheme(), []);

  return {
    theme,
    applyTheme: apply,
    resetTheme: reset,
    availableModes: availableThemeModes(theme),
    effective: resolveVariantKey(theme, currentMode, prefersDark()),
  };
}
