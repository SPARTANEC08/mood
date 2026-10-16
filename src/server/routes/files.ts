/**
 * /api/files — файлы, загруженные студентами.
 *
 * Раньше здесь был ровно один маршрут: «отправь файл из записи в мой чат в
 * Telegram», потому что файлы лежали в закрытом канале, а приложение видело
 * только file_id. Теперь файлы лежат на диске сервера, и ПWA умеет с ними всё,
 * что умеет браузер: загрузить, посмотреть метаданные, скачать, удалить.
 *
 * Что здесь важно:
 *  - файл идентифицируется парой (userId, fileId), и каталог на диске тоже
 *    разделён по userId: чужая ссылка ведёт в чужой каталог, которого у
 *    запрашивающего просто нет;
 *  - запись ищется ТОЛЬКО в своей группе: идентификатор записи приходит от
 *    клиента и сам по себе ничего не доказывает;
 *  - имя файла приходит от клиента и используется только в Content-Disposition
 *    и в интерфейсе; на диск попадает сгенерированный UUID.
 */

import { randomUUID } from 'node:crypto';
import fs, { statSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  getPreview,
  isPreviewable,
  normalizePreviewWidth,
} from '../../storage/filePreview.ts';
import {
  deleteFile,
  enforceQuota,
  FileStoreError,
  getFile,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_RECORD,
  saveFile,
  type ServerFileRef,
} from '../../storage/fileStore.ts';
import { homeworkStore } from '../../storage/homeworkStore.ts';
import { importantStore } from '../../storage/importantStore.ts';
import { requireBars, requireUser } from '../middleware/auth.ts';
import { requireStudentGroup } from './studentContext.ts';

/**
 * Экранирование имени для Content-Disposition.
 *
 * RFC 6261 требует quoted-string для имён с пробелами и кириллицей; без
 * кавычек часть клиентов обрезает имя по первому пробелу, а кавычки внутри
 * самого имени сломали бы заголовок.
 */
function contentDisposition(name: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const safe = name.replace(/["\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Разбор заголовка Range.
 *
 * Поддерживается единственная форма, которую присылают браузеры и просмотрщики
 * pdf: `bytes=start-end` либо `bytes=start-` (до конца). Всё остальное
 * трактуется как «диапазон неприменим»: отдать 200 с целым файлом безопаснее,
 * чем угадывать intent клиента.
 */
function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  // «bytes=-500» — это последние 500 байт, а не диапазон от -500.
  if (rawStart === '') {
    if (rawEnd === '' || total === 0) return 'invalid';

    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return 'invalid';

    return { start: Math.max(0, total - length), end: total - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? total - 1 : Number(rawEnd);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= total || start > end) return 'invalid';

  return { start, end: Math.min(end, total - 1) };
}

/** Размер одного файла в мегабайтах — для текста отказа. */
function fileSizeMb(): number {
  return Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024);
}

/**
 * Превращает ошибку загрузки в ответ с понятным фронту кодом.
 *
 * Отдельно обрабатывается превышение потолка в @fastify/multipart: это не
 * FileStoreError, и без явной ветки ошибка ушла бы в 500. Потолок у разбора
 * потока и у saveFile один и тот же (MAX_FILE_SIZE_BYTES), поэтому текст
 * совпадает.
 */
function sendUploadError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof FileStoreError) {
    return reply.code(413).send({ error: 'file_rejected', message: err.message });
  }

  const statusCode = (err as { statusCode?: number }).statusCode;
  const code = (err as { code?: string | number }).code;

  // Ограничение числа файлов в запросе — ошибка клиента, а не размера.
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return reply
      .code(400)
      .send({ error: 'bad_request', message: 'В запросе должен быть ровно один файл.' });
  }

  if (statusCode === 413 || code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply
      .code(413)
      .send({ error: 'file_rejected', message: `Файл больше ${fileSizeMb()} МБ.` });
  }

  if (code === 400) {
    return reply.code(400).send({
      error: 'bad_request',
      message: 'В запросе должен быть ровно один корректно оформленный файл.',
    });
  }

  return reply.code(500).send({ error: 'upload_failed', message: 'Не удалось загрузить файл.' });
}

/** Файл принадлежит студенту и лежит в его группе. */function findAccessibleFile(
  groupName: string,
  fileId: string,
): { record: { files: ServerFileRef[] }; file: ServerFileRef } | null {
  const records = [
    ...homeworkStore.getForGroup(groupName).map((hw) => ({ files: hw.files ?? [], record: hw })),
    ...importantStore.getForGroup(groupName).map((msg) => ({ files: msg.files ?? [], record: msg })),
  ];

  for (const entry of records) {
    const file = entry.files.find((f) => f.fileId === fileId);
    if (file) return { record: entry.record, file };
  }

  return null;
}

