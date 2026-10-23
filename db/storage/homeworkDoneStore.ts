/**
 * Личные отметки «Сделано» для домашних заданий.
 *
 * ДЗ общее на группу, а выполнение — личное: у одного студента задание закрыто,
 * у другого нет. Поэтому отметки лежат отдельно от самой записи, ключ —
 * (userId, homeworkId), и переживают перезагрузку/рестарт.
 *
 * Просроченные задания отметить нельзя: это проверяется и в API, и на клиенте.
 */

import { getDb } from '../sqlite.ts';

export const homeworkDoneStore = {
  /** Все id заданий, которые пользователь отметил выполненными. */
  doneIds(userId: string): Set<string> {
    const rows = getDb()
      .prepare('SELECT homework_id FROM homework_done WHERE user_id = ?')
      .all(userId) as Array<{ homework_id: string }>;
    return new Set(rows.map((row) => row.homework_id));
  },

  isDone(userId: string, homeworkId: string): boolean {
    const row = getDb()
      .prepare('SELECT 1 AS ok FROM homework_done WHERE user_id = ? AND homework_id = ?')
      .get(userId, homeworkId) as { ok: number } | undefined;
    return row !== undefined;
  },

  setDone(userId: string, homeworkId: string, done: boolean): void {
    const db = getDb();
    if (done) {
      db.prepare(
        'INSERT OR REPLACE INTO homework_done(user_id, homework_id, done_at) VALUES (?, ?, ?)',
      ).run(userId, homeworkId, new Date().toISOString());
    } else {
      db.prepare('DELETE FROM homework_done WHERE user_id = ? AND homework_id = ?').run(
        userId,
        homeworkId,
      );
    }
  },

  /** Убирает отметки всех пользователей для удалённого задания. */
  removeForHomework(homeworkId: string): void {
    getDb().prepare('DELETE FROM homework_done WHERE homework_id = ?').run(homeworkId);
  },

  clearForUser(userId: string): void {
    getDb().prepare('DELETE FROM homework_done WHERE user_id = ?').run(userId);
  },

  reset(): void {
    getDb().exec('DELETE FROM homework_done');
  },
};
