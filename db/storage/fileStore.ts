import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getDiskUsage, MIN_FREE_DISK_BYTES } from '../../backend/services/maintenance/cleanup.ts';

/**
 * Хранилище файлов на диске.
 *
 * Раньше файлы лежали в закрытом Telegram-канале, а в базе хранился только
 * file_id. Схема не выдержала двух вещей: file_id — это не файл, а ссылка,
 * которая протухает, и она же видна всем, кто состоит в канале. Кроме того,
 * канал требовал, чтобы у каждого пользователя был Telegram — а вход в PWA
 * теперь есть логин/пароль БАРС, без Telegram вообще.
 *
 * Теперь файл лежит в db/data/files/<userId>/<fileId>.bin рядом с метаданными
 * в <fileId>.meta.json, а в записях лежит только ссылка ServerFileRef.
 *
 * Разделение по userId в пути — это граница доступа на уровне файловой
 * системы: даже при ошибке в проверке прав чужой файл физически находится в
 * другом каталоге и не достаётся предсказуемым fileId.
 */

const FILES_DIR = path.resolve(process.cwd(), 'db', 'data', 'files');

/** Права: каталоги 0700, файлы 0600 — к файлам доступ только у владельца процесса. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Один файл: 20 МБ. Задания — это фотографии и pdf, а не видео. */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Файлов на одну запись: больше десяти человек всё равно не прикладывает. */
export const MAX_FILES_PER_RECORD = 10;

/** Объём на пользователя: 500 МБ с запасом на семестр. */
/**
 * Квота файлов на пользователя.
 *
 * 100 МБ вместо прежних 500: при 500 DAU и диске 10 ГБ пятьсот мегабайт на
 * человека — это 250 ГБ, которые не влезут даже если файлами пользуется каждый
 * десятый. 100 МБ — это ~5 PDF по 20 МБ или десятки фото конспектов, то есть
 * с запасом покрывает ДЗ и «Важное». Реальный рост всё равно ограничен сверху
 * (500 × 100 МБ = 50 ГБ), поэтому дополнительно работает ежедневная уборка и
 * отказ при < 1 ГБ свободного места.
 */
export const MAX_USER_STORAGE_BYTES = 100 * 1024 * 1024;

/**
 * Разрешённые типы файлов.
 *
 * Это осознанно узкий список, а не «любой MIME». На сервере лежат файлы,
 * ссылками на которые делятся однокурсники, поэтому исполняемое и html в
 * браузере опасны: без проверки типа загруженный .html отдавался бы с тем же
 * Origin, что и приложение. Документы, которые студент реально сдаёт, —
 * картинки и PDF — в списке есть.
 */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
]);

/** Допустимые соответствия MIME ↔ расширение; одной стороны недостаточно. */
const MIME_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.png': new Set(['image/png']),
  '.webp': new Set(['image/webp']),
  '.gif': new Set(['image/gif']),
  '.heic': new Set(['image/heic', 'image/heif']),
  '.heif': new Set(['image/heic', 'image/heif']),
  '.pdf': new Set(['application/pdf']),
  '.txt': new Set(['text/plain']),
};

/** Ссылка на файл в записях ДЗ и объявлений. */
export interface ServerFileRef {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
}

interface FileMeta extends ServerFileRef {}

export class FileStoreError extends Error {
  constructor(message: string, readonly code:
    | 'too_large' | 'bad_type' | 'quota' | 'not_found' | 'bad_name' = 'bad_name') {
    super(message);
    this.name = 'FileStoreError';
  }
}

/**
 * UUID: имя файла приходит из проверки, а не из клиента.
 *
 * Даже при полном контроле входа имя файла нельзя брать от клиента: в нём
 * возможны «..», слеши и управляющие символы. Свой идентификатор снимает
 * вопрос целиком, а не по частям.
 */
function isSafeId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

function userDir(userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new FileStoreError('Некорректный userId.', 'bad_name');
  }
  return path.join(FILES_DIR, userId);
}

/**
 * Приводит имя файла к безопасному виду.
 *
 * Имя показывается в интерфейсе, поэтому оно должно остаться читаемым, но
 * без путей и управляющих символов: иначе оно попадёт в Content-Disposition
 * и в имя файла при скачивании.
 */
