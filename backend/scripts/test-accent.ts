/**
 * Тесты цветовой модели тем и раннего theme-init.js.
 *
 * Проверяем чистую математику `pwa/src/lib/themeColors.ts` и то, что ранний
 * скрипт применяет заранее вычисленные токены без расхождений. UI, сеть и
 * localStorage приложения здесь не участвуют.
 *
 * Запуск: npm run test:accent
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  contrastRatio,
  contrastText,
  deriveAllTokens,
  deriveThemeTokens,
  normalizeHex,
  primaryContrast,
  secondaryContrast,
  type ThemeDefinition,
} from '../../pwa/src/lib/themeColors.ts';
import { OFFICIAL_THEMES } from '../../pwa/src/lib/officialThemes.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

console.log('====================================================');
console.log('   ТЕСТЫ ТЕМ (цвет, контраст, ранний старт)');
console.log('====================================================');

section('Разбор HEX');
{
  check('#7C4DFF → нижний регистр', normalizeHex('#7C4DFF') === '#7c4dff');
  check('без # принимается', normalizeHex('7c4dff') === '#7c4dff');
  check('короткая запись #abc', normalizeHex('#abc') === '#aabbcc', String(normalizeHex('#abc')));
  check('верхний регистр без #', normalizeHex('AABBCC') === '#aabbcc');
  check('пробелы по краям', normalizeHex('  #0a84ff  ') === '#0a84ff');
  check('#abcd — мусор', normalizeHex('#abcd') === null);
  check('имя цвета — мусор', normalizeHex('red') === null);
  check('пустая строка — мусор', normalizeHex('') === null);
  check('невалидный hex-символ', normalizeHex('#gggggg') === null);
}

section('Контраст');
{
  check('белый и чёрный = 21', Math.round(contrastRatio('#ffffff', '#000000')) === 21);
  check('цвет сам с собой = 1', Math.round(contrastRatio('#7c4dff', '#7c4dff')) === 1);
  check('мусор не падает', contrastRatio('мусор', '#ffffff') === 1);
  check('фиолетовый → белый текст', contrastText('#7c4dff') === '#ffffff');
  check('оранжевый → тёмный текст', contrastText('#ff9500') === '#15131e');
  check('жёлтый → тёмный текст', contrastText('#ffe600') === '#15131e');
}

section('Официальные темы');
{
  check('семь официальных тем', OFFICIAL_THEMES.length === 7, String(OFFICIAL_THEMES.length));
  check('id уникальны', new Set(OFFICIAL_THEMES.map((theme) => theme.id)).size === OFFICIAL_THEMES.length);
  check(
    'у каждой есть светлая и тёмная версии',
    OFFICIAL_THEMES.every((theme) => Boolean(theme.variants.light && theme.variants.dark)),
  );
  check(
    'все оттенки в диапазоне 0…359',
    OFFICIAL_THEMES.every((theme) =>
      (['light', 'dark'] as const).every((key) => {
        const variant = theme.variants[key];
        return (
          variant !== undefined &&
          [variant.backgroundHue, variant.surfaceHue, variant.accentHue].every(
            (hue) => Number.isInteger(hue) && hue >= 0 && hue <= 359,
          )
        );
      }),
    ),
  );
}

section('Производные токены');
{
  for (const theme of OFFICIAL_THEMES) {
    for (const key of ['light', 'dark'] as const) {
      const variant = theme.variants[key]!;
      const tokens = deriveThemeTokens(variant, key);

      check(
        `${theme.name}/${key}: основные цвета — HEX`,
        [tokens.appBg, tokens.surface, tokens.surfaceGrouped, tokens.textPrimary, tokens.accent].every(
          (hex) => normalizeHex(hex) === hex,
        ),
      );
      check(
        `${theme.name}/${key}: текст на фоне ≥ 7`,
        primaryContrast(tokens) >= 7,
        primaryContrast(tokens).toFixed(2),
      );
      check(
        `${theme.name}/${key}: вторичный текст ≥ 4.5`,
        secondaryContrast(tokens) >= 4.5,
        secondaryContrast(tokens).toFixed(2),
      );
      check(
        `${theme.name}/${key}: текст на акценте ≥ 4.5`,
        contrastRatio(tokens.accent, tokens.accentText) >= 4.5,
        contrastRatio(tokens.accent, tokens.accentText).toFixed(2),
      );
    }
  }

  const light = deriveThemeTokens({ backgroundHue: 255, surfaceHue: 255, accentHue: 256 }, 'light');
  const dark = deriveThemeTokens({ backgroundHue: 255, surfaceHue: 255, accentHue: 256 }, 'dark');
  check('светлая тема светлее тёмной', contrastRatio(light.appBg, '#ffffff') < contrastRatio(dark.appBg, '#ffffff'));
  check('оба варианта дают разные токены', light.appBg !== dark.appBg);
  check('themeColor совпадает с фоном', light.themeColor === light.appBg);

  const boundary = deriveThemeTokens({ backgroundHue: 0, surfaceHue: 359, accentHue: 360 }, 'dark');
  check('граничные оттенки не падают', normalizeHex(boundary.accent) !== null);
}

section('Токены для обоих вариантов');
{
  const theme: ThemeDefinition = {
    id: 'test',
    name: 'Тест',
    variants: {
      light: { backgroundHue: 200, surfaceHue: 200, accentHue: 200 },
      dark: { backgroundHue: 20, surfaceHue: 20, accentHue: 20 },
    },
  };

  const tokens = deriveAllTokens(theme);
  check('light посчитан', Boolean(tokens.light));
  check('dark посчитан', Boolean(tokens.dark));
  check('варианты различаются', tokens.light?.appBg !== tokens.dark?.appBg);

  const single = deriveAllTokens({
    id: 'single',
    name: 'Одна',
    variants: { dark: { backgroundHue: 10, surfaceHue: 10, accentHue: 10 } },
  });
  check('один вариант не создаёт второй', Boolean(single.dark) && !single.light);
}

/**
 * Ранний скрипт не дублирует формулы: он читает готовые токены. Проверяем,
 * что значения доходят до CSS-переменных и что одноvariant-тема принудительно
 * включает свой режим.
 */
