/**
 * Чистая цветовая математика тем оформления.
 *
 * Здесь нет DOM, React и localStorage: только функции, которые по трём
 * оттенкам (HSL hue) строят полный набор CSS-переменных для светлого или
 * тёмного варианта. Это позволяет тестировать контраст и не дублировать
 * формулы в `theme-init.js`: ранний скрипт читает уже готовые токены.
 *
 * Пользователь выбирает только оттенки. Насыщенность и светлота подбираются
 * автоматически, иначе почти любой самостоятельный цвет давал бы нечитаемый
 * текст на карточках и кнопках.
 */

export type ThemeVariantKey = 'light' | 'dark';

/** Три оттенка одной версии темы. Все значения — целые 0…359. */
export interface ThemeVariant {
  backgroundHue: number;
  surfaceHue: number;
  accentHue: number;
}

export type ThemeVariants = Partial<Record<ThemeVariantKey, ThemeVariant>>;

/** Тема в клиенте. Официальные приходят из кода, остальные — из API/кэша. */
export interface ThemeDefinition {
  id: string;
  name: string;
  variants: ThemeVariants;
  /** Официальная тема из кода: её нельзя удалить или скрыть. */
  official?: boolean;
  /** Тема текущего пользователя (ответ сервера). */
  mine?: boolean;
  /** Локальная тема, мигрированная из старого акцента. */
  local?: boolean;
  createdAt?: string;
}

