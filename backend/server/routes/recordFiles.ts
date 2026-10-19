/**
 * Привязка уже загруженных файлов к записям ДЗ и «Важного».
 *
 * Файлы загружаются отдельным запросом (`POST /api/files/upload`) раньше самой
 * записи. Между двумя запросами проходит время, а идентификатор файла приходит
 * от клиента — то есть это ровно то место, где нужен отдельный слой проверки
 * прав, а не доверие телу запроса.
 *
 * Главное правило: прикрепить можно **только свой** файл. Иначе человек узнал
 * бы чужой `fileId` — из чужого канала Telegram в прежней схеме или из ответа
 * сервера — и повесил его на свою запись, а потом получил бы доступ к чужому
 * содержимому. Проверка идёт по `uploadedBy`, а не по существованию: файл
 * лежит в каталоге своего владельца, и чужой каталог запрашивающему недоступен,
 * но в базе запись о нём ещё не значит, что он имеет право его использовать.
 */

import { getFile, type ServerFileRef } from '../../../db/storage/fileStore.ts';

/** Ошибка привязки файлов — с кодом ответа и понятным для человека текстом. */
export class RecordFilesError extends Error {
  constructor(message: string, readonly code: number = 400) {
    super(message);
    this.name = 'RecordFilesError';
  }
}

/** Потолки повторяют ограничения fileStore: проверка на второй стороне полезна. */
const MAX_FILES_PER_RECORD = 10;

/** Сколько файлов принимает запрос, чтобы не разбирать тысячи идентификаторов. */
const MAX_FILE_IDS = 20;

/**
 * Превращает список `fileIds` в ссылки на файлы.
 *
 * Пропущенные и повторяющиеся идентификаторы схлопываются: клиент присылает
 * то, что показал в форме, и повтор там — это ошибка интерфейса, а не повод
 * отказывать человеку. Порядок сохраняется: файлы в записи показываются в том
 * порядке, в каком человек их выбрал.
 *
 * Пустой или отсутствующий список — не ошибка: запись без файлов разрешена.
 */
export async function resolveOwnedFiles(
  userId: string,
  fileIds: unknown,
): Promise<ServerFileRef[]> {
  if (fileIds === undefined || fileIds === null) return [];

  if (!Array.isArray(fileIds)) {
    throw new RecordFilesError('Список файлов передан неверно.');
  }

  if (fileIds.length > MAX_FILE_IDS) {
    throw new RecordFilesError(`К записи можно прикрепить не больше ${MAX_FILES_PER_RECORD} файлов.`);
  }

  const unique: string[] = [];
  for (const raw of fileIds) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (!unique.includes(raw)) unique.push(raw);
  }

  if (unique.length > MAX_FILES_PER_RECORD) {
    throw new RecordFilesError(`К записи можно прикрепить не больше ${MAX_FILES_PER_RECORD} файлов.`);
  }

  const files: ServerFileRef[] = [];

  for (const fileId of unique) {
    const found = await getFile(userId, fileId);

    // getFile ищет файл в каталоге конкретного userId, поэтому чужой сюда не
    // попадёт. Проверка uploadedBy — вторая линия: даже если метаданные
    // окажутся в чужой записи, ссылку на них нельзя будет переиспользовать.
    if (!found || found.meta.uploadedBy !== userId) {
      // Файл не найден у этого пользователя: он либо удалён, либо чужой. Ответ
      // одинаковый в обоих случаях — иначе ошибка превращалась бы в способ
      // проверить, существует ли такой fileId вообще.
      throw new RecordFilesError('Файл не найден или уже удалён. Приложите его заново.');
    }

    files.push(found.meta);
  }

  return files;
}

/** Что делать с файлами, которые были в записи и пропали из нового списка. */
export function removedFiles(
  previous: ServerFileRef[],
  next: ServerFileRef[],
): ServerFileRef[] {
  const keep = new Set(next.map((f) => f.fileId));
  return previous.filter((f) => !keep.has(f.fileId));
}
