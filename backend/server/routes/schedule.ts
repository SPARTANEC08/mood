/**
 * /api/schedule — расписание группы студента.
 *
 * Отдаёт уже разобранное расписание из кэша (scheduleCache), обогащённое
 * привязанным ДЗ. Кэш здесь важен: приложение открывает этот эндпоинт чаще
 * всего, а ходить в ts.mpei.ru на каждый тап нельзя.
 */

import type { FastifyInstance } from 'fastify';

import { clearScheduleCache, getGroupSchedule } from '../../scheduleCache.ts';
import { safeErrorMessage } from '../../../tg/format.ts';
import { homeworkStore, type LessonKindType } from '../../../db/storage/homeworkStore.ts';
import type { ParsedLessonVariant, ParsedSchedule } from '../../parser/types.ts';
import { requireBars, requireScheduleAccess } from '../middleware/auth.ts';
import type {
  ApiLessonHomework,
  ApiLessonKind,
  ApiLessonSlot,
  ApiLessonVariant,
  ApiScheduleDay,
  ScheduleResponse,
} from '../types.ts';
import { requireStudentGroup } from './studentContext.ts';

/**
 * Приводит «Лекция» / «Практическое занятие» / «Лабораторная работа»
 * к трём значениям, которые понимает фронтенд для цвета бейджа.
 */
function normalizeKind(kindOfWork: string): ApiLessonKind {
  const raw = (kindOfWork || '').toLowerCase();
  if (raw.includes('лаб')) return 'lab';
  if (raw.includes('лек')) return 'lecture';
  return 'practice';
}

/** Преподаватель в компактном виде; БАРС/МЭИ иногда отдают пустую строку. */
function safeText(value: string | undefined, fallback = ''): string {
  return (value ?? '').trim() || fallback;
}

export async function registerScheduleRoutes(app: FastifyInstance): Promise<void> {
/**
 * /api/subjects — все дисциплины из расписания группы.
 *
 * Нужны для формы добавления ДЗ: брать предметы из уже существующих заданий
 * нельзя — тогда предмет, по которому ещё никто ничего не добавлял, в списке
 * отсутствовал бы и его нельзя было бы выбрать. Берём прямо из расписания.
 */
app.get('/api/subjects', async (request, reply) => {
  const student = requireBars(request);
  const group = requireStudentGroup(student);

  try {
    const schedule = await getGroupSchedule(group.groupId, group.groupName, student.faculty);

    // Порядок — как в расписании, повторы убираем.
    const seen = new Set<string>();
    const items: string[] = [];

    for (const day of schedule.days) {
      for (const slot of day.slots) {
        for (const variant of slot.variants) {
          const name = (variant.discipline || '').trim();
          if (name === '') continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(name);
        }
      }
    }

    items.sort((a, b) => a.localeCompare(b, 'ru'));

    return reply.send({ items });
  } catch (err: unknown) {
    console.error('[API subjects] не удалось получить предметы:', safeErrorMessage(err));
    return reply.code(503).send({
      error: 'schedule_unavailable',
      message: 'Не удалось получить список предметов.',
    });
  }
});

  app.get('/api/schedule', async (request, reply) => {
    const student = requireScheduleAccess(request);
    const group = requireStudentGroup(student);

    const query = (request.query ?? {}) as { startDate?: string; endDate?: string; force?: string };
    const force = query.force === '1' || query.force === 'true';

    if (force) clearScheduleCache(group.groupId);

    let schedule: ParsedSchedule;
    try {
      schedule = await getGroupSchedule(group.groupId, group.groupName, student.faculty);
    } catch (err: unknown) {
      console.error('[API schedule] не удалось получить расписание:', safeErrorMessage(err));
      return reply.code(503).send({
        error: 'schedule_unavailable',
        message: 'Не удалось загрузить расписание. Попробуйте позже.',
      });
    }

    const days = filterByRange(
      schedule.days.map((day) => mapDay(day, group.groupName, !student.isGuest)),
      query.startDate,
      query.endDate,
    );

    const response: ScheduleResponse = {
      groupName: schedule.groupName,
      facultyName: schedule.facultyName,
      days,
    };

    return reply.send(response);
  });
}

function mapDay(
  day: ParsedSchedule['days'][number],
  groupName: string,
  includeHomework: boolean,
): ApiScheduleDay {
  return {
    rawDate: day.rawDate,
    dayOfWeek: day.dayOfWeek,
    dayShort: day.dayShort,
    dayName: day.dayName,
    slots: day.slots.map((slot) => mapSlot(slot, groupName, day.rawDate, includeHomework)),
  };
}

function mapSlot(
  slot: ParsedSchedule['days'][number]['slots'][number],
  groupName: string,
  rawDate: string,
  includeHomework: boolean,
): ApiLessonSlot {
  // ДЗ ищем по дате и номеру пары; groupName гарантирует, что подтянутся
  // только записи своей группы (тот же фильтр использует бот). Гостю ДЗ не
  // показываем: у него нет доступа к личным разделам.
  const disciplines = slot.variants.map((v) => v.discipline);
  const homework: ApiLessonHomework[] = includeHomework
    ? homeworkStore
        .getForSlot(groupName, rawDate, slot.lessonNumber, disciplines)
        .map((hw) => ({
          id: hw.id,
          text: hw.text,
          authorName: hw.authorName,
          createdAt: hw.createdAt,
          fileCount: hw.files?.length ?? 0,
        }))
    : [];

  return {
    lessonNumber: slot.lessonNumber,
    timeStart: slot.timeStart,
    timeEnd: slot.timeEnd,
    variants: slot.variants.map(mapVariant),
    homework,
  };
}

function mapVariant(variant: ParsedLessonVariant): ApiLessonVariant {
  return {
    discipline: safeText(variant.discipline, 'Занятие'),
    kindOfWork: safeText(variant.kindOfWork, 'Занятие'),
    kind: normalizeKind(variant.kindOfWork),
    auditorium: safeText(variant.auditorium),
    building: safeText(variant.building),
    lecturerShort: safeText(variant.lecturerShort),
    lecturerFullName: safeText(variant.lecturerFullName),
    lecturerRank: variant.lecturerRank,
    subgroup: variant.subgroup,
    note: variant.note,
    onlineUrls: Array.isArray(variant.onlineUrls) ? variant.onlineUrls : [],
  };
}

/** Проверка формата YYYY.MM.DD — защита от мусора в query. */
function isRawDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}\.\d{2}\.\d{2}$/.test(value);
}

function filterByRange(
  days: ApiScheduleDay[],
  startDate?: string,
  endDate?: string,
): ApiScheduleDay[] {
  let out = days;

  if (isRawDate(startDate)) out = out.filter((d) => d.rawDate >= startDate);
  if (isRawDate(endDate)) out = out.filter((d) => d.rawDate <= endDate);

  return out;
}

/** Тип, используемый в POST /api/homework при выборе пары. */
export type { LessonKindType };