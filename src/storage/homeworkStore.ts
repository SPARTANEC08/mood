import { JsonStore } from '../utils/jsonStore.ts';
import type { ServerFileRef } from './fileStore.ts';

export type LessonKindType = 'lecture' | 'practice' | 'lab';

export interface HomeworkRecord {
  id: string;
  groupName: string;
  /** Точное название дисциплины из расписания */
  discipline: string;
  kind: LessonKindType;
  /** YYYY.MM.DD */
  targetDate: string;
  lessonNumber?: number;
  timeStart?: string;
  text: string;
  files: ServerFileRef[];
  /** userId автора: идентификатор общий для бота и PWA. */
  authorId?: string;
  authorName?: string;
  createdAt: string;
}

const store = new JsonStore<HomeworkRecord>('homework.json');

const sameGroup = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function byDateAndLesson(a: HomeworkRecord, b: HomeworkRecord): number {
  return (
    a.targetDate.localeCompare(b.targetDate) ||
    (a.lessonNumber ?? 0) - (b.lessonNumber ?? 0) ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

export const homeworkStore = {
  get(id: string): HomeworkRecord | undefined {
    return store.get(id);
  },

  /**
   * ДЗ по ID, но только если оно принадлежит указанной группе.
   *
   * Глобальный get(id) отдавал запись любой группы по угаданному callback_data,
   * а вместе с ней и file_id файлов для отправки в чат. Пустая группа не имеет
   * доступа ни к чему: иначе записи с незаполненным groupName видели бы все.
   */
  getForGroupAndId(groupName: string, id: string): HomeworkRecord | undefined {
    if (!groupName.trim()) return undefined;
    const hw = store.get(id);
    return hw && sameGroup(hw.groupName, groupName) ? hw : undefined;
  },

  /** Удаление ДЗ, если оно принадлежит указанной группе. */
  deleteForGroupAndId(groupName: string, id: string): HomeworkRecord | undefined {
    if (!this.getForGroupAndId(groupName, id)) return undefined;
    return store.delete(id);
  },

  save(record: HomeworkRecord): void {
    store.set(record.id, record);
  },

  delete(id: string): HomeworkRecord | undefined {
    return store.delete(id);
  },

  /** Все записи ДЗ */
  all(): HomeworkRecord[] {
    return store.values();
  },

  /** ДЗ группы — для поиска привязанных к записям файлов. */
  getForGroup(groupName: string): HomeworkRecord[] {
    if (!groupName.trim()) return [];
    return store.values().filter((hw) => sameGroup(hw.groupName, groupName));
  },

  /** ДЗ группы начиная с указанной даты, по порядку занятий */
  getUpcoming(groupName: string, fromRawDate: string): HomeworkRecord[] {
    // Пустая группа не видит ничего: иначе записи с незаполненным groupName
    // достались бы любому, у кого группа ещё не подтянулась.
    if (!groupName.trim()) return [];
    return store
      .values()
      .filter((hw) => sameGroup(hw.groupName, groupName) && hw.targetDate >= fromRawDate)
      .sort(byDateAndLesson);
  },

  /** ДЗ, привязанные к конкретной паре */
  getForSlot(groupName: string, rawDate: string, lessonNumber: number, disciplines: string[]): HomeworkRecord[] {
    if (!groupName.trim()) return [];
    const discs = disciplines.map((d) => d.toLowerCase());
    return store
      .values()
      .filter((hw) => {
        if (!sameGroup(hw.groupName, groupName) || hw.targetDate !== rawDate) return false;
        if (hw.lessonNumber) return hw.lessonNumber === lessonNumber;
        // Старые записи без номера пары — сверяем по названию
        const d = hw.discipline.toLowerCase();
        return discs.some((x) => x.includes(d) || d.includes(x));
      })
      .sort(byDateAndLesson);
  },
};

export type { ServerFileRef };