section('Ранний theme-init.js применяет готовые токены');
{
  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../pwa/public/theme-init.js',
  );
  const script = readFileSync(scriptPath, 'utf8');

  interface RunResult {
    vars: Record<string, string>;
    attributes: Record<string, string>;
    meta: string | null;
  }

  function run(storage: Record<string, string>, systemDark: boolean): RunResult {
    const vars: Record<string, string> = {};
    const attributes: Record<string, string> = {};
    let meta: string | null = null;

    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
        removeAttribute: (name: string) => {
          delete attributes[name];
        },
        style: {
          colorScheme: '',
          setProperty: (name: string, value: string) => {
            vars[name] = value;
          },
          removeProperty: (name: string) => {
            delete vars[name];
          },
        },
      },
      querySelector: () => ({
        setAttribute: (_name: string, value: string) => {
          meta = value;
        },
      }),
    };

    const sandboxWindow = { matchMedia: () => ({ matches: systemDark }) };
    const localStorage = {
      getItem: (key: string): string | null => storage[key] ?? null,
      setItem: () => {},
      removeItem: () => {},
    };

    vm.runInNewContext(script, { window: sandboxWindow, document, localStorage });
    return { vars, attributes, meta };
  }

  const variant = { backgroundHue: 30, surfaceHue: 210, accentHue: 330 };
  const theme: ThemeDefinition = {
    id: 'thm_test',
    name: 'Закат',
    variants: { dark: variant, light: variant },
  };
  const tokens = deriveAllTokens(theme);

  const baseStorage = {
    mood_theme: 'dark',
    mood_theme_selected: JSON.stringify(theme),
    mood_theme_tokens: JSON.stringify(tokens),
    mood_pwa_token: 'a.b.c',
  };

  const dark = run(baseStorage, true);
  check('тёмная: data-theme=dark', dark.attributes['data-theme'] === 'dark', dark.attributes['data-theme']);
  check('тёмная: фон совпадает', dark.vars['--app-bg'] === tokens.dark!.appBg, dark.vars['--app-bg']);
  check('тёмная: акцент совпадает', dark.vars['--accent'] === tokens.dark!.accent, dark.vars['--accent']);
  check('тёмная: meta theme-color', dark.meta === tokens.dark!.themeColor, String(dark.meta));

  const light = run({ ...baseStorage, mood_theme: 'light' }, true);
  check('светлая: data-theme=light', light.attributes['data-theme'] === 'light', light.attributes['data-theme']);
  check('светлая: фон совпадает', light.vars['--app-bg'] === tokens.light!.appBg, light.vars['--app-bg']);

  const system = run({ ...baseStorage, mood_theme: 'system' }, false);
  check('системная светлая: выбран light', system.attributes['data-theme'] === 'light', system.attributes['data-theme']);

  const singleTheme: ThemeDefinition = {
    id: 'thm_single',
    name: 'Только тёмная',
    variants: { dark: variant },
  };
  const singleTokens = deriveAllTokens(singleTheme);
  const single = run(
    {
      ...baseStorage,
      mood_theme: 'light',
      mood_theme_selected: JSON.stringify(singleTheme),
      mood_theme_tokens: JSON.stringify(singleTokens),
    },
    false,
  );
  check('одноvariant: светлый режим принудительно тёмный', single.attributes['data-theme'] === 'dark', single.attributes['data-theme']);

  const guest = run({ ...baseStorage, mood_guest_mode: '1' }, true);
  check('гость: кастомные переменные не применяются', guest.vars['--app-bg'] === undefined);
  check('гость: остаётся системный режим', guest.attributes['data-theme'] === 'dark');
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
