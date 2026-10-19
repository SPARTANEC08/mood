/**
 * Мост к кэшу расписания для серверных роутов.
 *
 * Раньше загрузкой расписания для пользователя занимался botEngine
 * (getCachedSchedule). Логику дублировать нельзя: пришлось бы расходиться
 * с ботом в обработке ошибок, поэтому здесь тонкая обёртка над тем же кэшем.
 */

import { getGroupSchedule } from '../../scheduleCache.ts';
import type { StoredUser } from '../../../db/storage/userStore.ts';
import type { ParsedSchedule } from '../../parser/types.ts';

/**
 * Расписание группы студента из кэша (с обращением к ts.mpei.ru при промахе).
 */
export async function getCachedScheduleForUser(student: StoredUser): Promise<ParsedSchedule> {
  if (typeof student.groupId !== 'number' || student.groupId <= 0) {
    throw new Error('Группа не определена. Выполните вход через БАРС МЭИ заново.');
  }
  if (!student.groupName) {
    throw new Error('Название группы не определено.');
  }

  return getGroupSchedule(student.groupId, student.groupName, student.faculty);
}