/**
 * Генерация PNG-иконок приложения из двух исходников в assets/.
 *
 * Зачем отдельным скриптом: в манифесте нужны конкретные размеры (192, 512,
 * maskable-512), сайту и браузеру — свои (apple-touch 180, favicon 32, иконка на
 * экране входа). Править исходники под каждый размер вручную — гарантированный
 * способ однажды забыть про иконку.
 *
 * Два источника и зачем:
 *   - assets/icon.png    — логотип со скруглёнными гранями (прозрачные углы).
 *                          Идёт ВЕЗДЕ, кроме манифеста: favicon, apple-touch,
 *                          иконка на сайте.
 *   - assets/icon_fs.png — тот же логотип, полностью залитый цветом (full-bleed,
 *                          без прозрачных углов). Только для манифеста PWA:
 *                          Android сам скругляет иконку/делает maskable, и
 *                          прозрачные углы там дали бы дыры и обрезанный логотип.
 *
 * Идемпотентен: если PNG новее своего исходника, он пропускается.
 * Если sharp не установлен, скрипт не падает, а предупреждает: без PNG
 * приложение работает, теряется только внешний вид на экране «домой».
 *
 * ВАЖНО при смене иконок: у /icons/ в nginx кэш 30 дней, поэтому после
 * перегенерации нужно поднять версию `?v=N` в manifest.webmanifest, index.html
 * и public/sw.js — иначе браузер и Service Worker ещё месяц отдают старую
 * картинку по тому же URL.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(HERE, '../public/icons');

// Исходные логотипы лежат вне public: они нужны только на этапе сборки и не
// должны попадать в раздачу (файлы крупные, браузер их не запрашивает).
const SOURCE_ROUNDED = path.resolve(HERE, '../assets/icon.png');
const SOURCE_FULL = path.resolve(HERE, '../assets/icon_fs.png');

/**
 * Скруглённый логотип — всё, что не манифест.
 *
 * `site-icon-192.png` — картинка на экране входа; отдельным файлом, чтобы не
 * путать её с `icon-192.png` манифеста (там full-bleed источник).
 */
const ROUNDED_TARGETS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
  { file: 'site-icon-192.png', size: 192 },
];

/** ICO с одной картинкой 32×32 внутри; собирается из скруглённого favicon-32. */
const FAVICON = { file: 'favicon.ico', size: 32 };

/**
 * Full-bleed источник — только иконки манифеста PWA.
 *
 * maskable берётся без дополнительного отступа: источник уже залит по краям,
 * а искусственная рамка только добавляла видимый бордюр.
 */
const FULL_TARGETS = [
  // 48/72/96/144 — размеры лаунчера Android (их берёт и TWA). 192/512 — манифест
  // PWA; 512 maskable — adaptive-иконка.
  { file: 'icon-48.png', size: 48 },
  { file: 'icon-72.png', size: 72 },
  { file: 'icon-96.png', size: 96 },
  { file: 'icon-144.png', size: 144 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512 },
];

/** Фон для flatten: нужен на случай полупрозрачных уголков у full-bleed PNG. */
const FULL_BG = '#15131e';

/**
 * Оборачивает PNG в контейнер ICO.
 *
 * Формат: ICONDIR (6 байт) + ICONDIRENTRY (16 байт) + сами данные PNG.
 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0);
  entry.writeUInt8(size % 256, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

/** Иконка свежее исходника? Иначе её нужно пересобрать. */
async function isFresh(file, source) {
  try {
    const [png, src] = await Promise.all([stat(path.join(ICONS_DIR, file)), stat(source)]);
    return png.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.warn(
      '[icons] sharp не установлен — PNG-иконки пропущены.\n' +
        '        Установите зависимости: npm install  (в папке pwa)',
    );
    return;
  }

  const [rounded, full] = await Promise.all([readFile(SOURCE_ROUNDED), readFile(SOURCE_FULL)]);

  const render = (source, size, { flatten = false } = {}) => {
    let pipeline = sharp(source).resize(size, size, { fit: 'cover' });
    if (flatten) pipeline = pipeline.flatten({ background: FULL_BG });
    return pipeline.png().toBuffer();
  };

  for (const target of ROUNDED_TARGETS) {
    if (await isFresh(target.file, SOURCE_ROUNDED)) continue;

    const png = await render(rounded, target.size);
    await writeFile(path.join(ICONS_DIR, target.file), png);
    console.log(`[icons] ${target.file} (${target.size}×${target.size}, скруглённый)`);

    if (target.size === FAVICON.size) {
      await writeFile(path.join(ICONS_DIR, FAVICON.file), pngToIco(png, FAVICON.size));
      console.log(`[icons] ${FAVICON.file} (${FAVICON.size}×${FAVICON.size}, ICO из PNG)`);
    }
  }

  // favicon.ico мог остаться от прошлого прогона и быть новее скруглённого PNG,
  // поэтому проверяем его отдельно и пересобираем из готового favicon-32.png.
  if (!(await isFresh(FAVICON.file, SOURCE_ROUNDED))) {
    try {
      const png = await readFile(path.join(ICONS_DIR, 'favicon-32.png'));
      await writeFile(path.join(ICONS_DIR, FAVICON.file), pngToIco(png, FAVICON.size));
      console.log(`[icons] ${FAVICON.file} (${FAVICON.size}×${FAVICON.size}, ICO из PNG)`);
    } catch {
      // favicon-32.png ещё не сгенерирован — подождёт следующего прогона.
    }
  }

  for (const target of FULL_TARGETS) {
    if (await isFresh(target.file, SOURCE_FULL)) continue;

    const maskable = target.file.includes('maskable');
    const png = await render(full, target.size, { flatten: maskable });
    await writeFile(path.join(ICONS_DIR, target.file), png);
    console.log(`[icons] ${target.file} (${target.size}×${target.size}, full-bleed${maskable ? ', maskable' : ''})`);
  }
}

main().catch((err) => {
  console.error('[icons] не удалось сгенерировать иконки:', err);
  process.exitCode = 1;
});
