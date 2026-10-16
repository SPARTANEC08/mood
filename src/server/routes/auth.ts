/**
 * Маршруты входа и профиля PWA — точка сборки.
 *
 * Раньше этот файл держал всё сразу: вход с 2FA, выпуск и отзыв токена,
 * bootstrap и профиль. Теперь логика разложена по подмодулям с одной
 * ответственностью (см. папку auth/), а здесь только регистрация и сохранение
 * публичных экспортов, чтобы импорты в остальном коде не менялись:
 *
 *   - auth/login.ts   — вход, регистрация-алиас, 2FA и состояние попыток;
 *   - auth/tokens.ts  — выпуск/отзыв PWA-токена (logout, refresh);
 *   - auth/bootstrap.ts — /me, /config и агрегированный /bootstrap;
 *   - auth/helpers.ts — чтение кредов, ключ ограничителя, профиль;
 *   - auth/types.ts   — формы данных попытки входа.
 *
 * Публичный контракт (пути, коды ошибок, заголовки) не менялся.
 */

import type { FastifyInstance } from 'fastify';

import { AuthError } from '../middleware/auth.ts';
import { registerBootstrapRoutes } from './auth/bootstrap.ts';
import { registerLoginRoutes } from './auth/login.ts';
import { registerTokenRoutes } from './auth/tokens.ts';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  registerLoginRoutes(app);
  registerTokenRoutes(app);
  registerBootstrapRoutes(app);
}

export { registerBootstrapRoutes } from './auth/bootstrap.ts';
export { AuthError };
