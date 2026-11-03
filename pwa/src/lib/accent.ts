/**
 * Персональный акцентный цвет.
 *
 * Единственный источник правды об акценте, по образцу `lib/theme.ts`: выбор
 * читается из localStorage РОВНО ОДИН РАЗ при загрузке модуля и дальше живёт в
 * памяти, а на документ выставляются CSS-переменные. В рендере storage не
 * читается — синхронный доступ к нему блокировал бы поток.
 *
 * Почему переменные, а не классы: пресеты задаются одним HEX, а производные
 * токены (--accent-soft, --accent-text, --accent-fade-*) считаются из него под
 * текущую тему. Тема меняется атрибутом `data-theme`, и `lib/theme.ts` заново
 * вызывает `applyAccent()` — цвета успевают пересчитаться до перерисовки.
 *
 * Область действия — только авторизованное приложение: без PWA-токена (экран
 * входа, 2FA, установка) и в гостевом режиме переменные не выставляются, и
 * остаются фиолетовые значения из index.css. Поэтому модуль сам читает ключи
 * токена и гостя, а не импортирует `auth.ts`: auth вызывает `syncAccentWithAuth`,
 * и статический импорт в обратную сторону замкнул бы цикл.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Ключ выбора пользователя в localStorage. */
export const ACCENT_STORAGE_KEY = 'mood_accent';

/** Акцент по умолчанию — текущий фиолетовый. Совпадает с --accent в index.css. */
export const DEFAULT_ACCENT = '#7c4dff';

/** Ключи авторизации. Дублируются строкой, чтобы не замыкать цикл с auth.ts. */
const TOKEN_KEY = 'mood_pwa_token';
const GUEST_KEY = 'mood_guest_mode';

export type AccentTheme = 'light' | 'dark';

export interface AccentPreset {
  id: string;
  name: string;
  hex: string;
}

/**
 * Готовые оттенки. Взяты по шкале iOS: приложение повторяет её визуальный язык,
 * а проверенные системные цвета заведомо дают читаемый контраст с белым/тёмным
 * текстом после коррекции светлоты.
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'violet', name: 'Фиолетовый', hex: DEFAULT_ACCENT },
  { id: 'blue', name: 'Синий', hex: '#0a84ff' },
  { id: 'indigo', name: 'Индиго', hex: '#5e5ce6' },
  { id: 'teal', name: 'Бирюзовый', hex: '#30b0c7' },
  { id: 'green', name: 'Зелёный', hex: '#34c759' },
  { id: 'orange', name: 'Оранжевый', hex: '#ff9500' },
  { id: 'pink', name: 'Розовый', hex: '#ff2d55' },
  { id: 'coral', name: 'Коралловый', hex: '#ff6961' },
];

export interface AccentVars {
  accent: string;
  soft: string;
  text: string;
  fade1: string;
  fade2: string;
  fade3: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Разбирает `#abc`, `abc`, `#aabbcc` или `AABBCC`; иначе null. */
