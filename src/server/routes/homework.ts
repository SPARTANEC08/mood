/**
 * /api/homework — домашние задания группы.
 *
 * Запись всегда принадлежит группе автора: чтение и запись идут через
 * group-scoped методы хранилища, поэтому чужая группа не видит ни чужих
 * заданий, ни файлов к ним.
 *
 * Права внутри группы не сужены: добавить задание может любой одногруппник,
 * как и в боте.
 */

import type { FastifyInstance } from 'fastify';

import { safeErrorMessage } from '../../bot/format.ts';
import { getCachedScheduleForUser } from './scheduleCacheBridge.ts';
import { homeworkStore, type LessonKindType, type HomeworkRecord } from '../../storage/homeworkStore.ts';
import { makeRecordId } from '../../bot/format.ts';
import { findNextLesson } from '../../bot/homeworkManager.ts';
import { requireBars } from '../middleware/auth.ts';
import { canAccessGroup, requireStudentGroup } from './studentContext.ts';
import type { ApiHomework, CreateHomeworkBody, HomeworkResponse, UpdateHomeworkBody } from '../types.ts';
import { RecordFilesError, removedFiles, resolveOwnedFiles } from './recordFiles.ts';
import { checkRecordRateLimit, dropRecordFiles, sendRateLimited } from './recordShared.ts';

/** Ограничение длины текста: защита от абсурдных payload и от спама в базу. */
const MAX_TEXT_LENGTH = 4000;

function isKind(value: unknown): value is LessonKindType {
  return value === 'lecture' || value === 'practice' || value === 'lab';
}

