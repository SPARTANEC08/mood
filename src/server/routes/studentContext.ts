/**
 * Общий доступ к данным группы студента.
 *
 * Группа — граница доступа: ДЗ, объявления и файлы видны только своей
 * группе (та же модель, что и в боте). Здесь она проверяется централизованно,
 * чтобы каждый роут не решал сам, можно ли отдавать запись.
 */

import { homeworkStore } from '../../storage/homeworkStore.ts';
import { importantStore } from '../../storage/importantStore.ts';
import type { StoredUser } from '../../storage/userStore.ts';

export interface StudentGroupContext {
  groupName: string;
  groupId: number;
}

export class GroupNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupNotReadyError';
  }
}

/**
 * Одинаковые ли это группы.
 *
 * Сравнение нормализует регистр и пробелы и совпадает с тем, как группы
 * сопоставляются в хранилищах. Пустая строка не равна ничему, включая другую
 * пустую: незаполненная группа не даёт доступа ни к каким записям.
 */
export function sameGroupName(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && left === right;
}

/**
 * Явная проверка прав на запись в роуте.
 *
 * Дубль к фильтрации в хранилище — намеренный: если запись получена не через
 * group-scoped метод (или хранилище изменит поведение), роут всё равно не
 * отдаст чужое. Одна лишняя строка дешевле, чем утечка чужой группы.
 */
export function canAccessGroup(recordGroupName: string, studentGroupName: string): boolean {
  return sameGroupName(recordGroupName, studentGroupName);
}

/**
 * Достаёт группу студента или объясняет, почему её нет.
 *
 * Пустая группа означает, что студент ещё не привязан к расписанию: показывать
 * ему чужие записи нельзя, поэтому запрос отклоняется, а не возвращает пустой
 * список (иначе фронтенд решил бы, что у группы нет ДЗ).
 */
export function requireStudentGroup(student: StoredUser): StudentGroupContext {
  const groupName = (student.groupName ?? '').trim();

  if (!groupName) {
    throw new GroupNotReadyError(
      'Группа не определена. Выполните вход в БАРС заново, чтобы приложение подтянуло группу.',
    );
  }

  return {
    groupName,
    groupId: typeof student.groupId === 'number' && student.groupId > 0 ? student.groupId : 0,
  };
}

/**
 * Запись ДЗ, если она принадлежит группе.
 * Глобальный homeworkStore.get(id) здесь сознательно не используется.
 */
export function findHomeworkForGroup(
  groupName: string,
  id: string,
): ReturnType<typeof homeworkStore.get> {
  return homeworkStore.getForGroupAndId(groupName, id);
}

/** Объявление, если оно принадлежит группе. */
export function findImportantForGroup(
  groupName: string,
  id: string,
): ReturnType<typeof importantStore.get> {
  return importantStore.getForGroupAndId(groupName, id);
}