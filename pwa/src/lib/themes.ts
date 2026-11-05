/**
 * Хранение выбранной темы и применение её токенов к документу.
 *
 * Состояние режима (`mood_theme`) живёт в `lib/theme.ts`; здесь — только
 * выбранная тема, кэш тем сообщества и низкоуровневая запись CSS-переменных.
 *
 * Токены для обоих вариантов сохраняются в localStorage заранее. Благодаря
 * этому `public/theme-init.js` применяет тему до первого кадра, не повторяя
 * формулы `deriveThemeTokens`: ранний скрипт читает готовый набор значений.
 */

import {
  DEFAULT_ACCENT_HEX,
  normalizeHex,
  rgbToHsl,
  sanitizeVariants,
  type ThemeDefinition,
  type ThemeTokens,
  type ThemeVariants,
} from './themeColors.ts';
import { defaultOfficialTheme, getOfficialTheme } from './officialThemes.ts';

/** Режим: как и раньше, отдельный ключ. */
export const THEME_STORAGE_KEY = 'mood_theme';
/** Выбранная тема целиком — чтобы ранний скрипт и офлайн знали, что рисовать. */
export const SELECTED_THEME_KEY = 'mood_theme_selected';
/** Заранее вычисленные токены для доступных вариантов. */
export const THEME_TOKENS_KEY = 'mood_theme_tokens';
/** Кэш пользовательских тем сообщества. */
export const THEMES_CACHE_KEY = 'mood_themes_cache';
/** Старый ключ акцента: нужен только для миграции. */
export const LEGACY_ACCENT_KEY = 'mood_accent';

/** Ключи входа: дублируются строкой, чтобы не замыкать цикл с auth.ts. */
const TOKEN_KEY = 'mood_pwa_token';
const GUEST_KEY = 'mood_guest_mode';

const NAME_MAX = 24;

/** Соответствие полей токенов и CSS-переменных. */
export const TOKEN_CSS_VARS: Array<[keyof ThemeTokens, string]> = [
  ['appBg', '--app-bg'],
  ['surface', '--surface'],
  ['surfaceGrouped', '--surface-grouped'],
  ['surfaceBlur', '--surface-blur'],
  ['textPrimary', '--text-primary'],
  ['textSecondary', '--text-secondary'],
  ['textTertiary', '--text-tertiary'],
  ['separator', '--separator'],
  ['separatorSoft', '--separator-soft'],
  ['accent', '--accent'],
  ['accentSoft', '--accent-soft'],
  ['accentText', '--accent-text'],
  ['accentFade1', '--accent-fade-1'],
  ['accentFade2', '--accent-fade-2'],
  ['accentFade3', '--accent-fade-3'],
  ['shadowCard', '--shadow-card'],
];

/* ── минимальные браузерные типы ──────────────────────────────────────────── */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StyleLike {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

interface DocumentLike {
  documentElement: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    style: StyleLike;
  };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

function storage(): StorageLike | null {
  return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
}

function browserDocument(): DocumentLike | null {
  return (globalThis as { document?: DocumentLike }).document ?? null;
}

/** Темы живут только в авторизованном приложении, не у гостя и не на входе. */
export function themeAuthAllowed(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (!store.getItem(TOKEN_KEY)) return false;
    return store.getItem(GUEST_KEY) !== '1';
  } catch {
    return false;
  }
}

/* ── выбранная тема ───────────────────────────────────────────────────────── */

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length > 0 && name.length <= NAME_MAX ? name : null;
}

/**
 * Приводит тему из localStorage/API к безопасному виду.
 *
 * Официальная тема всегда берётся из кода по id: если владелец поправил её
 * оттенки в новой версии, старый кэш не перебьёт свежий вид.
 */
export function sanitizeTheme(value: unknown): ThemeDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!id) return null;

  const official = getOfficialTheme(id);
  if (official) return official;

  const name = sanitizeName(source.name);
  const variants = sanitizeVariants(source.variants);
  if (!name || (!variants.light && !variants.dark)) return null;

  return {
    id,
    name,
    variants,
    official: false,
    mine: source.mine === true,
    local: source.local === true,
    ...(typeof source.createdAt === 'string' ? { createdAt: source.createdAt } : {}),
  };
}

/**
 * Старый персональный акцент → локальная тема.
 *
 * Пользователь мог годами ходить со своим HEX. Просто выбросить его при
 * обновлении — регрессия, поэтому переносим оттенок в тему «Мой акцент».
 */
