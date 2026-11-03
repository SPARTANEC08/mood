/**
 * Права администратора в PWA.
 *
 * Два источника:
 *   1. `ADMIN_BARS_LOGINS` — «корневые» админы по логину БАРС. Логины
 *      хэшируются: открытый логин в env — персональные данные, а сравнение идёт
 *      по тому же хэшу, что лежит в записи пользователя.
 *   2. `pwaAdminsStore` — назначенные из PWA по userId.
 *
 * Env-админов нельзя снять из интерфейса: иначе можно остаться без доступа.
 */

import type { FastifyRequest } from 'fastify';

import { pwaAdminsStore } from '../../db/storage/pwaAdminsStore.ts';
import { userStore, type StoredUser } from '../../db/storage/userStore.ts';
import { computeBarsLoginHash } from './barsLoginHash.ts';
import { AuthError } from '../server/middleware/auth.ts';

/** Разбирает ADMIN_BARS_LOGINS: список через запятую, пустые игнорируются. */
export function envBarsLoginHashes(): string[] {
  const raw = process.env.ADMIN_BARS_LOGINS ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((login) => computeBarsLoginHash(login));
}

export function isEnvBarsAdmin(user: StoredUser): boolean {
  if (!user.barsLoginHash) return false;
  return envBarsLoginHashes().includes(user.barsLoginHash);
}

/** Полная проверка прав для PWA. */
export function isPwaAdmin(user: StoredUser | undefined): boolean {
  if (!user || user.isGuest === true) return false;

  if (isEnvBarsAdmin(user)) return true;
  return pwaAdminsStore.has(user.userId);
}

/** Все администраторы (env + назначенные) — получатели служебных пушей. */
export function listAdminUsers(): StoredUser[] {
  return userStore.all().filter(isPwaAdmin);
}

/** 403 вместо 404: обычный пользователь не должен гадать, есть ли маршрут. */
export function requireAdmin(request: FastifyRequest): StoredUser {
  const user = request.student;
  if (!user) {
    throw new AuthError('Нужна авторизация.', 401, 'unauthorized');
  }
  if (!isPwaAdmin(user)) {
    throw new AuthError('Недостаточно прав.', 403, 'not_admin');
  }
  return user;
}

/** Управление составом админов и системными настройками — только env-админ. */
export function requireEnvAdmin(request: FastifyRequest): StoredUser {
  const user = requireAdmin(request);
  if (!isEnvBarsAdmin(user)) {
    throw new AuthError('Это действие доступно только основному администратору.', 403, 'not_env_admin');
  }
  return user;
}

/** Человеческое имя для журнала действий. */
export function adminName(user: StoredUser): string {
  return (
    user.studentProfile?.fullName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
    user.userId
  );
}
