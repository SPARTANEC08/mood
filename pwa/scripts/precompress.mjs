/**
 * Предварительное сжатие статики.
 *
 * Зачем. На проде 1 vCPU, и nginx с `gzip_comp_level 6` жмёт ~300 КБ JS на
 * каждый запрос: 10–20 мс CPU на файл, умноженные на всех посетителей после
 * релиза. Здесь тот же gzip делается один раз на сборке, а nginx с
 * `gzip_static on` просто отдаёт готовый .gz — без затрат CPU.
 *
 * Формат: рядом с `app.js` появляется `app.js.gz`. Nginx сам выбирает файл по
 * заголовку Accept-Encoding; если .gz нет — падает на обычный gzip.
 *
 * Запускается после vite build и inject-sw-version.
 */

import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Что сжимать. Остальное (png, jpg, woff2) уже сжато. */
const EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt']);

/** Ниже этого размера gzip только добавляет заголовок и файл. */
const MIN_BYTES = 1024;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }

  return files;
}

async function main() {
  let files;
  try {
    files = await walk(DIST);
  } catch {
    console.error('[precompress] dist не найден — сначала vite build.');
    process.exit(1);
  }

  let raw = 0;
  let packed = 0;
  let count = 0;

  for (const file of files) {
    if (file.endsWith('.gz')) continue;
    if (!EXTENSIONS.has(path.extname(file))) continue;

    const info = await stat(file);
    if (info.size < MIN_BYTES) continue;

    const source = await readFile(file);
    // Level 9: сборка не критична по времени, а экономия на мобильном трафике
    // важнее пары секунд CI.
    const compressed = gzipSync(source, { level: 9 });

    // Сжатие «в минус» (уже сжатый JSON) не публикуем.
    if (compressed.length >= source.length) continue;

    await writeFile(`${file}.gz`, compressed);
    raw += source.length;
    packed += compressed.length;
    count += 1;
  }

  const saved = raw > 0 ? Math.round((1 - packed / raw) * 100) : 0;
  console.log(
    `[precompress] ${count} файлов: ${Math.round(raw / 1024)} КБ → ${Math.round(packed / 1024)} КБ (−${saved}%)`,
  );
}

await main();