export function sanitizeFileName(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\x00-\x1F\x7F]/g, '').replace(/["\\]/g, '').slice(0, 120);

  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * Проверяет, что такой тип файла можно принимать.
 *
 * Проверяются обе стороны: MIME из заголовка и расширение. Браузер шлёт то,
 * что сам знает, поэтому одного заголовка мало — файл с чужим содержимым
 * пришёл бы с именем photo.jpg и заголовком image/jpeg.
 */
function normalizeMimeType(mimeType: string): string {
  return String(mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function assertAllowedType(mimeType: string, fileName: string): void {
  const ext = path.extname(fileName).toLowerCase();
  const normalizedMimeType = normalizeMimeType(mimeType);
  const allowedForExtension = MIME_BY_EXTENSION[ext];

  if (!ALLOWED_MIME_TYPES.has(normalizedMimeType) || !allowedForExtension?.has(normalizedMimeType)) {
    throw new FileStoreError('Такой тип файла загружать нельзя.', 'bad_type');
  }
}

/** Проверяет сигнатуру бинарных типов: MIME и имя файла задаёт сам клиент. */
function assertContentMatchesMime(buffer: Buffer, mimeType: string): void {
  const startsWith = (signature: number[]) =>
    buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);

  let matches = true;
  switch (mimeType) {
    case 'image/jpeg':
      matches = startsWith([0xff, 0xd8, 0xff]);
      break;
    case 'image/png':
      matches = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      break;
    case 'image/webp':
      matches = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
      break;
    case 'image/gif':
      matches = buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a';
      break;
    case 'image/heic':
    case 'image/heif': {
      const brands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
      matches = buffer.length >= 12
        && buffer.toString('ascii', 4, 8) === 'ftyp'
        && brands.has(buffer.toString('ascii', 8, 12));
      break;
    }
    case 'application/pdf':
      matches = buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
      break;
    case 'text/plain':
      // Text is served as text/plain with nosniff; it has no binary signature.
      return;
  }

  if (!matches) {
    throw new FileStoreError('Содержимое не соответствует типу файла.', 'bad_type');
  }
}

async function ensureUserDir(userId: string): Promise<string> {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE);
  return dir;
}

/**
 * Кэш занятого объёма по пользователю.
 *
 * Зачем. Раньше getUserStorageUsage обходил каталог (readdir + stat на каждый
 * .bin) на КАЖДОМ POST /api/files/upload — O(числа файлов) на загрузку. Квота в
 * 500 МБ позволяет сотни файлов на человека, и обход становился заметным.
 *
 * Формат на диске при этом НЕ меняется: счётчик живёт только в памяти процесса
 * и обновляется инкрементально при записи/удалении. TTL ограничивает
 * расхождение, если файл изменили в обход процесса (вручную, бэкапом).
 */
const USAGE_TTL_MS = 60_000;
const usageCache = new Map<string, { bytes: number; computedAt: number }>();

function perfLog(message: string): void {
  if (process.env.API_PERF_LOG === '1') console.log(`[fileStore] ${message}`);
}

/** Полный обход каталога: единственный источник истины о занятом объёме. */
async function computeStorageUsage(userId: string): Promise<number> {
  const dir = userDir(userId);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.bin')) continue;
    try {
      total += (await fs.stat(path.join(dir, entry))).size;
    } catch {
      // файл мог исчезнуть между readdir и stat — не считаем
    }
  }

  return total;
}

/** Суммарный объём файлов пользователя (из кэша; при промахе или протухании — обходом). */
export async function getUserStorageUsage(userId: string): Promise<number> {
  const cached = usageCache.get(userId);
  const now = Date.now();

  if (cached && now - cached.computedAt < USAGE_TTL_MS) return cached.bytes;

  const bytes = await computeStorageUsage(userId);
  if (cached && cached.bytes !== bytes) {
    perfLog(`расхождение кэша объёма: ${userId} ${cached.bytes} → ${bytes}`);
  }
  usageCache.set(userId, { bytes, computedAt: Date.now() });
  return bytes;
}

/** Сдвигает кэш объёма после записи файла. Отсутствующую запись не создаёт. */
function bumpUsage(userId: string, delta: number): void {
  const cached = usageCache.get(userId);
  if (!cached) return; // посчитается обходом при следующем запросе
  cached.bytes = Math.max(0, cached.bytes + delta);
  cached.computedAt = Date.now();
}

/** Забывает кэш объёма — при удалении файлов значение пересчитается обходом. */
function invalidateUsage(userId: string): void {
  usageCache.delete(userId);
}

/**
 * Проверяет, влезает ли файл в квоту.
 *
 * Считается ДО записи: превышение квоты обнаруживалось бы уже на записанном
 * файле, и лишние байты остались бы на диске до следующей уборки.
 */
export async function enforceQuota(userId: string, maxBytes: number = MAX_USER_STORAGE_BYTES): Promise<void> {
  let used = await getUserStorageUsage(userId);

  // Кэш мог переоценить занятое (файл удалили в обход API): перед отказом
  // сверяемся с диском напрямую, чтобы не блокировать загрузку устаревшим
  // значением. При реальном превышении обход просто подтвердит отказ.
  if (used + MAX_FILE_SIZE_BYTES > maxBytes) {
    used = await computeStorageUsage(userId);
    usageCache.set(userId, { bytes: used, computedAt: Date.now() });
  }

  if (used + MAX_FILE_SIZE_BYTES > maxBytes) {
    throw new FileStoreError(
      `Закончилось место: занято ${Math.round(used / 1024 / 1024)} МБ из ${Math.round(maxBytes / 1024 / 1024)} МБ.`,
      'quota',
    );
  }
}

/**
 * Сохраняет файл и возвращает ссылку на него.
 *
 * Порядок проверок именно такой: тип, размер, квота, запись. Сама запись
 * идёт во временный файл с последующим переименованием — иначе обрыв записи
 * (сеть, сигнал) оставил бы в каталоге обрезанный файл, который в базу не
 * попал бы и который пришлось бы искать и удалять вручную.
 */
export async function saveFile(
  userId: string,
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  uploadedBy: string = userId,
): Promise<ServerFileRef> {
  const name = sanitizeFileName(originalName);
  const normalizedMimeType = normalizeMimeType(mimeType);

  assertAllowedType(normalizedMimeType, name);

  if (buffer.length === 0) {
    throw new FileStoreError('Файл пустой.', 'too_large');
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new FileStoreError(
      `Файл больше ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} МБ.`,
      'too_large',
    );
  }

  assertContentMatchesMime(buffer, normalizedMimeType);

  // Свободное место на диске важнее пользовательской квоты: если кончилось
  // ВСЁ место, не поможет и квота 100 МБ. Отказываем заранее, с понятным
  // текстом, а не падаем на записи.
  const disk = await getDiskUsage(FILES_DIR);
  if (disk && disk.freeBytes < MIN_FREE_DISK_BYTES) {
    throw new FileStoreError(
      `На сервере закончилось место (свободно ${Math.round(disk.freeBytes / 1024 / 1024)} МБ). Попробуйте позже.`,
      'quota',
    );
  }

  await enforceQuota(userId);

  const dir = await ensureUserDir(userId);
  const fileId = crypto.randomUUID();
  const target = path.join(dir, `${fileId}.bin`);
  const temp = `${target}.tmp`;

  await fs.writeFile(temp, buffer, { mode: FILE_MODE });
  await fs.rename(temp, target);

  // Кэш объёма сдвигается сразу после появления .bin — счёт идёт по ним.
  bumpUsage(userId, buffer.length);

  const meta: ServerFileRef = {
    fileId,
    originalName: name,
    mimeType: normalizedMimeType,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, `${fileId}.meta.json`), JSON.stringify(meta, null, 2), {
    mode: FILE_MODE,
  });

  return meta;
}

