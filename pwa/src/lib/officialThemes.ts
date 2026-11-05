/**
 * Официальные темы Mood.
 *
 * Единственное место, куда добавляется новая официальная тема: достаточно
 * дописать объект в массив, API и база не меняются. Пользователь видит их в
 * общем списке, но не может удалить или скрыть.
 *
 * Фон и карточки у первых тем нейтральные (hue 255), чтобы сохранение текущего
 * вида приложения было предсказуемым: меняется в основном акцент. Новые темы
 * могут задавать свои оттенки фона и поверхностей — это просто ещё три числа.
 */

import type { ThemeDefinition, ThemeVariant } from './themeColors.ts';

const NEUTRAL_HUE = 255;

function both(accentHue: number, backgroundHue = NEUTRAL_HUE, surfaceHue = NEUTRAL_HUE) {
  const variant: ThemeVariant = { backgroundHue, surfaceHue, accentHue };
  return { light: variant, dark: variant };
}

export const OFFICIAL_THEMES: ThemeDefinition[] = [
  {
    id: 'mood-violet',
    name: 'Фиолетовый',
    official: true,
    variants: both(256),
  },
  {
    id: 'mood-blue',
    name: 'Синий',
    official: true,
    variants: both(210),
  },
  {
    id: 'mood-indigo',
    name: 'Индиго',
    official: true,
    variants: both(241),
  },
  {
    id: 'mood-teal',
    name: 'Бирюзовый',
    official: true,
    variants: both(189),
  },
  {
    id: 'mood-green',
    name: 'Зелёный',
    official: true,
    variants: both(135),
  },
  {
    id: 'mood-orange',
    name: 'Оранжевый',
    official: true,
    variants: both(35),
  },
  {
    id: 'mood-pink',
    name: 'Розовый',
    official: true,
    variants: both(349),
  },
];

export const DEFAULT_THEME_ID = 'mood-violet';

export function getOfficialTheme(id: string): ThemeDefinition | undefined {
  return OFFICIAL_THEMES.find((theme) => theme.id === id);
}

export function defaultOfficialTheme(): ThemeDefinition {
  return getOfficialTheme(DEFAULT_THEME_ID) ?? OFFICIAL_THEMES[0]!;
}
