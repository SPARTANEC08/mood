/**
 * /api/important — объявления группы.
 *
 * Как и с ДЗ: запись привязана к группе, чтение и запись идут через
 * group-scoped методы, внутри группы добавлять может любой одногруппник.
 */

import type { FastifyInstance } from 'fastify';

import { makeRecordId, safeErrorMessage } from '../../../tg/format.ts';
import { importantStore, type ImportantMessage } from '../../../db/storage/importantStore.ts';
import { requireBars } from '../middleware/auth.ts';
import { canAccessGroup, requireStudentGroup } from './studentContext.ts';
import type {
  ApiImportant,
  CreateImportantBody,
  ImportantResponse,
  UpdateImportantBody,
} from '../types.ts';
import { RecordFilesError, removedFiles, resolveOwnedFiles } from './recordFiles.ts';
import {
  canEditRecord,
  checkRecordRateLimit,
  dropRecordFiles,
  sendRateLimited,
} from './recordShared.ts';

const MAX_TITLE_LENGTH = 120;
const MAX_TEXT_LENGTH = 8000;

export async function registerImportantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/important', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const items: ApiImportant[] = importantStore.getForGroup(group.groupName).map<ApiImportant>(
      (msg: ImportantMessage) => ({
        id: msg.id,
        groupName: msg.groupName,
        title: msg.title,
        text: msg.text,
        authorName: msg.authorName,
        createdAt: msg.createdAt,
        files: msg.files ?? [],
        canEdit: canEditRecord(msg.authorId, student.userId),
      }),
    );

    const response: ImportantResponse = { items };
    return reply.send(response);
  });

  /**
   * Изменение заголовка и текста объявления своей группы.
   *
   * Запись обновляется в том же хранилище, что читает бот, поэтому правка
   * видна и в приложении, и в чате — отдельного состояния нет.
   * Чужая группа не имеет доступа: поиск идёт через getForGroupAndId.
   */
  app.patch('/api/important/:id', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const id = (request.params as { id?: string }).id ?? '';
    const existing = importantStore.getForGroupAndId(group.groupName, id);

    // Явная проверка прав в роуте, помимо фильтрации в хранилище: чужое
    // объявление не должно правиться даже при угаданном id — как и своё
    // одногруппником, который его не создавал.
    if (
      !existing ||
      !canAccessGroup(existing.groupName, group.groupName) ||
      !canEditRecord(existing.authorId, student.userId)
    ) {
      return reply.code(404).send({ error: 'not_found', message: 'Объявление не найдено.' });
    }

    const body = (request.body ?? {}) as Partial<UpdateImportantBody>;
    const title = body.title === undefined ? existing.title : body.title.trim();
    const text = body.text === undefined ? existing.text : body.text.trim();

    if (!title) {
      return reply.code(400).send({ error: 'bad_request', message: 'Заголовок не может быть пустым.' });
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Заголовок длиннее ${MAX_TITLE_LENGTH} символов.`,
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Текст длиннее ${MAX_TEXT_LENGTH} символов.`,
      });
    }

    let files = existing.files;
    try {
      if (body.fileIds !== undefined) {
        files = await resolveOwnedFiles(student.userId, body.fileIds);
      }
    } catch (err: unknown) {
      if (err instanceof RecordFilesError) {
        return reply.code(err.code).send({ error: 'bad_request', message: err.message });
      }
      throw err;
    }

    // Как и в ДЗ: объявление без текста нормально, если приложены файлы
    // («расписание на фото»), но пустое объявление без вложений бессмысленно.
    if (!text && files.length === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'В объявлении должно остаться хотя бы что-то: текст или файл.',
      });
    }

    importantStore.save({ ...existing, title, text, files });

    await dropRecordFiles(removedFiles(existing.files, files), '[API important]');

    return reply.send({ id, title, text, files });
  });

/**
   * Удаление объявления своей группы. Права те же, что и у ДЗ.
   */
  app.delete('/api/important/:id', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const id = (request.params as { id?: string }).id ?? '';

    // Явная проверка прав в роуте: чужой id и чужой автор дают 404, а не удаление.
    const target = importantStore.getForGroupAndId(group.groupName, id);
    if (
      !target ||
      !canAccessGroup(target.groupName, group.groupName) ||
      !canEditRecord(target.authorId, student.userId)
    ) {
      return reply.code(404).send({ error: 'not_found', message: 'Объявление не найдено.' });
    }

    const removed = importantStore.deleteForGroupAndId(group.groupName, id);

    if (!removed) {
      return reply.code(404).send({ error: 'not_found', message: 'Объявление не найдено.' });
    }

    // Файлы идут вместе с записью: без ссылок на них они только расходовали бы
    // квоту пользователя (см. такой же комментарий в routes/homework.ts).
    await dropRecordFiles(removed.files, '[API important]');

    return reply.send({
      id: removed.id,
      deleted: true,
    });
  });

  app.post('/api/important', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    // Антифлуд общий для ДЗ и «Важного»: окно — час (см. recordShared).
    const rate = checkRecordRateLimit(student.userId);
    if (rate.limited) {
      return sendRateLimited(
        reply,
        'Слишком много добавленных заданий и объявлений. Попробуйте позже.',
        rate.retryAfterMs,
      );
    }

    const body = (request.body ?? {}) as Partial<CreateImportantBody>;

    const title = (body.title ?? '').trim();
    const text = (body.text ?? '').trim();

    let files;
    try {
      files = await resolveOwnedFiles(student.userId, body.fileIds);
    } catch (err: unknown) {
      if (err instanceof RecordFilesError) {
        return reply.code(err.code).send({ error: 'bad_request', message: err.message });
      }
      throw err;
    }

    if (!title) {
      return reply.code(400).send({ error: 'bad_request', message: 'Укажите заголовок.' });
    }
    if (!text && files.length === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Введите текст объявления или прикрепите файл.',
      });
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Заголовок длиннее ${MAX_TITLE_LENGTH} символов.`,
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Текст длиннее ${MAX_TEXT_LENGTH} символов.`,
      });
    }

    try {
      const message: ImportantMessage = {
        id: makeRecordId('imp'),
        groupName: group.groupName,
        title,
        text,
        files,
        authorName:
          student.studentProfile?.fullName ?? [student.firstName, student.lastName].filter(Boolean).join(' '),
        authorId: student.userId,
        createdAt: new Date().toISOString(),
      };

      importantStore.save(message);

      return reply.code(201).send({
        id: message.id,
        title: message.title,
        createdAt: message.createdAt,
      });
    } catch (err: unknown) {
      console.error('[API important] не удалось создать объявление:', safeErrorMessage(err));
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Не удалось сохранить объявление.',
      });
    }
  });
}