function parseHex(input: string): Rgb | null {
  if (typeof input !== 'string') return null;

  let value = input.trim().toLowerCase();
  if (value.startsWith('#')) value = value.slice(1);

  if (/^[0-9a-f]{3}$/.test(value)) {
    value = value
      .split('')
      .map((char) => char + char)
      .join('');
  }

  if (!/^[0-9a-f]{6}$/.test(value)) return null;

  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Приводит ввод к `#rrggbb` нижним регистром. Мусор — null. */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  return rgb ? rgbToHex(rgb) : null;
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let h: number;
  if (max === rn) h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;

  return { h: h * 60, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

/** Линейная яркость канала по WCAG 2.x. */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** Коэффициент контраста двух цветов (1…21). На мусоре — 1. */
export function contrastRatio(a: string, b: string): number {
  const left = parseHex(a);
  const right = parseHex(b);
  if (!left || !right) return 1;

  const la = relativeLuminance(left);
  const lb = relativeLuminance(right);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Цвет текста на акцентной заливке.
 *
 * Порог 4.5 — обычный текст WCAG AA. Всё, что светлее (жёлтый, оранжевый,
 * салатовый), получает тёмный текст: белый на них нечитаем.
 */
export function contrastText(hex: string): string {
  return contrastRatio(hex, '#ffffff') >= 4.5 ? '#ffffff' : '#15131e';
}

/**
 * Все токены акцента для одной темы.
 *
 * В светлой теме слишком светлый цвет притемняется (иначе он не читается на
 * белой карточке), в тёмной — слишком тёмный осветляется. Границы подобраны
 * так, чтобы чистый белый и чистый чёрный не превращались в невидимые пятна.
 */
export function deriveAccent(hex: string, theme: AccentTheme): AccentVars {
  const base = parseHex(hex) ?? (parseHex(DEFAULT_ACCENT) as Rgb);
  const hsl = rgbToHsl(base);

  let lightness = hsl.l;
  if (theme === 'light' && lightness > 0.78) lightness = 0.55;
  if (theme === 'dark' && lightness < 0.5) lightness = 0.65;

  const accent = hslToHex(hsl.h, hsl.s, lightness);
  const rgb = parseHex(accent) as Rgb;

  return {
    accent,
    soft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${theme === 'dark' ? 0.2 : 0.12})`,
    text: contrastText(accent),
    fade1: hslToHex(hsl.h, hsl.s, clamp(lightness + 0.12, 0, 1)),
    fade2: hslToHex(hsl.h, hsl.s, clamp(lightness - 0.08, 0, 1)),
    fade3: hslToHex(hsl.h, hsl.s, clamp(lightness - 0.18, 0, 1)),
  };
}

/* ─────────────────────────── состояние и документ ─────────────────────────── */

/**
 * Минимальные типы браузерных API.
 *
 * Модуль импортируется и тестами бэкенда (`npm run lint` собирает backend и
 * pwa одним компилятором без lib.dom), поэтому `document`, `window` и
 * `localStorage` описаны здесь вручную, вместо глобальных DOM-типов. Заодно
 * это честно показывает, что модулю нужно от браузера: ничего сверх этого.
 */
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
    style: StyleLike;
  };
}

interface WindowLike {
  addEventListener(type: string, listener: (event: { key?: string | null }) => void): void;
}

function storage(): StorageLike | null {
  return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
}

function browserDocument(): DocumentLike | null {
  return (globalThis as { document?: DocumentLike }).document ?? null;
}

function browserWindow(): WindowLike | null {
  return (globalThis as { window?: WindowLike }).window ?? null;
}

/** Однократное чтение выбора из storage. Дальше значение держим в памяти. */
function readStoredAccent(): string {
  const store = storage();
  if (!store) return DEFAULT_ACCENT;
  try {
    const stored = store.getItem(ACCENT_STORAGE_KEY);
    return stored ? normalizeHex(stored) ?? DEFAULT_ACCENT : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let currentAccent: string = readStoredAccent();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Есть ли рабочий вход и не гость ли это: акцент живёт только в приложении. */
function isAuthorized(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const token = store.getItem(TOKEN_KEY);
    if (!token) return false;
    return store.getItem(GUEST_KEY) !== '1';
  } catch {
    return false;
  }
}

function documentTheme(): AccentTheme {
  const root = browserDocument()?.documentElement;
  return root?.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

const ACCENT_VARS = [
  '--accent',
  '--accent-soft',
  '--accent-text',
  '--accent-fade-1',
  '--accent-fade-2',
  '--accent-fade-3',
] as const;

function clearVars(style: StyleLike): void {
  for (const name of ACCENT_VARS) style.removeProperty(name);
}

/**
 * Применяет акцент к документу. Идемпотентно.
 *
 * Вызывается из `lib/theme.ts` при каждой смене темы: производные токены
 * зависят от темы, поэтому одних переменных мало — их надо пересчитать.
 */
export function applyAccent(theme: AccentTheme): void {
  const root = browserDocument()?.documentElement;
  if (!root) return;

  if (!isAuthorized() || currentAccent === DEFAULT_ACCENT) {
    clearVars(root.style);
    return;
  }

  const vars = deriveAccent(currentAccent, theme);
  root.style.setProperty('--accent', vars.accent);
  root.style.setProperty('--accent-soft', vars.soft);
  root.style.setProperty('--accent-text', vars.text);
  root.style.setProperty('--accent-fade-1', vars.fade1);
  root.style.setProperty('--accent-fade-2', vars.fade2);
  root.style.setProperty('--accent-fade-3', vars.fade3);
}

/**
 * Согласует акцент с текущим входом и темой.
 *
 * Зовётся после входа/выхода, смены гостевого режима и из ранней инициализации:
 * один вход в приложение — один акцент, без «протёкшего» цвета с прошлого
 * аккаунта на экран входа.
 */
export function syncAccentWithAuth(): void {
  applyAccent(documentTheme());
}

/** Текущий акцент из памяти (storage не читает). */
export function getAccent(): string {
  return currentAccent;
}

/** Устанавливает и сохраняет акцент. Невалидный HEX игнорируется. */
export function setAccent(hex: string): void {
  const normalized = normalizeHex(hex);
  if (!normalized) return;

  currentAccent = normalized;

  const store = storage();
  if (store) {
    try {
      // Дефолт не храним: без ключа CSS-значения остаются нетронутыми, и в
      // тёмной теме работает её собственный (более светлый) фиолетовый.
      if (normalized === DEFAULT_ACCENT) store.removeItem(ACCENT_STORAGE_KEY);
      else store.setItem(ACCENT_STORAGE_KEY, normalized);
    } catch {
      // Приватный режим: выбор применится сейчас, но не переживёт перезагрузку.
    }
  }

  syncAccentWithAuth();
  emit();
}

/** Сбрасывает акцент к встроенному фиолетовому. */
export function resetAccent(): void {
  setAccent(DEFAULT_ACCENT);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Синхронизация между вкладками и смена входа в другой вкладке.
browserWindow()?.addEventListener('storage', (event) => {
  if (event.key === ACCENT_STORAGE_KEY) {
    currentAccent = readStoredAccent();
    syncAccentWithAuth();
    emit();
    return;
  }

  if (event.key === TOKEN_KEY || event.key === GUEST_KEY) {
    syncAccentWithAuth();
    emit();
  }
});

/**
 * Хук акцента: текущий цвет, установка и сброс.
 *
 * Подписчиков мало (карточка настроек), поэтому ререндер при смене цвета
 * касается только её — остальной интерфейс перекрашивает CSS.
 */
export function useAccent(): [string, (hex: string) => void, () => void] {
  const accent = useSyncExternalStore(subscribe, getAccent, () => DEFAULT_ACCENT);
  const set = useCallback((hex: string) => setAccent(hex), []);
  const reset = useCallback(() => resetAccent(), []);

  return [accent, set, reset];
}
