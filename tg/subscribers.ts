/**
 * Локальный список Telegram-подписчиков бота.
 *
 * Бот — отдельный процесс и не открывает базу приложения. Ему нужен только
 * собственный файл рядом с WorkingDirectory: кто нажал /start или просто
 * написал боту. Telegram не даёт писать тем, кто ни разу не запускал бота,
 * поэтому без этого файла рассылка невозможна.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface BotSubscriber {
  id: number;
  firstName?: string;
  username?: string;
  lastSeenAt: string;
}

const FILE = path.resolve(process.cwd(), 'bot-subscribers.json');

let cache: Record<string, BotSubscriber> | null = null;

function read(): Record<string, BotSubscriber> {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, BotSubscriber>;
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }

  return cache;
}

function save(): void {
  const data = read();
  const tmp = `${FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, FILE);
    try {
      fs.chmodSync(FILE, 0o600);
    } catch {
      // владелец и так spartanec
    }
  } catch (err) {
    console.error('[Bot] не удалось сохранить подписчиков:', err instanceof Error ? err.message : err);
  }
}

export const botSubscribers = {
  touch(from: { id: number; first_name?: string; username?: string; is_bot?: boolean }): void {
    if (!from || from.is_bot) return;

    const data = read();
    const key = String(from.id);
    const previous = data[key];

    data[key] = {
      id: from.id,
      firstName: from.first_name,
      username: from.username,
      lastSeenAt: new Date().toISOString(),
    };

    // Не пишем файл на каждое сообщение, если ничего не изменилось, кроме
    // времени: для списка получателей достаточно первого касания.
    if (!previous) save();
  },

  all(): BotSubscriber[] {
    return Object.values(read());
  },

  count(): number {
    return Object.keys(read()).length;
  },
};
