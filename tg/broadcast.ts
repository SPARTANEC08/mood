/**
 * Рассылка объявлений от админа.
 *
 * Отправка последовательная и с паузой: Telegram банит за шквал сообщений, а
 * аудитория здесь — живые люди, которым не нужна гонка. Ошибка на одном
 * получателе (403 «bot was blocked», удалённый аккаунт) не должна обрывать
 * рассылку: считаем её и идём дальше.
 *
 * Модуль не знает про grammY: отправка передаётся функцией. Это позволяет
 * протестировать паузы/подсчёт без сети.
 */

/** Минимальная пауза между сообщениями. */
export const BROADCAST_MIN_DELAY_MS = 80;

/** Случайная добавка к паузе. */
export const BROADCAST_JITTER_MS = 60;

/** Лимит Telegram на текст сообщения. */
export const BROADCAST_MAX_LENGTH = 4096;

export interface BroadcastUser {
  telegramId?: number | null;
}

export interface BroadcastResult {
  sent: number;
  failed: number;
  skipped: number;
}

export type BroadcastSend = (telegramId: number, text: string) => Promise<void>;

export interface BroadcastOptions {
  delayMs?: number;
  jitterMs?: number;
  /** Инъекция сна для тестов. */
  sleep?: (ms: number) => Promise<void>;
  /** Инъекция случайности для тестов. */
  random?: () => number;
  /**
   * Вызывается на каждого неудачного получателя. Нужно, чтобы в журнале было
   * видно, КОМУ не ушло и почему (403 «заблокировал» отличается от «chat not
   * found»), а не только счётчик ошибок.
   */
  onError?: (telegramId: number, error: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Проверка текста до отправки: пустой или слишком длинный отклоняем целиком.
 * Обрезать объявление молча нельзя — смысл может быть в конце.
 */
export function validateBroadcastText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return 'Текст пустой. Пришли сообщение ещё раз.';
  if (trimmed.length > BROADCAST_MAX_LENGTH) {
    return `Текст длиннее ${BROADCAST_MAX_LENGTH} символов. Сократи и пришли снова.`;
  }
  return null;
}

/** Уникальные числовые telegramId, без null/undefined и дублей. */
export function recipientIds(users: BroadcastUser[]): number[] {
  const ids = new Set<number>();
  for (const user of users) {
    if (typeof user.telegramId === 'number' && Number.isFinite(user.telegramId) && user.telegramId > 0) {
      ids.add(user.telegramId);
    }
  }
  return [...ids];
}

/**
 * Отправляет текст всем получателям.
 *
 * `skipped` — пользователи без telegramId (они не ошибка, а просто не подписаны).
 */
export async function broadcastText(
  text: string,
  users: BroadcastUser[],
  send: BroadcastSend,
  options: BroadcastOptions = {},
): Promise<BroadcastResult> {
  const ids = recipientIds(users);
  // skipped — это записи БЕЗ telegramId (не подписаны). Дубли одного и того же
  // получателя — не «пропуск», а нормальная дедупликация, и в счётчик не идут.
  const skipped = users.filter(
    (user) =>
      !(typeof user.telegramId === 'number' && Number.isFinite(user.telegramId) && user.telegramId > 0),
  ).length;
  const delayMs = options.delayMs ?? BROADCAST_MIN_DELAY_MS;
  const jitterMs = options.jitterMs ?? BROADCAST_JITTER_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let sent = 0;
  let failed = 0;

  for (let index = 0; index < ids.length; index += 1) {
    const telegramId = ids[index]!;
    try {
      await send(telegramId, text);
      sent += 1;
    } catch (err: unknown) {
      // 403/400 от Telegram (заблокировал, удалён) — не повод падать.
      failed += 1;
      options.onError?.(telegramId, err);
    }

    if (index < ids.length - 1) {
      await sleep(delayMs + Math.floor(random() * jitterMs));
    }
  }

  return { sent, failed, skipped };
}