/**
 * Отдаёт файл потоком, не роняя процесс при обрыве.
 *
 * Файлы крупные, и клиент часто уходит со страницы, не дождавшись конца
 * скачивания. Тогда read stream получает EPIPE/ERR_STREAM_PREMATURE_CLOSE; у
 * потока без слушателя 'error' Node выбрасывает исключение ВНЕ обработчика — это
 * uncaught и падение всего процесса (бота и API вместе). Поэтому слушатель
 * обязателен: рвём соединение, но процесс живёт.
 */
function streamFile(
  reply: FastifyReply,
  filePath: string,
  options?: { start?: number; end?: number },
): unknown {
  const stream = fs.createReadStream(filePath, options);

  stream.on('error', () => {
    try {
      reply.raw.destroy();
    } catch {
      // Соединение уже закрыто — ничего делать не нужно.
    }
  });

  return reply.send(stream);
}

/**
 * Отдаёт содержимое файла с поддержкой Range.
 *
 * Общая точка для скачивания (attachment) и «открыть в Safari» (inline): статусы
 * и заголовки совпадают с прежним GET /api/files/:fileId, кроме вида
 * Content-Disposition. inline нужен, чтобы iOS показал нативный просмотрщик, а
 * не начал скачивать файл во внутреннюю папку.
 */
function sendFile(
  reply: FastifyReply,
  found: { path: string; meta: ServerFileRef },
  disposition: 'inline' | 'attachment',
  rangeHeader: string | undefined,
): unknown {
  const total = found.meta.size;
  const range = parseRange(rangeHeader, total);

  reply.header('Content-Type', found.meta.mimeType);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', contentDisposition(found.meta.originalName, disposition));
  // Для inline не кэшируем: share-ссылка короткоживущая, и Safari не должен
  // переоткрывать её из кэша после истечения TTL.
  reply.header('Cache-Control', disposition === 'inline' ? 'private, no-store' : 'private, max-age=31536000, immutable');

  // Заголовок nosniff обязателен: без него браузер может угадать тип по
  // содержимому и исполнить файл как скрипт от имени приложения.
  reply.header('X-Content-Type-Options', 'nosniff');

  if (range === 'invalid') {
    reply.header('Content-Range', `bytes */${total}`);
    return reply.code(416).send({ error: 'range_not_satisfiable', message: 'Диапазон вне файла.' });
  }

  if (range) {
    const length = range.end - range.start + 1;
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    reply.header('Content-Length', String(length));
    return streamFile(reply, found.path, { start: range.start, end: range.end });
  }

  reply.header('Content-Length', String(total));
  return streamFile(reply, found.path);
}

/**
 * Короткоживущие ссылки на файл для открытия в Safari из standalone-PWA.
 *
 * В установленном PWA нельзя отдать blob-URL в Safari (он его не открывает как
 * навигацию), а PWA-токен в URL светить нежелательно. Поэтому сервер по запросу
 * с обычной авторизацией выдаёт одноразово-ограниченный токен, вшитый в URL:
 * его можно открыть в Safari без заголовка X-PWA-Token.
 *
 * Хранится только в памяти процесса (как и незавершённые входы), привязан к
 * userId + fileId, живёт недолго и не пишется в журнал.
 */
const SHARE_TTL_MS = 5 * 60 * 1000;

/**
 * Сколько раз можно открыть ссылку. Не «строго один раз»: Safari открывает PDF
 * несколькими запросами (первый и затем Range), и одноразовость ломала бы
 * нативный просмотр PDF. Лимит защищает от перебора, TTL — от долгого хранения.
 */
const SHARE_MAX_USES = 20;

interface ShareEntry {
  userId: string;
  fileId: string;
  expiresAt: number;
  usesLeft: number;
}

const shareTokens = new Map<string, ShareEntry>();

function createShareToken(userId: string, fileId: string): { token: string; expiresAt: number } {
  const token = randomUUID();
  const expiresAt = Date.now() + SHARE_TTL_MS;
  shareTokens.set(token, { userId, fileId, expiresAt, usesLeft: SHARE_MAX_USES });
  return { token, expiresAt };
}

