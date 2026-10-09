import { ParsedLessonSlot, ParsedLessonVariant, ParsedSchedule, ParsedScheduleDay } from '../parser/types.ts';
import { HomeworkRecord, LessonKindType, TelegramFileRef } from '../storage/homeworkStore.ts';
import { resolveDisciplines } from '../storage/subjectAliases.ts';
import { TelegramUser } from '../storage/userStore.ts';
import { toMoscow } from '../utils/time.ts';

/** «предмет л/п/лаб текст» — предмет, маркер типа занятия, текст (может быть пустым при файлах) */
const HW_REGEX = /^(.+?)\s+(л|п|лек|лекция|пр|практика|сем|семинар|лаб|лаба|лабораторная)(?=[.\s]|$)\.?\s*([\s\S]*)$/i;

export const HW_FORMAT_HINT = 'Формат: предмет л/п/лаб текст\nПример: Матан п №1-5 стр. 20';

export function looksLikeHomework(text: string): boolean {
  return HW_REGEX.test(stripDzCommand(text));
}

function stripDzCommand(text: string): string {
  return (text || '').trim().replace(/^\/dz(@\w+)?\s*/i, '');
}

export function isLectureKind(kindOfWork: string): boolean {
  return (kindOfWork || '').toLowerCase().includes('лек');
}

export function isLabKind(kindOfWork: string): boolean {
  return (kindOfWork || '').toLowerCase().includes('лаб');
}

function matchesKind(kindOfWork: string, kind: LessonKindType): boolean {
  if (kind === 'lecture') return isLectureKind(kindOfWork);
  if (kind === 'lab') return isLabKind(kindOfWork);
  const k = (kindOfWork || '').toLowerCase();
  return !isLectureKind(k) && !isLabKind(k) && !/экзам|консульт|зач[её]т|аттестац/.test(k);
}

export interface FoundLesson {
  day: ParsedScheduleDay;
  slot: ParsedLessonSlot;
  variant: ParsedLessonVariant;
}

/**
 * Ближайшее занятие по предмету и типу, начиная со следующего дня.
 * Пары текущего дня игнорируются, чтобы ДЗ привязывалось на следующее занятие, а не на сегодня.
 */
export function findNextLesson(
  schedule: ParsedSchedule,
  disciplines: string[],
  kind: LessonKindType,
  now: Date = new Date()
): FoundLesson | null {
  const { rawDate: today } = toMoscow(now);
  const wanted = new Set(disciplines);

  for (const day of schedule.days) {
    if (day.rawDate <= today) continue;
    for (const slot of day.slots) {
      const variant = slot.variants.find((v) => wanted.has(v.discipline) && matchesKind(v.kindOfWork, kind));
      if (variant) return { day, slot, variant };
    }
  }
  return null;
}

export type AddHwResult =
  | { success: true; record: HomeworkRecord; lesson: FoundLesson }
  | { success: false; error: string };

/**
 * Разбирает ввод и формирует запись ДЗ (без сохранения).
 */
export function buildHomework(
  user: TelegramUser,
  authorName: string,
  schedule: ParsedSchedule,
  rawInput: string,
  files: TelegramFileRef[]
): AddHwResult {
  const match = stripDzCommand(rawInput).match(HW_REGEX);
  if (!match) return { success: false, error: HW_FORMAT_HINT };

  const subjectInput = match[1].trim();
  const marker = match[2].toLowerCase();
  const kind: LessonKindType = marker.startsWith('лаб')
    ? 'lab'
    : marker.startsWith('л')
    ? 'lecture'
    : 'practice';
  const text = match[3].trim();

  if (!text && files.length === 0) {
    return { success: false, error: 'Нет ни текста задания, ни файлов.' };
  }

  const allDisciplines = schedule.days.flatMap((d) => d.slots.flatMap((s) => s.variants.map((v) => v.discipline)));
  const disciplines = resolveDisciplines(subjectInput, allDisciplines);
  if (disciplines.length === 0) {
    const known = [...new Set(allDisciplines)].sort().join('\n• ');
    return {
      success: false,
      error: `Предмет «${subjectInput}» не найден в расписании группы.\n\nПредметы в расписании:\n• ${known}`,
    };
  }

  const lesson = findNextLesson(schedule, disciplines, kind);
  if (!lesson) {
    const kindName = kind === 'lecture' ? 'лекций' : kind === 'lab' ? 'лабораторных' : 'практик';
    return {
      success: false,
      error: `Не нашёл будущих ${kindName} по предмету «${disciplines[0]}». ДЗ не сохранено.`,
    };
  }

  const record: HomeworkRecord = {
    id: `hw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    groupName: user.groupName ?? '',
    discipline: lesson.variant.discipline,
    kind,
    targetDate: lesson.day.rawDate,
    lessonNumber: lesson.slot.lessonNumber,
    timeStart: lesson.slot.timeStart,
    text,
    files,
    authorId: user.telegramId,
    authorName,
    createdAt: new Date().toISOString(),
  };

  return { success: true, record, lesson };
}
