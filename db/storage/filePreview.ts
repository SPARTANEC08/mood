/**
 * Превью изображений.
 *
 * Зачем. Фотография задания весит 2–4 МБ — это снимок с телефона, снятый прямо
 * на лекции. Показывать его в ленте целиком бессмысленно: карточка в ленте
 * занимает пол-экрана, а качать приходится мегабайты. Превю того же кадра в
 * 800 пикселей — это порядка 80 КБ, то есть в тридцать раз меньше трафика и
 * заметно меньше памяти телефона.
 *
 * Что считается превью. Только изображения из разрешённого списка MIME (jpeg,
 * png, webp, gif, heic, heif). PDF сюда не попадает осознанно: у него нет
 * такого превью, а рендерить первую страницу — это отдельная тяжёлая
 * зависимость ради одного случая. Для PDF клиент показывает обложку-заглушку.
 *
 * Где хранится. Рядом с оригиналом, `<fileId>.preview-<width>.jpg`. Файл
 * превью — производная величина: он пересоздаётся, если исходник изменился
 * (fileId всегда новый, поэтому на практике это не случается), и его можно
 * удалить в любой момент без последствий. Квота пользователя при этом НЕ
 * растёт: превью не считается файлом, и иначе фотография в 4 МБ, разложенная
 * на превью всех размеров, внезапно съедала бы заметную часть лимита.
 *
 * sharp грузится лениво. Он тяжёлый (собственный бинарник), а нужен только на
 * первом запросе превью и только для изображений — поэтому процесс бота,
 * который превью не запрашивал, платить за него не должен. Отсутствие sharp не
 * ломает ничего: маршрут отвечает 503, клиент берёт оригинал.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { FILES_ROOT } from './fileStore.ts';

/** Права как у остальных файлов хранилища: превью — тоже персональные данные. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Ширина превью по умолчанию: телефонный экран в CSS-пикселях, с запасом на 2x. */
export const DEFAULT_PREVIEW_WIDTH = 800;

/**
 * Границы ширины. Ниже 128 превью бессмысленно; 1200 — это карточка ~400 CSS-px
 * на экране 3x, дальше растёт только вес файла и время sharp на 1 vCPU.
 */
export const MIN_PREVIEW_WIDTH = 128;
export const MAX_PREVIEW_WIDTH = 1200;

/** Ограничение декодируемого изображения для защиты от пиксельных decompression bombs. */
const MAX_PREVIEW_INPUT_PIXELS = 40_000_000;

/** Качество JPEG: 80 — стандартный компромисс, на глаз неотличимо от 90. */
const PREVIEW_QUALITY = 80;

/** Расширения, которые sharp умеет читать сам. */
const IMAGE_MIME_RE = /^(image\/(jpeg|png|webp|gif|avif|heic|heif|tiff))$/i;

export class PreviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewUnavailableError';
  }
}

export function isPreviewable(mimeType: string | undefined): boolean {
  return IMAGE_MIME_RE.test((mimeType ?? '').split(';')[0].trim());
}

/** Приводит запрошенную ширину к допустимой. Мусор и отсутствие → умолчание. */
/**
 * Разрешённые ширины превью.
 *
 * Раньше принималось любое целое 128…1200 — это до 1073 файлов превью на одну
 * картинку, вне квоты, при сериализованном sharp. Теперь только четыре
 * варианта: всё остальное приводится к ближайшему.
 */
const ALLOWED_PREVIEW_WIDTHS = [200, 400, 800, 1200] as const;

export function normalizePreviewWidth(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_PREVIEW_WIDTH;

  const clamped = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(value)));

  return ALLOWED_PREVIEW_WIDTHS.reduce((best, width) =>
    Math.abs(width - clamped) < Math.abs(best - clamped) ? width : best,
  );
}

function userDir(userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Некорректный userId.');

  return path.join(FILES_ROOT, userId);
}

/** Имя файла превью: производная от оригинала, расширение всегда jpg. */
export function previewPath(userId: string, fileId: string, width: number): string {
  return path.join(userDir(userId), `${fileId}.preview-${width}.jpg`);
}

/**
 * Загруженный модуль sharp или null, если его нет.
 *
 * Кэш здесь не про скорость, а про то, чтобы при десяти параллельных запросах
 * превью модуль импортировался один раз.
 */
type SharpChain = {
  rotate(): SharpChain;
  resize(options: Record<string, unknown>): {
    jpeg(options: Record<string, unknown>): { toFile(path: string): Promise<unknown> };
  };
};

type SharpFactory = (input: string, options?: { limitInputPixels: number }) => SharpChain;

let sharpPromise: Promise<SharpFactory | null> | null = null;

/**
 * Достаёт фабрику из модуля sharp.
 *
 * Тип описан вручную, а не импортом из пакета: модуль грузится динамически и
 * может быть не установлен вовсе, поэтому статический импорт типов заставил бы
 * сборку падать там, где превью просто не нужно.
 *
 * Кэшируется именно промис, а не результат: если бы флаг «загружаем» ставился
 * до импорта, второй параллельный запрос превью успел бы увидеть его и вернуть
 * null — и картинка молча падала бы на оригинал, хотя sharp установлен.
 */
function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      try {
        const module = (await import('sharp')) as { default?: unknown };
        const candidate = (module as { default?: unknown }).default ?? module;
        return typeof candidate === 'function' ? (candidate as SharpFactory) : null;
      } catch {
        return null;
      }
    })();
  }

  return sharpPromise;
}

/**
 * Семафор на sharp: одна задача за раз.
 *
 * libvips под sharp поднимает собственный пул потоков, и несколько
 * одновременных превью (пользователь листает галерею фото) на одном vCPU
 * выедали бы процессор у API и нотификатора. Очередь из одной задачи убирает
 * всплеск: превью — операция фоновая, подождать её миллисекунды не страшно.
 */
let sharpQueue: Promise<unknown> = Promise.resolve();

function withSharpSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = sharpQueue.then(task, task);
  sharpQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Отдаёт готовое превью или делает его.
 *
 * Отсутствие файла превью на диске — не ошибка: он сделается и сохранится. Ошибка
 * в sharp или в самом изображении — ошибка: оригинал при этом цел, и клиент
 * должен откатиться на него.
 */
export async function getPreview(
  userId: string,
  fileId: string,
  width: number,
): Promise<{ path: string; cached: boolean }> {
  const target = previewPath(userId, fileId, width);

  const existing = await fs.stat(target).catch(() => null);
  if (existing?.isFile()) return { path: target, cached: true };

  const source = path.join(userDir(userId), `${fileId}.bin`);
  await fs.access(source);

  const factory = await loadSharp();
  if (!factory) {
    throw new PreviewUnavailableError('Модуль sharp не установлен.');
  }

  await fs.mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });

  // Рендер идёт через семафор: одна задача sharp за раз (см. withSharpSlot).
  await withSharpSlot(async () => {
    // Пишем во временный файл и переименовываем: два параллельных запроса
    // превью одного и того же файла не должны читать наполовину записанный jpg.
    const temp = `${target}.${process.pid}.tmp`;

    try {
      await factory(source, { limitInputPixels: MAX_PREVIEW_INPUT_PIXELS })
        .rotate()
        .resize({ width, withoutEnlargement: true, fit: 'inside' })
        .jpeg({ quality: PREVIEW_QUALITY, progressive: true })
        .toFile(temp);

      await fs.rename(temp, target);
      await fs.chmod(target, FILE_MODE).catch(() => {});
    } catch (err: unknown) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  });

  return { path: target, cached: false };
}
