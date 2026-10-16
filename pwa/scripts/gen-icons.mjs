/**
 * Генерация PNG-иконок приложения из assets/icon.png.
 *
 * Зачем отдельным скриптом: в манифесте нужны конкретные размеры (192, 512,
 * maskable-512, apple-touch 180, favicon 32), а править исходник под каждый
 * размер вручную — гарантированный способ однажды забыть про иконку.
 *
 * Исходник — растровый PNG (логотип приложения), а не SVG: генератор только
 * режет и масштабирует его под нужные размеры.
 *
 * Идемпотентен: если PNG новее исходника, он пропускается. Это позволяет
 * держать иконки в репозитории и не генерировать их на каждой машине.
 *
 * Если sharp не установлен, скрипт не падает, а предупреждает: без PNG
 * приложение всё равно работает, теряется только внешний вид на экране «домой».
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(HERE, '../public/icons');
// Исходный логотип лежит вне public: он нужен только на этапе сборки и не
// должен попадать в раздачу (файл крупный, а браузер его не запрашивает).
const SOURCE = path.resolve(HERE, '../assets/icon.png');

/**
 * Все варианты, которые нужны манифесту и браузерам.
 *
 * favicon.ico собирается вручную из PNG: sharp не умеет писать формат ICO,
 * а формат с PNG внутри (Vista и новее, то есть везде актуальном) — это
 * 22-байтный заголовок, и он читается прямо в этом файле. Отдельная ссылка на
 * favicon-32.png в index.html при этом тоже остаётся: PNG отдаётся без
 * преобразования, а ICO нужен там, где PNG-иконку браузер игнорирует.
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
];

/** ICO с одной картинкой 32×32 внутри. */
const FAVICON = { file: 'favicon.ico', size: 32 };

/**
 * Оборачивает PNG в контейнер ICO.
 *
 * Формат: ICONDIR (6 байт) + ICONDIRENTRY (16 байт) + сами данные PNG.
 * Для ICO с PNG внутри данные не нужно распаковывать в BMP, поэтому хватает
 * указать размеры, которые и так есть в заголовке PNG.
 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  // 0 — иконка, 1 — количество картинок.
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0); // ширина (0 означает 256, но нам 32)
  entry.writeUInt8(size % 256, 1); // высота
  entry.writeUInt8(0, 2); // палитра не используется
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // цветовые плоскости
  entry.writeUInt16LE(32, 6); // бит на пиксель
  entry.writeUInt32LE(png.length, 8); // размер данных
  entry.writeUInt32LE(header.length + entry.length, 12); // смещение данных

  return Buffer.concat([header, entry, png]);
}

/**
 * Отдельная maskable-иконка.
 *
 * Маска Android может обрезать до 20% с каждой стороны (безопасная зона — круг),
 * поэтому картинка уменьшается до 80% и центрируется на полностью залитом фоне.
 * Без этого логотип обрезался бы по краям на части устройств.
 *
 * Фон — тёмный цвет подложки самого логотипа, чтобы квадрат не выделялся на
 * иконке-«квадрате» Android.
 */
// Исходник icon_fs.png уже имеет залитый фон по краям, поэтому для maskable
// тоже используем весь кадр: дополнительный отступ создавал заметную рамку.
const MASKABLE = { file: 'icon-maskable-512.png', size: 512, padding: 0 };
const MASKABLE_BG = '#100f1e';

async function isFresh(target) {
  try {
    const [png, source] = await Promise.all([
      stat(path.join(ICONS_DIR, target.file)),
      stat(SOURCE),
    ]);
    return png.mtimeMs >= source.mtimeMs;
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

  const source = await readFile(SOURCE);

  for (const target of TARGETS) {
    const dest = path.join(ICONS_DIR, target.file);
    if (await isFresh(target)) continue;

    const png = await sharp(source)
      .resize(target.size, target.size, { fit: 'cover' })
      .png()
      .toBuffer();

    await writeFile(dest, png);
    console.log(`[icons] ${target.file} (${target.size}×${target.size})`);

    // favicon.ico переиспользует ровно тот же PNG, поэтому собирается вместе с
    // ним и не требует отдельного рендера.
    if (target.size === FAVICON.size) {
      await writeFile(path.join(ICONS_DIR, FAVICON.file), pngToIco(png, FAVICON.size));
      console.log(`[icons] ${FAVICON.file} (${FAVICON.size}×${FAVICON.size}, ICO из PNG)`);
    }
  }

  // favicon.ico собирается из уже существующего PNG: он мог остаться от
  // предыдущего прогона и быть новее SVG, поэтому проверяем его отдельно.
  if (!(await isFresh(FAVICON))) {
    try {
      const png = await readFile(path.join(ICONS_DIR, 'favicon-32.png'));
      await writeFile(path.join(ICONS_DIR, FAVICON.file), pngToIco(png, FAVICON.size));
      console.log(`[icons] ${FAVICON.file} (${FAVICON.size}×${FAVICON.size}, ICO из PNG)`);
    } catch {
      // favicon-32.png нет — значит, PNG ещё не сгенерирован, и подождёт
      // следующего прогона вместе с ним.
    }
  }

  if (!(await isFresh(MASKABLE))) {
    // Отступ задаётся ЦЕЛЫМ числом пикселей, и внутренний размер выводится из
    // него, а не наоборот. Иначе размер не сойдётся: extend добавляет отступ с
    // каждой из четырёх сторон, и при 512 - 307 = 205 (нечётное) половина
    // округляется вверх, давая 513×513 вместо заявленных в манифесте 512×512.
    // Chrome и Lighthouse отвергают maskable-иконку, чей размер не совпадает с
    // указанным в манифесте, — то есть установка на Android просто не пройдёт.
    const pad = Math.round(MASKABLE.size * MASKABLE.padding);
    const inner = MASKABLE.size - pad * 2;

    // flatten обязателен: исходник — «сквиркл» с прозрачными углами. Без
    // него маска Android показала бы их как дыры поверх залитого квадрата.
    const png = await sharp(source)
      .resize(inner, inner, { fit: 'contain', background: MASKABLE_BG })
      .flatten({ background: MASKABLE_BG })
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: MASKABLE_BG,
      })
      .png()
      .toBuffer();

    await writeFile(path.join(ICONS_DIR, MASKABLE.file), png);
    console.log(`[icons] ${MASKABLE.file} (${MASKABLE.size}×${MASKABLE.size}, maskable, отступ ${pad}px)`);
  }
}

main().catch((err) => {
  console.error('[icons] не удалось сгенерировать иконки:', err);
  process.exitCode = 1;
});
