import { JsonStore } from '../jsonStore.ts';
import { recordHomework as recordHomeworkChange } from '../../backend/server/devStats.ts';

const recordHomeworkCreated = () => recordHomeworkChange('created');
const recordHomeworkDeleted = () => recordHomeworkChange('deleted');
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

/**
 * Индекс чтения: группа → записи и группа+дата → записи.
 *
 * Зачем. `/api/schedule` строит ответ по 104 дням (≈624 пары) и на КАЖДУЮ пару
 * вызывал `store.values().filter(...)`, то есть перебирал все ДЗ всех групп.
 * При 10 тысячах записей это ~1.4 с CPU на один запрос расписания — самый
 * частый эндпоинт приложения.
 *
 * Индекс перестраивается лениво при первом чтении после записи. ДЗ меняются
 * редко (несколько записей в день), поэтому стоимость перестройки размазана и
 * несопоставима с экономией на каждом запросе расписания.
 */
interface HomeworkIndex {
  byGroup: Map<string, HomeworkRecord[]>;
  byGroupDate: Map<string, HomeworkRecord[]>;
}

let index: HomeworkIndex | null = null;

/** Нормализация группы ровно та же, что в sameGroup. */
function groupKey(name: string): string {
  return name.trim().toLowerCase();
}

function buildIndex(): HomeworkIndex {
  const byGroup = new Map<string, HomeworkRecord[]>();
  const byGroupDate = new Map<string, HomeworkRecord[]>();

  for (const hw of store.values()) {
    const group = groupKey(hw.groupName);
    // Запись без группы не должна быть доступна никому — так же, как раньше.
    if (!group) continue;

    const list = byGroup.get(group);
    if (list) list.push(hw);
    else byGroup.set(group, [hw]);

    const slotKey = `${group}|${hw.targetDate}`;
    const slotList = byGroupDate.get(slotKey);
    if (slotList) slotList.push(hw);
    else byGroupDate.set(slotKey, [hw]);
  }

  for (const list of byGroup.values()) list.sort(byDateAndLesson);
  for (const list of byGroupDate.values()) list.sort(byDateAndLesson);

  index = { byGroup, byGroupDate };
  return index;
}

function readIndex(): HomeworkIndex {
  return index ?? buildIndex();
}

/** Любая запись или удаление делает индекс недействительным. */
function invalidateIndex(): void {
  index = null;
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
    return this.delete(id);
  },

  save(record: HomeworkRecord): void {
    // Счётчик для статистики: сколько ДЗ создано за сутки (см. devStats).
    if (!store.get(record.id)) recordHomeworkCreated();
    store.set(record.id, record);
    invalidateIndex();
  },

  delete(id: string): HomeworkRecord | undefined {
    const removed = store.delete(id);
    if (removed) recordHomeworkDeleted();
    if (removed) invalidateIndex();
    return removed;
  },

  /** Все записи ДЗ */
  all(): HomeworkRecord[] {
    return store.values();
  },

  /** ДЗ группы — для поиска привязанных к записям файлов. */
  getForGroup(groupName: string): HomeworkRecord[] {
    if (!groupName.trim()) return [];
    // Копия: вызывающий код сортирует/фильтрует результат как свой массив и
    // не должен менять индекс.
    return [...(readIndex().byGroup.get(groupKey(groupName)) ?? [])];
  },

  /** ДЗ группы начиная с указанной даты, по порядку занятий */
  getUpcoming(groupName: string, fromRawDate: string): HomeworkRecord[] {
    // Пустая группа не видит ничего: иначе записи с незаполненным groupName
    // достались бы любому, у кого группа ещё не подтянулась.
    if (!groupName.trim()) return [];
    const list = readIndex().byGroup.get(groupKey(groupName)) ?? [];
    // Список уже отсортирован по дате, поэтому достаточно отфильтровать.
    return list.filter((hw) => hw.targetDate >= fromRawDate);
  },

  /** ДЗ, привязанные к конкретной паре */
  getForSlot(groupName: string, rawDate: string, lessonNumber: number, disciplines: string[]): HomeworkRecord[] {
    if (!groupName.trim()) return [];
    const bucket = readIndex().byGroupDate.get(`${groupKey(groupName)}|${rawDate}`) ?? [];
    const discs = disciplines.map((d) => d.toLowerCase());

    return bucket.filter((hw) => {
      if (hw.lessonNumber) return hw.lessonNumber === lessonNumber;
      // Старые записи без номера пары — сверяем по названию
      const d = hw.discipline.toLowerCase();
      return discs.some((x) => x.includes(d) || d.includes(x));
    });
  },
};

export type { ServerFileRef };