function migrateLegacyAccent(store: StorageLike): ThemeDefinition {
  let raw: string | null = null;
  try {
    raw = store.getItem(LEGACY_ACCENT_KEY);
  } catch {
    raw = null;
  }

  const legacy = raw ? normalizeHex(raw) : null;
  const fallback = defaultOfficialTheme();

  if (!legacy || legacy === DEFAULT_ACCENT_HEX) {
    try {
      store.removeItem(LEGACY_ACCENT_KEY);
    } catch {
      // storage может быть недоступен — не критично.
    }
    return fallback;
  }

  const rgb = { r: parseInt(legacy.slice(1, 3), 16), g: parseInt(legacy.slice(3, 5), 16), b: parseInt(legacy.slice(5, 7), 16) };
  const hue = Math.round(rgbToHsl(rgb).h) % 360;
  const variants: ThemeVariants = {
    light: { backgroundHue: 255, surfaceHue: 255, accentHue: hue },
    dark: { backgroundHue: 255, surfaceHue: 255, accentHue: hue },
  };

  const theme: ThemeDefinition = {
    id: 'local-accent',
    name: 'Мой акцент',
    variants,
    official: false,
    local: true,
  };

  try {
    store.setItem(SELECTED_THEME_KEY, JSON.stringify(theme));
    store.removeItem(LEGACY_ACCENT_KEY);
  } catch {
    // Приватный режим: тема применится сейчас, но не переживёт перезагрузку.
  }

  return theme;
}

/** Выбранная тема или дефолтная официальная. Никогда не возвращает null. */
export function readSelectedTheme(): ThemeDefinition {
  const store = storage();
  if (!store) return defaultOfficialTheme();

  let raw: string | null = null;
  try {
    raw = store.getItem(SELECTED_THEME_KEY);
  } catch {
    raw = null;
  }

  const parsed = safeParse<unknown>(raw);
  const theme = parsed ? sanitizeTheme(parsed) : null;
  if (theme) return theme;

  return migrateLegacyAccent(store);
}

export function writeSelectedTheme(theme: ThemeDefinition): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SELECTED_THEME_KEY, JSON.stringify(theme));
  } catch {
    // Приватный режим/переполнение: тема применится сейчас.
  }
}

/* ── токены ───────────────────────────────────────────────────────────────── */

export type StoredThemeTokens = Partial<Record<'light' | 'dark', ThemeTokens>>;

export function readStoredTokens(): StoredThemeTokens | null {
  const store = storage();
  if (!store) return null;
  try {
    return safeParse<StoredThemeTokens>(store.getItem(THEME_TOKENS_KEY));
  } catch {
    return null;
  }
}

export function writeStoredTokens(tokens: StoredThemeTokens): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(THEME_TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // Не критично: при следующем применении попробуем снова.
  }
}

/** Выставляет все CSS-переменные темы на <html> и обновляет theme-color. */
export function applyThemeTokens(tokens: ThemeTokens): void {
  const doc = browserDocument();
  if (!doc) return;

  const root = doc.documentElement;
  for (const [field, variable] of TOKEN_CSS_VARS) {
    root.style.setProperty(variable, tokens[field]);
  }

  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', tokens.themeColor);
}

/** Снимает кастомные токены: возвращается палитра из index.css. */
export function clearThemeTokens(): void {
  const doc = browserDocument();
  if (!doc) return;

  const root = doc.documentElement;
  for (const [, variable] of TOKEN_CSS_VARS) {
    root.style.removeProperty(variable);
  }

  const dark = root.getAttribute('data-theme') === 'dark';
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#15131e' : '#f4f2fb');
}

/* ── кэш тем сообщества ───────────────────────────────────────────────────── */

export interface ThemesCache {
  at: number;
  items: ThemeDefinition[];
}

export function readThemesCache(): ThemesCache | null {
  const store = storage();
  if (!store) return null;

  try {
    const parsed = safeParse<unknown>(store.getItem(THEMES_CACHE_KEY));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = parsed as { at?: unknown; items?: unknown };
    if (typeof source.at !== 'number' || !Array.isArray(source.items)) return null;

    const items = source.items
      .map((item) => sanitizeTheme(item))
      .filter((item): item is ThemeDefinition => item !== null)
      .slice(0, 100);

    return { at: source.at, items };
  } catch {
    return null;
  }
}

export function writeThemesCache(items: ThemeDefinition[]): void {
  const store = storage();
  if (!store) return;
  try {
    const payload: ThemesCache = { at: Date.now(), items: items.slice(0, 100) };
    store.setItem(THEMES_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Кэш не обязателен: при ошибке просто сходим в сеть в следующий раз.
  }
}
