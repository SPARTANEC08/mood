/**
 * Публичные тексты документов и приём согласий.
 *
 * `/api/legal/documents` открыт без токена: экран входа показывает ссылки до
 * авторизации. Всё остальное требует сессии.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  LEGAL_DOCUMENTS,
  LOGIN_CONSENTS,
  POLICY_DOCUMENT,
} from '../../legal/registry.ts';
import { acceptConsents, buildLegalStatus } from '../../legal/consentService.ts';
import type { LegalDocId } from '../../legal/types.ts';
import { requireUser } from '../middleware/auth.ts';

const ACCEPTABLE = new Set<string>(Object.keys(LEGAL_DOCUMENTS));

function readTypes(request: FastifyRequest): LegalDocId[] {
  const body = (request.body ?? {}) as { types?: unknown; consents?: unknown };
  const raw = Array.isArray(body.types)
    ? body.types
    : Array.isArray(body.consents)
      ? body.consents
      : [];

  const seen = new Set<LegalDocId>();
  for (const value of raw) {
    if (typeof value !== 'string' || !ACCEPTABLE.has(value)) continue;
    seen.add(value as LegalDocId);
  }
  return [...seen];
}

export function registerLegalRoutes(app: FastifyInstance): void {
  /** Список документов и их версии. Доступен до входа. */
  app.get('/api/legal/documents', async () => ({
    documents: Object.values(LEGAL_DOCUMENTS),
    policy: POLICY_DOCUMENT,
    required: LOGIN_CONSENTS,
  }));

  /** Текущий статус согласий авторизованного пользователя. */
  app.get('/api/legal/status', async (request) => {
    const user = requireUser(request);
    return buildLegalStatus(user);
  });

  /**
   * Приём согласий с экрана «обновились условия» или из профиля.
   *
   * Версии не принимаются от клиента: сервер берёт актуальные из реестра.
   */
  app.post('/api/consents', async (request, reply) => {
    const user = requireUser(request);
    const types = readTypes(request);

    if (types.length === 0) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Не передан ни один документ для принятия.',
      });
    }

    const updated = acceptConsents(user, types, {
      ip: request.ip,
      method: 'pwa',
    });

    return reply.send(buildLegalStatus(updated));
  });
}
