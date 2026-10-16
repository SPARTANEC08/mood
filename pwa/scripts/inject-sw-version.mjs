/**
 * Подстановка версии в Service Worker.
 *
 * sw.js лежит в public/, поэтому Vite копирует его в dist как есть, без
 * обработки. Значит, плейсхолдер __SW_VERSION__ нужно заменить вручную — и
 * обязательно ПОСЛЕ сборки, потому что только на этом шаге известно, что
 * сборка вообще состоялась.
 *
 * Зачем это нужно: значение попадает в имена кэшей. Сменилась версия — имена
 * другие — старые кэши удаляются в activate, и пользователь получает новую
 * оболочку вместо залипшей старой.
 *
 * Почему правится только dist/sw.js, а не public/sw.js. Раньше скрипт менял
 * исходник на месте, и это ломало вторую сборку: плейсхолдер в public/ исчезал
 * навсегда, следующий vite build копировал уже подставленную (старую) версию,
 * и пользователь получал кэш предыдущей сборки — то есть обновление не
 * доезжало никогда. Исходник обязан оставаться с плейсхолдером, версия
 * подставляется в артефакт сборки на каждом запуске заново.
 *
 * Версия берётся из времени сборки в base36: это короче, читаемее и меняется
 * при каждом запуске. Для воспроизводимых сборок можно задать SOURCE_DATE_EPOCH
 * (тот же приём используется в vite.config.ts).
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PLACEHOLDER = '__SW_VERSION__';
const BUILT_SW = path.join(ROOT, 'dist/sw.js');

const version = (process.env.SOURCE_DATE_EPOCH ?? Date.now().toString(36)).toString(36);

async function main() {
  let content;
  try {
    content = await readFile(BUILT_SW, 'utf-8');
  } catch {
    console.error('[sw] не найден dist/sw.js — сначала выполните vite build.');
    process.exit(1);
  }

  if (!content.includes(PLACEHOLDER)) {
    // Так бывает, если public/sw.js когда-то был подправлен на месте и
    // плейсхолдера в нём больше нет. Это поломка исходника, а не повод
    // пропустить сборку молча: без версии SW не обновит кэш никогда.
    console.error(
      '[sw] в dist/sw.js нет плейсхолдера __SW_VERSION__.\n' +
        '     Вероятно, public/sw.js был изменён на месте. Верните в нём\n' +
        '     `const VERSION = \'__SW_VERSION__\';` и пересоберите.',
    );
    process.exit(1);
  }

  await writeFile(BUILT_SW, content.replaceAll(PLACEHOLDER, version), 'utf-8');
  console.log(`[sw] версия ${version} подставлена в dist/sw.js`);
}

main().catch((err) => {
  console.error('[sw] не удалось подставить версию:', err);
  process.exit(1);
});