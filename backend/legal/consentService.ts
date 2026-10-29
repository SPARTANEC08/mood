/**
 * Приём согласий: обновляет текущее состояние пользователя и пишет журнал.
 *
 * Одна точка входа и для входа, и для экрана «обновились условия», и для бота,
 * чтобы правила проверки версий не разъезжались между каналами.
 */

import { userStore, type StoredUser } from '../../db/storage/userStore.ts';
import { consentStore } from '../../db/storage/consentStore.ts';
import {
  LEGAL_DOCUMENTS,
  POLICY_DOCUMENT,
  isConsentCurrent,
  missingConsents,
} from './registry.ts';
import type { ConsentSnapshot, LegalDocId, LegalStatus } from './types.ts';

export interface ConsentMeta {
  ip?: string;
  method: 'pwa' | 'bot';
}

/**
 * Принимает перечисленные документы в их актуальных версиях.
 *
 * Неизвестные типы игнорируются: клиент не должен уметь записать произвольный
 * документ. Повторный акцепт уже принятой версии не пишет ни журнал, ни базу.
 */
export function acceptConsents(
  user: StoredUser,
  types: LegalDocId[],
  meta: ConsentMeta,
): StoredUser {
  const consents: Partial<Record<LegalDocId, ConsentSnapshot>> = {
    ...(user.consents ?? {}),
  };
  const acceptedAt = new Date().toISOString();
  let changed = false;

  for (const type of types) {
    const document = LEGAL_DOCUMENTS[type];
    if (!document) continue;
    if (isConsentCurrent(consents[type], document)) continue;

    consents[type] = {
      version: document.version,
      acceptedAt,
      ip: meta.ip,
      method: meta.method,
    };
    consentStore.accept(user.userId, type, document.version, meta);
    changed = true;
  }

  if (!changed) return user;

  return userStore.patch(user.userId, { consents }) ?? { ...user, consents };
}

/** Текущий статус для bootstrap и экрана согласий. */
export function buildLegalStatus(user: StoredUser): LegalStatus {
  const missing = missingConsents(user);

  const accepted = (Object.entries(user.consents ?? {}) as Array<
    [LegalDocId, ConsentSnapshot | undefined]
  >)
    .filter((entry): entry is [LegalDocId, ConsentSnapshot] => !!entry[1])
    .map(([id, consent]) => ({
      id,
      version: consent.version,
      acceptedAt: consent.acceptedAt,
    }));

  return {
    consentRequired: missing.length > 0,
    missing,
    accepted,
    documents: Object.values(LEGAL_DOCUMENTS),
    policy: POLICY_DOCUMENT,
  };
}
