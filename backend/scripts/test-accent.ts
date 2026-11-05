/**
 * Тесты персонального акцента.
 *
 * Проверяем чистую логику `pwa/src/lib/accent.ts`: разбор HEX, производные
 * токены под светлую/тёмную тему и контраст текста на заливке. UI и localStorage
 * здесь не участвуют — только математика цвета, поэтому тест детерминирован.
 *
 * Запуск: npm run test:accent
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  contrastRatio,
  contrastText,
  deriveAccent,
  normalizeHex,
} from '../../pwa/src/lib/accent.ts';

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
console.log('   ТЕСТЫ АКЦЕНТА (цвет и контраст)');
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

section('Пресеты');
{
  check('семь оттенков — все в одну строку', ACCENT_PRESETS.length === 7, String(ACCENT_PRESETS.length));
  check('id уникальны', new Set(ACCENT_PRESETS.map((p) => p.id)).size === ACCENT_PRESETS.length);
  check('цвета уникальны', new Set(ACCENT_PRESETS.map((p) => p.hex)).size === ACCENT_PRESETS.length);
  check(
    'все цвета нормализуются',
    ACCENT_PRESETS.every((p) => normalizeHex(p.hex) === p.hex),
  );
  check('фиолетовый — дефолт', ACCENT_PRESETS[0].hex === DEFAULT_ACCENT);
}

section('Контраст');
{
  check('белый и чёрный = 21', Math.round(contrastRatio('#ffffff', '#000000')) === 21);
  check('цвет сам с собой = 1', Math.round(contrastRatio('#7c4dff', '#7c4dff')) === 1);
  check('мусор не падает', contrastRatio('мусор', '#ffffff') === 1);

  check('фиолетовый → белый текст', contrastText('#7c4dff') === '#ffffff');
  check('оранжевый → тёмный текст', contrastText('#ff9500') === '#15131e');
  check('жёлтый → тёмный текст', contrastText('#ffe600') === '#15131e');

  check(
    'у каждого пресета текст читаем (AA 4.5)',
    ACCENT_PRESETS.every((p) => contrastRatio(p.hex, contrastText(p.hex)) >= 4.5),
  );
}

section('Производные токены');
{
  const light = deriveAccent(DEFAULT_ACCENT, 'light');
  check('светлая: акцент без изменений', light.accent === DEFAULT_ACCENT, light.accent);
  check('светлая: мягкий фон 0.12', light.soft === 'rgba(124, 77, 255, 0.12)', light.soft);
  check('светлая: текст белый', light.text === '#ffffff', light.text);

  const dark = deriveAccent(DEFAULT_ACCENT, 'dark');
  check('тёмная: мягкий фон 0.2', dark.soft === 'rgba(124, 77, 255, 0.2)', dark.soft);
  check('тёмная: акцент без изменений', dark.accent === DEFAULT_ACCENT, dark.accent);

  check(
    'fade — валидные HEX',
    [light.fade1, light.fade2, light.fade3, dark.fade1, dark.fade2, dark.fade3].every(
      (hex) => normalizeHex(hex) === hex,
    ),
  );

  const tooLight = deriveAccent('#f0f0f0', 'light');
  check('светлая: почти белый притемняется', tooLight.accent !== '#f0f0f0', tooLight.accent);

  const tooDark = deriveAccent('#101010', 'dark');
  check('тёмная: почти чёрный осветляется', tooDark.accent !== '#101010', tooDark.accent);

  check('мусор → дефолт', deriveAccent('не цвет', 'light').accent === DEFAULT_ACCENT);
}

/**
 * Ранний скрипт дублирует деривацию, чтобы цвет стоял до первого кадра.
 * Дубликат обязан совпадать с accent.ts байт-в-байт по значениям, иначе будет
 * вспышка одного оттенка и перекраска в другой сразу после загрузки React.
 */
section('Ранний theme-init.js совпадает с accent.ts');
{
  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../pwa/public/theme-init.js',
  );
  const script = readFileSync(scriptPath, 'utf8');

  function earlyVars(hex: string, dark: boolean): Record<string, string> {
    const props: Record<string, string> = {};

    const document = {
      documentElement: {
        setAttribute: () => {},
        style: {
          colorScheme: '',
          setProperty: (name: string, value: string) => {
            props[name] = value;
          },
          removeProperty: () => {},
        },
      },
      querySelector: () => ({ setAttribute: () => {} }),
    };
    const sandboxWindow = { matchMedia: () => ({ matches: dark }) };
    const localStorage = {
      getItem: (key: string): string | null =>
        ({ mood_theme: dark ? 'dark' : 'light', mood_accent: hex, mood_pwa_token: 'a.b.c' })[
          key
        ] ?? null,
      setItem: () => {},
      removeItem: () => {},
    };

    vm.runInNewContext(script, { window: sandboxWindow, document, localStorage });
    return props;
  }

  for (const theme of ['light', 'dark'] as const) {
    let mismatches = 0;

    for (const preset of ACCENT_PRESETS) {
      if (preset.hex === DEFAULT_ACCENT) continue;

      const expected = deriveAccent(preset.hex, theme);
      const actual = earlyVars(preset.hex, theme === 'dark');

      const same =
        actual['--accent'] === expected.accent &&
        actual['--accent-soft'] === expected.soft &&
        actual['--accent-text'] === expected.text &&
        actual['--accent-fade-1'] === expected.fade1 &&
        actual['--accent-fade-2'] === expected.fade2 &&
        actual['--accent-fade-3'] === expected.fade3;

      if (!same) mismatches += 1;
    }

    check(`${theme}: все пресеты совпадают`, mismatches === 0, `${mismatches} расхождений`);
    check(
      `${theme}: дефолт не пишет переменные`,
      Object.keys(earlyVars(DEFAULT_ACCENT, theme === 'dark')).length === 0,
    );
  }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