/** Читает файл и его метаданные. */
export async function getFile(
  userId: string,
  fileId: string,
): Promise<{ path: string; meta: FileMeta } | null> {
  if (!isSafeId(fileId)) return null;

  const dir = userDir(userId);
  const filePath = path.join(dir, `${fileId}.bin`);
  const metaPath = path.join(dir, `${fileId}.meta.json`);

  try {
    // mkdir({mode}) does not update an existing directory's permissions.
    await fs.chmod(dir, DIR_MODE);
    const [stat, raw] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(metaPath, 'utf-8'),
    ]);

    if (!stat.isFile()) return null;

    return { path: filePath, meta: JSON.parse(raw) as FileMeta };
  } catch {
    return null;
  }
}

/** Удаляет файл вместе с метаданными. */
export async function deleteFile(userId: string, fileId: string): Promise<boolean> {
  if (!isSafeId(fileId)) return false;

  const dir = userDir(userId);

  try {
    await fs.rm(path.join(dir, `${fileId}.bin`), { force: true });
    await fs.rm(path.join(dir, `${fileId}.meta.json`), { force: true });
    // Объём изменился — кэш пересчитается обходом при следующей загрузке.
    invalidateUsage(userId);
    return true;
  } catch {
    return false;
  }
}

/** Удаляет всё содержимое каталога пользователя. */
export async function deleteAllFiles(userId: string): Promise<void> {
  try {
    await fs.rm(userDir(userId), { recursive: true, force: true });
  } catch {
    // каталога нет — считаем, что удалять нечего
  }
  invalidateUsage(userId);
}

/**
 * Переносит файл из Telegram в файловое хранилище.
 *
 * Вызывается из бота: раньше он копировал сообщение в канал-хранилище, теперь
 * вместо копирования получает содержимое через Bot API и кладёт на диск. Имя
 * и тип берутся из file_id-префикса Telegram, потому что сам файл приходит без
 * них.
 */
export async function saveTelegramFile(
  userId: string,
  fileId: string,
  originalName: string,
  mimeType: string,
  uploadedBy: string = userId,
): Promise<ServerFileRef> {
  // Импорт внутри функции: telegramService тянет сюда fileStore, и наоборот.
  // Статический импорт дал бы цикл, который Node раскручивает, но Vite-скрипты
  // и esbuild — уже нет.
  const { downloadTelegramFile } = await import('../../tg/telegramFileDownload.ts');
  const buffer = await downloadTelegramFile(fileId);

  return saveFile(userId, buffer, originalName, mimeType, uploadedBy);
}

/** Корневой каталог хранилища — нужен скрипту сброса базы. */
export const FILES_ROOT = FILES_DIR;
