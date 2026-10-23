/**
 * События для уведомлений внутри приложения.
 *
 * Telegram получает только тип события. Здесь хранится то же событие с
 * деталями для PWA: дисциплина и балл, номер/дата приказа, статус стипендии.
 * Для почты деталей нет — только «новое письмо».
 *
 * id детерминированный (`userId + ключ события`): если нотификатор повторит
 * круг после сбоя Telegram, то же событие не появится в приложении дважды.
 * Прочитанное помечается `read_at` и больше не показывается.
 */

import { getDb } from '../sqlite.ts';

export type UserEventKind = 'grade' | 'mail' | 'order' | 'scholarship';

export interface UserEvent {
  id: string;
  userId: string;
  kind: UserEventKind;
  label: string;
  details: string[];
  createdAt: string;
  readAt?: string | null;
}

export interface NewUserEvent {
  userId: string;
  key: string;
  kind: UserEventKind;
  label: string;
  details: string[];
  createdAt: string;
}

/** Сколько последних событий держим на пользователя. */
const MAX_EVENTS_PER_USER = 50;

interface EventRow {
  id: string;
  user_id: string;
  kind: string;
  label: string;
  details: string;
  created_at: string;
  read_at: string | null;
}

function fromRow(row: EventRow): UserEvent {
  let details: string[] = [];
  try {
    const parsed = JSON.parse(row.details);
    if (Array.isArray(parsed)) details = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // битые детали не должны ломать уведомление
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as UserEventKind,
    label: row.label,
    details,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export const userEventStore = {
  /** Добавляет событие; повтор с тем же ключом игнорируется. */
  add(event: NewUserEvent): void {
    const db = getDb();
    const id = `${event.userId}:${event.key}`;

    db.prepare(
      'INSERT OR IGNORE INTO user_events(id, user_id, kind, label, details, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      event.userId,
      event.kind,
      event.label,
      JSON.stringify(event.details),
      event.createdAt,
    );

    // Держим только последние N событий пользователя.
    db.prepare(
      'DELETE FROM user_events WHERE user_id = ? AND id NOT IN (' +
        'SELECT id FROM user_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)',
    ).run(event.userId, event.userId, MAX_EVENTS_PER_USER);
  },

  /** Первое непрочитанное событие пользователя. */
  nextFor(userId: string): UserEvent | null {
    const row = getDb()
      .prepare(
        'SELECT id, user_id, kind, label, details, created_at, read_at ' +
          'FROM user_events WHERE user_id = ? AND read_at IS NULL ' +
          'ORDER BY created_at ASC LIMIT 1',
      )
      .get(userId) as EventRow | undefined;

    return row ? fromRow(row) : null;
  },

  /** Отмечает событие прочитанным. false — события нет или оно уже прочитано. */
  markRead(userId: string, id: string): boolean {
    const result = getDb()
      .prepare('UPDATE user_events SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), userId, id);
    return result.changes > 0;
  },

  clearForUser(userId: string): void {
    getDb().prepare('DELETE FROM user_events WHERE user_id = ?').run(userId);
  },

  reset(): void {
    getDb().exec('DELETE FROM user_events');
  },
};