export async function registerHomeworkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/homework', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const query = (request.query ?? {}) as { from?: string };
    const from = /^\d{4}\.\d{2}\.\d{2}$/.test(query.from ?? '') ? query.from! : todayRaw();

    const items: ApiHomework[] = homeworkStore
      .getUpcoming(group.groupName, from)
      .map<ApiHomework>((hw) => ({
        id: hw.id,
        groupName: hw.groupName,
        discipline: hw.discipline,
        kind: hw.kind,
        targetDate: hw.targetDate,
        lessonNumber: hw.lessonNumber,
        timeStart: hw.timeStart,
        text: hw.text,
        authorName: hw.authorName,
        createdAt: hw.createdAt,
        files: hw.files ?? [],
      }));

    const response: HomeworkResponse = { items };
    return reply.send(response);
  });

  /**
   * Удаление ДЗ своей группы.
   *
   * Права внутри группы не сужены: удалить может любой одногруппник, как и в
   * боте. Чужая группа удалить не может — запись ищется через
   * getForGroupAndId, поэтому чужой id вернёт 404, а не удалит.
   */
  app.delete('/api/homework/:id', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const id = (request.params as { id?: string }).id ?? '';

    // Явная проверка прав в роуте, помимо фильтрации в хранилище: чужой id
    // обязан дать 404, а не удалить запись.
    const target = homeworkStore.getForGroupAndId(group.groupName, id);
    if (!target || !canAccessGroup(target.groupName, group.groupName)) {
      return reply.code(404).send({ error: 'not_found', message: 'Задание не найдено.' });
    }

    const removed = homeworkStore.deleteForGroupAndId(group.groupName, id);

    if (!removed) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Задание не найдено.',
      });
    }

    // Файлы удаляются вместе с записью. Иначе они остались бы на диске навсегда:
    // ссылок на них нет, но квота пользователя (500 МБ) расходуется, и через
    // semester приложение начало бы отказывать в загрузке «место закончилось».
    await dropRecordFiles(removed.files, '[API homework]');

    return reply.send({ id: removed.id, deleted: true });
  });

  app.post('/api/homework', async (request, reply) => {
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

    const body = (request.body ?? {}) as Partial<CreateHomeworkBody>;

    const discipline = (body.discipline ?? '').trim();
    const text = (body.text ?? '').trim();

    // Файлы разбираются ДО проверки текста: если прикрепление невалидно,
    // об этом честнее узнать сразу, а не после «не нашёл будущих занятий».
    let files;
    try {
      files = await resolveOwnedFiles(student.userId, body.fileIds);
    } catch (err: unknown) {
      if (err instanceof RecordFilesError) {
        return reply.code(err.code).send({ error: 'bad_request', message: err.message });
      }
      throw err;
    }

    if (!discipline) {
      return reply.code(400).send({ error: 'bad_request', message: 'Укажите предмет.' });
    }
    if (!isKind(body.kind)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Укажите тип занятия: lecture, practice или lab.',
      });
    }
    // Текст обязателен только когда нет файлов: «решение на фото» — нормальная
    // формулировка, и требовать текст ради текста значило бы заставлять человека
    // писать «см. файл» вместо нормального задания.
    if (!text && files.length === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Введите текст задания или прикрепите файл.',
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Текст задания длиннее ${MAX_TEXT_LENGTH} символов.`,
      });
    }

    try {
      // Задание привязывается к ближайшему будущему занятию выбранного предмета —
      // ровно та же логика, что и у бота, чтобы у задания не было двух разных
      // дедлайнов в двух интерфейсах.
      const schedule = await getCachedScheduleForUser(student);
      const lesson = findNextLesson(schedule, [discipline], body.kind);

      if (!lesson) {
        return reply.code(400).send({
          error: 'no_lesson',
          message: `Не нашёл будущих занятий по предмету «${discipline}» для вашей группы.`,
        });
      }

      const record: HomeworkRecord = {
        id: makeRecordId('hw'),
        groupName: group.groupName,
        discipline: lesson.variant.discipline,
        kind: body.kind,
        targetDate: lesson.day.rawDate,
        lessonNumber: lesson.slot.lessonNumber,
        timeStart: lesson.slot.timeStart,
        text,
        files,
        authorId: student.userId,
        authorName:
          student.studentProfile?.fullName ?? [student.firstName, student.lastName].filter(Boolean).join(' '),
        createdAt: new Date().toISOString(),
      };

      homeworkStore.save(record);

      return reply.code(201).send({
        id: record.id,
        targetDate: record.targetDate,
        lessonNumber: record.lessonNumber,
        discipline: record.discipline,
      });
    } catch (err: unknown) {
      console.error('[API homework] не удалось создать задание:', safeErrorMessage(err));
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Не удалось сохранить задание.',
      });
    }
  });

  /**
   * PATCH /api/homework/:id — правка задания своей группы.
   *
   * Предмет и тип занятия не меняются: по ним запись привязана к конкретной паре
   * в расписании, и смена дисциплины означала бы, что дата и номер пары больше
   * не соответствуют предмету. Меняются текст и состав файлов.
   *
   * fileIds — полный новый список: файлы, которые из него выпали, удаляются с
   * сервера, иначе они навсегда остались бы занимать квоту.
   */
  app.patch('/api/homework/:id', async (request, reply) => {
    const student = requireBars(request);
    const group = requireStudentGroup(student);

    const id = (request.params as { id?: string }).id ?? '';
    const existing = homeworkStore.getForGroupAndId(group.groupName, id);

    // Явная проверка прав в роуте (см. такой же комментарий в DELETE):
    // править можно только запись своей группы.
    if (!existing || !canAccessGroup(existing.groupName, group.groupName)) {
      return reply.code(404).send({ error: 'not_found', message: 'Задание не найдено.' });
    }

    const body = (request.body ?? {}) as Partial<UpdateHomeworkBody>;
    const text = body.text === undefined ? existing.text : body.text.trim();

    if (text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `Текст задания длиннее ${MAX_TEXT_LENGTH} символов.`,
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

    if (!text && files.length === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'В задании должно остаться хотя бы что-то: текст или файл.',
      });
    }

    homeworkStore.save({ ...existing, text, files });

    // Убранные из списка файлы удаляются с диска. Ошибка не фатальна: запись уже
    // сохранена и корректна, а «осиротевший» файл уберёт check:files.
    await dropRecordFiles(removedFiles(existing.files, files), '[API homework]');

    return reply.send({ id, text, files });
  });
}

/** Сегодня по Москве в формате YYYY.MM.DD. */
function todayRaw(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  return `${map.year}.${map.month}.${map.day}`;
}