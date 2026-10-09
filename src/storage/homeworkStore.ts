import { JsonStore } from '../utils/jsonStore.ts';

export type LessonKindType = 'lecture' | 'practice' | 'lab';

export type TelegramFileType = 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'animation';

export interface TelegramFileRef {
  fileId: string;
  fileUniqueId?: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  /** Тип медиа в Telegram — нужен, чтобы отправить файл правильным методом */
  type?: TelegramFileType;
  /** ID сообщения с этим файлом в канале-хранилище */
  channelMessageId?: number;
}

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
  files: TelegramFileRef[];
  authorId?: number;
  authorName?: string;
  createdAt: string;
  /** Все сообщения этой записи в канале-хранилище (заголовок + файлы) */
  channelMessageIds?: number[];
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

  save(record: HomeworkRecord): void {
    store.set(record.id, record);
  },

  delete(id: string): HomeworkRecord | undefined {
    return store.delete(id);
  },

  setChannelMessages(id: string, channelMessageIds: number[], files: TelegramFileRef[]): void {
    const rec = store.get(id);
    if (!rec) return;
    store.set(id, { ...rec, channelMessageIds, files });
  },

  /** Все записи ДЗ */
  all(): HomeworkRecord[] {
    return store.values();
  },

  /** ДЗ группы начиная с указанной даты, по порядку занятий */
  getUpcoming(groupName: string, fromRawDate: string): HomeworkRecord[] {
    return store
      .values()
      .filter((hw) => sameGroup(hw.groupName, groupName) && hw.targetDate >= fromRawDate)
      .sort(byDateAndLesson);
  },

  /** ДЗ, привязанные к конкретной паре */
  getForSlot(groupName: string, rawDate: string, lessonNumber: number, disciplines: string[]): HomeworkRecord[] {
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
