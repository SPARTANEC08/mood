/**
 * Общие помощники маршрутов записей (ДЗ и «Важное»).
 *
 * Файл существует потому, что два маршрута делали одно и то же двумя копиями:
 *   - ограничитель частоты записей (антифлуд);
 *   - удаление файлов с диска — вместе с одинаковой политикой «ошибку
 *     удаления не поднимаем».
 *
 * Копии — это два места, которые нужно править синхронно; здесь оно одно.
 *
 * Лимит на создание записей СУММАРНЫЙ для ДЗ и объявлений: счётчик один на
 * пользователя, а не по одному на маршрут. Иначе злоумышленник обходил бы
 * потолок, чередуя типы записей. Состояние — в памяти процесса (он один,
 * см. info.md §2), окно — час.
 */

import type { FastifyReply } from 'fastify';

import { deleteFile, type ServerFileRef } from '../../storage/fileStore.ts';
import { safeErrorMessage } from '../../bot/format.ts';

/** Сколько записей (ДЗ + объявлений вместе) в час разрешено одному пользователю. */
export const MAX_RECORDS_PER_HOUR = 30;

/** Окно ограничения частоты записей: час. */
export const RECORD_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Вердикт ограничителя: можно ли создавать запись и когда повторить. */
export interface RecordRateVerdict {
  limited: boolean;
  /** Миллисекунды до освобождения окна (для заголовка Retry-After). */
  retryAfterMs: number;
}

/**
 * Метки времени созданных записей по userId — общие для ДЗ и объявлений.
 *
 * Значение — массив отметок в пределах часа. Ключи живут столько же, сколько
 * процесс; их число ограничено числом пользователей с PWA-токенами.
 */
const recordTimes = new Map<string, number[]>();

/** Когда в последний раз вычищали пустые/протухшие списки (ленивая уборка). */
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_USERS = 10_000;

function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  const cutoff = now - RECORD_RATE_WINDOW_MS;
  for (const [key, list] of recordTimes) {
    const recent = list.filter((t) => t > cutoff);
    if (recent.length === 0) recordTimes.delete(key);
    else recordTimes.set(key, recent);
  }
}

/**
 * Проверяет и учитывает попытку создать запись (ДЗ или «Важное»).
 *
 * Вызывается в начале обработчика POST: счётчик учитывает и неудачные попытки
 * — это защита от перебора, а не показатель числа сохранённых записей.
 */
export function checkRecordRateLimit(userId: string): RecordRateVerdict {
  const now = Date.now();
  sweep(now);

  // Потолок на размер карты: при переполнении чистим протухшее немедленно.
  if (recordTimes.size > MAX_TRACKED_USERS) {
    lastSweepAt = 0;
    sweep(now);
  }

  const cutoff = now - RECORD_RATE_WINDOW_MS;
  const recent = (recordTimes.get(userId) ?? []).filter((t) => t > cutoff);

  if (recent.length >= MAX_RECORDS_PER_HOUR) {
    recordTimes.set(userId, recent);
    const retryAfterMs = Math.max(1_000, recent[0]! + RECORD_RATE_WINDOW_MS - now);
    return { limited: true, retryAfterMs };
  }

  recent.push(now);
  recordTimes.set(userId, recent);
  return { limited: false, retryAfterMs: 0 };
}

/**
 * Отвечает 429 с заголовком Retry-After.
 *
 * Заголовок в секундах (как требует RFC), тело — машиночитаемое имя ошибки и
 * `retryAfterMs` для обратного отсчёта на клиенте.
 */
export function sendRateLimited(reply: FastifyReply, message: string, retryAfterMs: number): FastifyReply {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

  return reply
    .header('Retry-After', String(seconds))
    .code(429)
    .send({ error: 'too_many_requests', message, retryAfterMs });
}

/**
 * Снимает файлы с диска.
 *
 * Ошибка удаления не поднимается: запись уже удалена или сохранена, и ронять
 * на этом запрос хуже, чем оставить файл. Осиротевший файл уберёт `check:files`.
 * Метка в журнале отличает маршрут (ДЗ или объявление) при разборе.
 */
export async function dropRecordFiles(files: ServerFileRef[], label: string): Promise<void> {
  for (const file of files) {
    try {
      await deleteFile(file.uploadedBy, file.fileId);
    } catch (err: unknown) {
      console.warn(`${label} не удалось удалить файл:`, safeErrorMessage(err));
    }
  }
}
