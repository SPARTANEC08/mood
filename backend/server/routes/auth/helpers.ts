/**
 * Общие помощники маршрутов входа: чтение кредов из запроса, ключ ограничителя
 * и сборка профиля для клиента.
 *
 * Вынесены из login/bootstrap/tokens, потому что используются всеми тремя:
 * клиентский ключ и чтение тела — логином, профиль — выдачей токена и
 * bootstrap-ответом.
 */

import type { FastifyRequest } from 'fastify';

import type { StoredUser } from '../../../../db/storage/userStore.ts';
import { AuthError } from '../../middleware/auth.ts';
import type { BootstrapResponse } from '../../types.ts';

/** Максимальная длина логина и пароля: БАРС столько не принимает. */
export const MAX_CREDENTIAL_LENGTH = 200;

/**
 * Ключ ограничителя попыток для PWA.
 *
 * Адрес клиента, а не userId: иначе блокировка копилась бы на том, кто уже
 * вошёл, и не защищала бы ни перебор пароля к одному логину, ни подбор логинов
 * с одного устройства. `request.ip` учитывает X-Forwarded-For только от
 * доверенного loopback proxy; читать заголовок напрямую нельзя — его задаёт
 * сам клиент.
 */
export function clientKey(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

/** Тело входа: логин и пароль БАРС. */
export function readCredentials(request: FastifyRequest): { login: string; password: string } {
  const body = (request.body ?? {}) as { login?: unknown; password?: unknown };

  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!login || !password) {
    throw new AuthError(
      'Введите логин и пароль от личного кабинета БАРС.',
      400,
      'bad_request',
    );
  }

  if (login.length > MAX_CREDENTIAL_LENGTH || password.length > MAX_CREDENTIAL_LENGTH) {
    throw new AuthError('Слишком длинный логин или пароль.', 400, 'bad_request');
  }

  return { login, password };
}

/**
 * Профиль для шапки приложения.
 *
 * ФИО берётся из БАРС — это достовернее имени в Telegram, которое человек мог
 * задать любой строкой.
 */
export function buildProfile(user: StoredUser): BootstrapResponse['profile'] {
  return {
    userId: user.userId,
    // null означает «отвязан», а для клиента это то же самое, что «не подключён»:
    // различать два состояния тому, кто показывает кнопку, незачем.
    telegramId: user.telegramId ?? undefined,
    notificationsEnabled: user.notificationsEnabled !== false,
    pushEnabled: user.pushEnabled !== false,
    pushDevices: user.pushSubscriptions?.length ?? 0,
    fullName: user.studentProfile?.fullName?.trim() || user.firstName || 'Студент',
    groupName: user.groupName ?? user.studentProfile?.groupName ?? '',
    faculty: user.faculty,
    recordBookNumber: user.studentProfile?.recordBookNumber,
    groupId: user.groupId,
    isGuest: user.isGuest === true,
  };
}
