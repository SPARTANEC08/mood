/**
 * Кэш превью почты ОСЭП, который заполняет ФОНОВЫЙ НОТИФИКАТОР.
 *
 * Зачем отдельный кэш, а не barsSnapshotCache: снимок БАРС — это оценки,
 * пропуски, рейтинг и прочее, и он собирается по запросу разделов. Почту же по
 * требованию пользователя обновляет ТОЛЬКО цикл уведомлений (он и так каждые
 * 20 минут ходит в IMAP за новыми письмами). Здесь лежит ровно то, что уже
 * добыл нотификатор, а приложение читает готовое — без собственного похода в
 * почту и без кнопки «обновить».
 *
 * Хранится в памяти: превью — производные данные, оно переживёт не больше
 * круга нотификатора. Значение НЕ удаляется по TTL: если очередной заход в
 * почту не удался, лучше показать последнее известное, чем пустоту.
 */

import type { ApiMailMessage } from '../../server/types.ts';

export interface MailPreview {
  total: number;
  unseen: number;
  messages: ApiMailMessage[];
  /** Когда нотификатор обновил превью (для диагностики). */
  updatedAt: number;
}

const previews = new Map<string, MailPreview>();

/** Потолок по числу пользователей: превью маленькое, но пользователей много. */
const MAX_PREVIEWS = 500;

export function putMailPreview(
  userId: string,
  preview: { total: number; unseen: number; messages: ApiMailMessage[] },
): void {
  if (previews.size >= MAX_PREVIEWS && !previews.has(userId)) {
    const oldest = [...previews.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) previews.delete(oldest[0]);
  }

  previews.set(userId, { ...preview, updatedAt: Date.now() });
}

/** Превью из памяти без похода в почту. null — нотификатор ещё не собрал его. */
export function peekMailPreview(userId: string): MailPreview | null {
  return previews.get(userId) ?? null;
}

export function clearMailPreview(userId: string): void {
  previews.delete(userId);
}
