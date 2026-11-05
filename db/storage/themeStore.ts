/**
 * Темы оформления, опубликованные пользователями.
 *
 * Официальные темы в базе не живут: они лежат массивом в PWA и меняются вместе
 * с релизом. Здесь только темы сообщества — их можно создать из приложения,
 * скрыть админом или удалить автором/аккаунтом.
 *
 * Автор хранится в `author_user_id` ради лимитов публикаций и удаления своей
 * темы, но наружу не отдаётся: публичный ответ содержит только `mine`.
 *
 * Статусы:
 *   published — видна всем в списке;
 *   hidden    — скрыта админом, автор её видит только как «свою» в служебных
 *               ответах и не видит в публичном списке;
 *   deleted   — мягкое удаление; строка остаётся, чтобы id не переиспользовался.
 */

import { randomUUID } from 'node:crypto';

import { getDb } from '../sqlite.ts';

export type ThemeVariantKey = 'light' | 'dark';

/** Три оттенка одной версии темы. Насыщенность и светлота вычисляются на клиенте. */
export interface ThemeVariant {
  backgroundHue: number;
  surfaceHue: number;
  accentHue: number;
}

export type ThemeVariants = Partial<Record<ThemeVariantKey, ThemeVariant>>;

export type ThemeStatus = 'published' | 'hidden' | 'deleted';

export interface StoredTheme {
  id: string;
  authorUserId: string;
  name: string;
  variants: ThemeVariants;
  status: ThemeStatus;
  createdAt: string;
  updatedAt: string;
}

/** Тема без автора — то, что можно отдавать клиенту. */
export interface PublicTheme {
  id: string;
  name: string;
  variants: ThemeVariants;
  createdAt: string;
  mine: boolean;
}

/** Тема для админки: та же публичная форма плюс статус. */
export interface AdminTheme extends Omit<PublicTheme, 'mine'> {
  status: ThemeStatus;
}

interface ThemeRow {
  id: string;
  author_user_id: string;
  name: string;
  variants: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function parseVariants(raw: string): ThemeVariants {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ThemeVariants;
  } catch {
    return {};
  }
}

function fromRow(row: ThemeRow): StoredTheme {
  return {
    id: row.id,
    authorUserId: row.author_user_id,
    name: row.name,
    variants: parseVariants(row.variants),
    status: row.status === 'hidden' || row.status === 'deleted' ? row.status : 'published',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublic(theme: StoredTheme, viewerUserId: string): PublicTheme {
  return {
    id: theme.id,
    name: theme.name,
    variants: theme.variants,
    createdAt: theme.createdAt,
    mine: theme.authorUserId === viewerUserId,
  };
}

function toAdmin(theme: StoredTheme): AdminTheme {
  return {
    id: theme.id,
    name: theme.name,
    variants: theme.variants,
    createdAt: theme.createdAt,
    status: theme.status,
  };
}

export const themeStore = {
  create(input: {
    authorUserId: string;
    name: string;
    variants: ThemeVariants;
  }): StoredTheme {
    const db = getDb();
    const now = new Date().toISOString();
    const theme: StoredTheme = {
      id: `thm_${randomUUID()}`,
      authorUserId: input.authorUserId,
      name: input.name,
      variants: input.variants,
      status: 'published',
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      'INSERT INTO themes(id, author_user_id, name, variants, status, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      theme.id,
      theme.authorUserId,
      theme.name,
      JSON.stringify(theme.variants),
      theme.status,
      theme.createdAt,
      theme.updatedAt,
    );

    return theme;
  },

  getById(id: string): StoredTheme | null {
    const row = getDb()
      .prepare('SELECT id, author_user_id, name, variants, status, created_at, updated_at FROM themes WHERE id = ?')
      .get(id) as ThemeRow | undefined;

    return row ? fromRow(row) : null;
  },

  /** Публичный список: только published, новые сверху. */
  listPublished(viewerUserId: string, limit = 100): PublicTheme[] {
    const rows = getDb()
      .prepare(
        'SELECT id, author_user_id, name, variants, status, created_at, updated_at ' +
          'FROM themes WHERE status = \'published\' ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(limit) as ThemeRow[];

    return rows.map((row) => toPublic(fromRow(row), viewerUserId));
  },

  /** Список для админки. `all` — published + hidden, без удалённых. */
  listAdmin(status: 'published' | 'hidden' | 'all' = 'all'): AdminTheme[] {
    const rows =
      status === 'all'
        ? (getDb()
            .prepare(
              'SELECT id, author_user_id, name, variants, status, created_at, updated_at ' +
                "FROM themes WHERE status IN ('published', 'hidden') ORDER BY created_at DESC, id DESC",
            )
            .all() as ThemeRow[])
        : (getDb()
            .prepare(
              'SELECT id, author_user_id, name, variants, status, created_at, updated_at ' +
                'FROM themes WHERE status = ? ORDER BY created_at DESC, id DESC',
            )
            .all(status) as ThemeRow[]);

    return rows.map((row) => toAdmin(fromRow(row)));
  },

  /** Сколько тем создано за окно — для лимита публикаций. Удалённые тоже
   * считаются: удаление не должно сбрасывать суточный лимит. */
  createdSince(authorUserId: string, sinceIso: string): StoredTheme[] {
    const rows = getDb()
      .prepare(
        'SELECT id, author_user_id, name, variants, status, created_at, updated_at ' +
          'FROM themes WHERE author_user_id = ? AND created_at >= ? ' +
          'ORDER BY created_at ASC',
      )
      .all(authorUserId, sinceIso) as ThemeRow[];

    return rows.map(fromRow);
  },

  /** Сколько всего не удалённых тем у автора. */
  countByAuthor(authorUserId: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS count FROM themes WHERE author_user_id = ? AND status != 'deleted'")
      .get(authorUserId) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  setStatus(id: string, status: ThemeStatus): boolean {
    const result = getDb()
      .prepare('UPDATE themes SET status = ?, updated_at = ? WHERE id = ? AND status != \'deleted\'')
      .run(status, new Date().toISOString(), id);

    return result.changes > 0;
  },

  /** Полное удаление тем автора при удалении аккаунта. */
  deleteByAuthor(authorUserId: string): number {
    const result = getDb().prepare('DELETE FROM themes WHERE author_user_id = ?').run(authorUserId);
    return result.changes;
  },

  /** Только для скриптов и тестов. */
  reset(): void {
    getDb().exec('DELETE FROM themes');
  },
};