/** Полный набор CSS-переменных одной версии темы. */
export interface ThemeTokens {
  appBg: string;
  surface: string;
  surfaceGrouped: string;
  surfaceBlur: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  separator: string;
  separatorSoft: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  accentFade1: string;
  accentFade2: string;
  accentFade3: string;
  shadowCard: string;
  /** Цвет `<meta name="theme-color">` и статус-бара. */
  themeColor: string;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const DEFAULT_ACCENT_HEX = '#7c4dff';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Разбирает `#abc`, `abc`, `#aabbcc` или `AABBCC`; иначе null. */
export function parseHex(input: string): Rgb | null {
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

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Приводит ввод к `#rrggbb` нижним регистром. Мусор — null. */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  return rgb ? rgbToHex(rgb) : null;
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
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

export function hslToHex(h: number, s: number, l: number): string {
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

/** rgba() из HEX и альфы. */
export function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
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
 * Порог 4.5 — обычный текст WCAG AA. Светлые оттенки (жёлтый, оранжевый,
 * салатовый) получают тёмный текст: белый на них нечитаем. Если фирменный
 * тёмный чуть не дотягивает до AA, отдаём чистый чёрный — он гарантированно
 * проходит на пограничных оттенках.
 */
export function contrastText(hex: string): string {
  if (contrastRatio(hex, '#ffffff') >= 4.5) return '#ffffff';
  const brandDark = '#15131e';
  if (contrastRatio(hex, brandDark) >= 4.5) return brandDark;
  return '#000000';
}

/**
 * Смешивает текст с фоном по альфе и возвращает непрозрачный HEX.
 *
 * Нужно для проверки контраста вторичного текста: в CSS он задан через
 * rgba(), а проверять надо фактический цвет на поверхности.
 */
export function composite(foreground: string, background: string, alpha: number): string {
  const fg = parseHex(foreground) ?? { r: 0, g: 0, b: 0 };
  const bg = parseHex(background) ?? { r: 255, g: 255, b: 255 };
  const a = clamp(alpha, 0, 1);

  return rgbToHex({
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  });
}

/** Приводит hue к целому 0…359, мусор — 0. */
export function normalizeHue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(((value % 360) + 360) % 360) % 360;
}

/** Проверяет, что вариант темы — три корректных оттенка. */
export function sanitizeVariant(value: unknown): ThemeVariant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  if (
    typeof source.backgroundHue !== 'number' ||
    typeof source.surfaceHue !== 'number' ||
    typeof source.accentHue !== 'number'
  ) {
    return null;
  }

  return {
    backgroundHue: normalizeHue(source.backgroundHue),
    surfaceHue: normalizeHue(source.surfaceHue),
    accentHue: normalizeHue(source.accentHue),
  };
}

/** Проверяет и нормализует варианты из localStorage или API. */
export function sanitizeVariants(value: unknown): ThemeVariants {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: ThemeVariants = {};

  for (const key of ['light', 'dark'] as const) {
    const variant = sanitizeVariant(source[key]);
    if (variant) result[key] = variant;
  }

  return result;
}

/** Порядок вариантов для интерфейса: сначала текущий режим, потом второй. */
export function variantKeys(theme: ThemeDefinition): ThemeVariantKey[] {
  return (['light', 'dark'] as const).filter((key) => theme.variants[key] !== undefined);
}

/** Есть ли у темы хотя бы один вариант. */
export function hasVariants(theme: ThemeDefinition): boolean {
  return variantKeys(theme).length > 0;
}

/**
 * Какие режимы можно выбрать для темы.
 *
 * Два варианта — все три режима. Один вариант — только он; «Системная» тоже
 * недоступна, потому что система могла бы потребовать отсутствующий вариант.
 */
export function availableThemeModes(theme: ThemeDefinition): Array<'system' | ThemeVariantKey> {
  const keys = variantKeys(theme);
  if (keys.length >= 2) return ['system', 'light', 'dark'];
  return keys;
}

/** Проверка, доступен ли режим у темы. */
export function themeModeAvailable(
  theme: ThemeDefinition,
  mode: 'system' | ThemeVariantKey,
): boolean {
  return availableThemeModes(theme).includes(mode);
}

/** Превращает предпочтение режима в фактический вариант темы. */
export function resolveVariantKey(
  theme: ThemeDefinition,
  mode: 'system' | ThemeVariantKey,
  systemDark: boolean,
): ThemeVariantKey {
  const keys = variantKeys(theme);
  if (keys.length === 0) return 'dark';

  // Один вариант — принудительно он, независимо от предпочтения.
  if (keys.length === 1) return keys[0]!;

  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

/**
 * Собирает токены одной версии темы.
 *
 * Формулы подобраны так, чтобы фон, карточки и текст оставались различимыми
 * при любом hue: светлота фиксирована, меняется только оттенок.
 */
export function deriveThemeTokens(variant: ThemeVariant, mode: ThemeVariantKey): ThemeTokens {
  const dark = mode === 'dark';
  const bgHue = normalizeHue(variant.backgroundHue);
  const surfaceHue = normalizeHue(variant.surfaceHue);
  const accentHue = normalizeHue(variant.accentHue);

  const appBg = hslToHex(bgHue, dark ? 0.18 : 0.3, dark ? 0.08 : 0.96);
  const surface = hslToHex(surfaceHue, dark ? 0.16 : 0.12, dark ? 0.12 : 1);
  const surfaceGrouped = hslToHex(surfaceHue, dark ? 0.18 : 0.18, dark ? 0.155 : 0.975);
  const textPrimary = hslToHex(bgHue, dark ? 0.12 : 0.25, dark ? 0.96 : 0.1);

  const accentLightness = dark ? 0.66 : 0.54;
  const accent = hslToHex(accentHue, 0.82, accentLightness);

  return {
    appBg,
    surface,
    surfaceGrouped,
    surfaceBlur: rgba(surface, 0.82),
    textPrimary,
    textSecondary: rgba(textPrimary, 0.62),
    textTertiary: rgba(textPrimary, 0.34),
    separator: rgba(textPrimary, dark ? 0.2 : 0.18),
    separatorSoft: rgba(textPrimary, dark ? 0.1 : 0.08),
    accent,
    accentSoft: rgba(accent, dark ? 0.2 : 0.12),
    accentText: contrastText(accent),
    accentFade1: hslToHex(accentHue, 0.82, clamp(accentLightness + 0.12, 0, 1)),
    accentFade2: hslToHex(accentHue, 0.82, clamp(accentLightness - 0.08, 0, 1)),
    accentFade3: hslToHex(accentHue, 0.82, clamp(accentLightness - 0.18, 0, 1)),
    shadowCard: dark
      ? 'none'
      : '0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04)',
    themeColor: appBg,
  };
}

/** Все токены для обоих доступных вариантов темы. */
export function deriveAllTokens(theme: ThemeDefinition): Partial<Record<ThemeVariantKey, ThemeTokens>> {
  const tokens: Partial<Record<ThemeVariantKey, ThemeTokens>> = {};

  for (const key of variantKeys(theme)) {
    const variant = theme.variants[key];
    if (variant) tokens[key] = deriveThemeTokens(variant, key);
  }

  return tokens;
}

/* ── проверка контраста для тестов и разработки ───────────────────────────── */

/** Минимальный контраст вторичного текста на поверхности. */
export function secondaryContrast(tokens: ThemeTokens): number {
  const alpha = 0.62;
  const flat = composite(tokens.textPrimary, tokens.surface, alpha);
  return contrastRatio(flat, tokens.surface);
}

/** Минимальный контраст основного текста на фоне. */
export function primaryContrast(tokens: ThemeTokens): number {
  return contrastRatio(tokens.textPrimary, tokens.appBg);
}