/** Проверяет и «тратит» попытку. Возвращает null, если ссылка мертва. */
function takeShareToken(token: string): ShareEntry | null {
  const entry = shareTokens.get(token);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    shareTokens.delete(token);
    return null;
  }

  entry.usesLeft -= 1;
  if (entry.usesLeft <= 0) shareTokens.delete(token);
  return entry;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // Уборка протухших share-ссылок, чтобы карта не росла. Раз в минуту, unref —
  // таймер не должен удерживать процесс.
  const shareCleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of shareTokens) {
      if (now > entry.expiresAt) shareTokens.delete(token);
    }
  }, 60 * 1000);
  shareCleanup.unref?.();

  /**
   * POST /api/files/:fileId/share — короткоживущая ссылка на файл для открытия
   * в Safari из standalone-PWA.
   *
   * Авторизация обычная (PWA-токен): ссылку выдаём только владельцу файла.
   * Возвращаем путь, а не абсолютный URL: клиент достраивает его от своего
   * origin, поэтому ссылка всегда ведёт на тот же домен, что и приложение.
   */
  app.post('/api/files/:fileId/share', async (request, reply) => {
    const student = requireUser(request);
    const { fileId } = request.params as { fileId: string };

    const found = await getFile(student.userId, fileId);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден.' });
    }

    const { token, expiresAt } = createShareToken(student.userId, fileId);
    return reply.send({ path: `/api/files/share/${token}`, expiresAt });
  });

  /**
   * GET /api/files/share/:token — выдача файла по короткоживущей ссылке.
   *
   * Публичный маршрут (без X-PWA-Token): токен и есть авторизация. Отдаём файл
   * inline, чтобы iOS показал нативный просмотрщик. Мёртвая ссылка → 410.
   */
  app.get('/api/files/share/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const entry = takeShareToken(token);
    if (!entry) {
      return reply
        .code(410)
        .type('text/plain; charset=utf-8')
        .send('Ссылка на файл истекла. Вернитесь в приложение и откройте файл заново.');
    }

    const found = await getFile(entry.userId, entry.fileId);
    if (!found) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('Файл больше недоступен.');
    }

    return sendFile(reply, found, 'inline', request.headers.range);
  });

  /**
   * POST /api/files/upload — загрузка файла.
   *
   * multipart с полем file. Файл принимается, пока он не привязан к записи:
   * отправлять его дальше (в ДЗ или объявление) — уже записьм.
   */
  app.post('/api/files/upload', async (request, reply) => {
    const student = requireBars(request);
    const userId = student.userId;

    if (!request.isMultipart()) {
      return reply.code(415).send({
        error: 'bad_request',
        message: 'Файл нужно отправить как multipart/form-data.',
      });
    }

    // Квота проверяется ДО чтения потока: если места нет, клиент не должен
    // тратить трафик на загрузку десятков мегабайт, которые сервер всё равно
    // отклонит. Вторая проверка — в saveFile, уже на реальный размер.
    try {
      await enforceQuota(userId);
    } catch (err: unknown) {
      if (err instanceof FileStoreError && err.code === 'quota') {
        return reply.code(413).send({ error: 'file_rejected', message: err.message });
      }
      throw err;
    }

    let uploaded: ServerFileRef | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (uploaded) {
            // Второй файл в одном запросе — ошибка клиента, а не повод
            // молча взять первый и забыть второй.
            throw Object.assign(new Error('В запросе должен быть ровно один файл.'), { code: 400 });
          }

          const buffer = await part.toBuffer();
          uploaded = await saveFile(userId, buffer, part.filename, part.mimetype, userId);
        }
      }
    } catch (err: unknown) {
      return sendUploadError(reply, err);
    }

    if (!uploaded) {
      return reply.code(400).send({ error: 'bad_request', message: 'Файл не получен.' });
    }

    return reply.send({ file: uploaded });
  });

  /**
   * GET /api/files/:fileId — скачивание.
   *
   * Cache-Control immutable: содержимое файла не меняется никогда (новое
   * загруженное получает новый fileId), поэтому кэшировать год безопасно.
   * private — потому что файл закрыт и общий кэш прокси его бы у всех
   * раздал.
   *
   * Поддержка Range обязательна не для удобства, а для корректности: без неё
   * Safari не показывает pdf и видео в просмотрщике, а мобильный Safari при
   * попытке открыть файл просто скачивает его. Браузер шлёт `Range: bytes=0-`,
   * и без ответа 206 он повторяет запрос с нуля — файл в 20 МБ грузится
   * целиком каждый раз.
   */
  app.get('/api/files/:fileId', async (request, reply) => {
    /*
     * Здесь requireUser, а НЕ requireBars — и это единственное место в маршрутах,
     * где такая разница важна.
     *
     * Раньше стоял requireBars, и это означало ровно то, что человек описывает:
     * фотографии вложений переставали грузиться ВСЕ, как только истекала сессия
     * БАРС. Файл от этого не перестаёт быть его собственным — он лежит в
     * `data/files/<userId>/` и адресуется по `student.userId`, то есть сессии
     * БАРС для доступа к нему не нужно ровно никак.
     *
     * Права при этом не расширяются: `getFile(userId, fileId)` ищет файл внутри
     * каталога ВЛАДЕЛЬЦА, и каталога чужого человека у запрашивающего просто
     * нет. requireBars отсекал не чужого, а собственного — на время сессии БАРС.
     */
    const student = requireUser(request);
    const { fileId } = request.params as { fileId: string };

    const found = await getFile(student.userId, fileId);

    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден.' });
    }

    return sendFile(reply, found, 'attachment', request.headers.range);
  });

  /**
   * GET /api/files/:fileId/preview?w=800 — уменьшенная копия изображения.
   *
   * Существует ради одного: фотография задания весит 2–4 МБ, а в ленте
   * занимает пол-экрана. Превю в 800 пикселей — это десятки килобайт вместо
   * мегабайтов, и лента перестаёт ждать сеть.
   *
   * Авторизация та же, что у скачивания (requireUser): файл принадлежит
   * владельцу, превью лежит в его же каталоге.
   *
   * Отказов три, и все они означают одно и то же для клиента — «бери
   * оригинал»: 404 (файла нет), 415 (это не изображение, например PDF) и 503
   * (sharp не установлен или изображение нечитаемо).
   */
  app.get('/api/files/:fileId/preview', async (request, reply) => {
    const student = requireUser(request);
    const { fileId } = request.params as { fileId: string };
    const { width } = request.query as { width?: string; w?: string };

    const found = await getFile(student.userId, fileId);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден.' });
    }

    if (!isPreviewable(found.meta.mimeType)) {
      return reply.code(415).send({
        error: 'not_previewable',
        message: 'Для этого типа файла превью не делается.',
      });
    }

    const size = normalizePreviewWidth(width ?? (request.query as { w?: string }).w);

    try {
      const { path: preview, cached } = await getPreview(student.userId, fileId, size);

      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');

      const stat = statSync(preview);
      reply.header('Content-Length', String(stat.size));
      // Превентивно: сколько заняло и был ли файл уже готов. Из одного клиента
      // превью обычно берётся повторно при каждом открытии ленты.
      if (cached) reply.header('X-Preview-Cache', 'hit');

      return streamFile(reply, preview);
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : 'unknown';
      console.warn('[Files] превью не построено:', errorName);

      return reply.code(503).send({
        error: 'preview_unavailable',
        message: 'Превью построить не удалось, откройте оригинал.',
      });
    }
  });

  /** GET /api/files/:fileId/meta — метаданные без скачивания содержимого. */
  app.get('/api/files/:fileId/meta', async (request, reply) => {
    const student = requireUser(request);
    const { fileId } = request.params as { fileId: string };

    const found = await getFile(student.userId, fileId);

    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден.' });
    }

    return reply.send({ file: found.meta });
  });

  /**
   * DELETE /api/files/:fileId — удаление.
   *
   * Отказ, если файл привязан к записи: иначе запись осталась бы со ссылкой
   * на то, чего больше нет, и приложение показывало бы битую иконку.
   */
  app.delete('/api/files/:fileId', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);
    const { fileId } = request.params as { fileId: string };

    const referenced = findAccessibleFile(group.groupName, fileId);

    if (referenced) {
      return reply.code(409).send({
        error: 'file_in_use',
        message: 'Файл прикреплён к записи. Удалите его оттуда, и он исчезнет здесь.',
      });
    }

    const removed = await deleteFile(student.userId, fileId);

    if (!removed) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден.' });
    }

    return reply.send({ ok: true });
  });
}

/** Потолки, которые клиент показывает до загрузки, чтобы не гадать заранее. */
export const FILE_LIMITS = {
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  maxFilesPerRecord: MAX_FILES_PER_RECORD,
} as const;

/** Путь к файлу — используется ботом при отправке файла в чат. */
export function filePathFor(userId: string, fileId: string): string {
  return path.join(process.cwd(), 'data', 'files', userId, `${fileId}.bin`);
}
