/**
 * Привязка домашнего задания к паре расписания.
 *
 * Модуль пережил превращение бота в push-канал не весь, а только той частью,
 * которая работает на API: разбор свободного текста «предмет л/п/лаб текст»
 * жил в боте, и вместе с экранами ввода он ушёл. А вот поиск будущей пары по
 * названию дисциплины нужен и сейчас — им пользуется `POST /api/homework`,
 * когда человек создаёт задание в приложении.
 *
 * Отсюда и асимметрия: найти пару может и сервер, а разобрать «Матан п №1-5»
 * из строки в чате уже некому — в приложении для этого форма с выбором
 * предмета и типа занятия, и ошибиться в ней нельзя.
 */

import type { ParsedLessonSlot, ParsedLessonVariant, ParsedSchedule, ParsedScheduleDay } from './parser/types.ts';
import type { LessonKindType } from '../db/storage/homeworkStore.ts';
import { toMoscow } from './utils/time.ts';

export function isLectureKind(kindOfWork: string): boolean {
  return (kindOfWork || '').toLowerCase().includes('лек');
}

export function isLabKind(kindOfWork: string): boolean {
  return (kindOfWork || '').toLowerCase().includes('лаб');
}

/**
 * Совпадает ли вид занятия с типом из записи.
 *
 * Типы разделены строго: лекция — только лекции, лабораторная — только
 * лабораторные, а практикой считается всё, что не лекция и не лабораторная,
 * кроме экзаменов, консультаций, зачётов и аттестаций.
 */
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
 *
 * Пары текущего дня игнорируются: задание привязывается к СЛЕДУЮЩЕМУ занятию,
 * а не к сегодняшнему — иначе оно «сгорает» через несколько часов, а человек
 * обычно пишет задание вечером, уже после пары.
 */
export function findNextLesson(
  schedule: ParsedSchedule,
  disciplines: string[],
  kind: LessonKindType,
  now: Date = new Date(),
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