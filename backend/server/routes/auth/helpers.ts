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
import { isEnvBarsAdmin, isPwaAdmin } from '../../../utils/adminAuth.ts';
import { AuthError } from '../../middleware/auth.ts';
import { LOGIN_CONSENTS, PUSH_CONSENTS } from '../../../legal/registry.ts';
import type { LegalDocId } from '../../../legal/types.ts';
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

/** Типы документов, которые клиент прислал вместе с логином. */
export function readConsents(request: FastifyRequest): LegalDocId[] {
  const body = (request.body ?? {}) as { consents?: unknown };
  if (!Array.isArray(body.consents)) return [];

  const allowed = new Set<string>([...LOGIN_CONSENTS, ...PUSH_CONSENTS]);
  const seen = new Set<LegalDocId>();

  for (const value of body.consents) {
    if (typeof value !== 'string' || !allowed.has(value)) continue;
    seen.add(value as LegalDocId);
  }

  return [...seen];
}

/** Проверяет обязательные согласия до похода в БАРС. */
export function assertLoginConsents(consents: LegalDocId[]): void {
  const missing = LOGIN_CONSENTS.filter((id) => !consents.includes(id));
  if (missing.length === 0) return;

  throw new AuthError(
    'Перед входом нужно принять условия обработки данных, пользовательское соглашение и подтвердить возраст 18+.',
    400,
    'consent_required',
  );
}

/** Профиль для шапки приложения.
 *
 * ФИО берётся из БАРС — это достовернее имени в Telegram, которое человек мог
 * задать любой строкой.
 */
export function buildProfile(user: StoredUser): BootstrapResponse['profile'] {
  return {
    userId: user.userId,
    pushEnabled: user.pushEnabled !== false,
    pushDevices: user.pushSubscriptions?.length ?? 0,
    isAdmin: isPwaAdmin(user),
    isEnvAdmin: isEnvBarsAdmin(user),
    fullName: user.studentProfile?.fullName?.trim() || user.firstName || 'Студент',
    groupName: user.groupName ?? user.studentProfile?.groupName ?? '',
    faculty: user.faculty,
    recordBookNumber: user.studentProfile?.recordBookNumber,
    groupId: user.groupId,
    isGuest: user.isGuest === true,
  };
}
