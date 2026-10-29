/**
 * Реестр юридических документов: единственное место, где живут версии.
 *
 * Любая проверка согласия сравнивает сохранённую версию с этой. Подняли
 * версию здесь — у всех пользователей документ снова считается непринятым,
 * и приложение обязано показать экран принятия.
 */

import type { ConsentSnapshot, LegalDocId, LegalDocument } from './types.ts';

export const LEGAL_DOCUMENTS: Record<LegalDocId, LegalDocument> = {
  processing: {
    id: 'processing',
    version: '1.0',
    title: 'Согласие на обработку персональных данных',
    shortTitle: 'Обработка персональных данных',
    url: '/legal/consent-processing.html',
    required: true,
  },
  dissemination: {
    id: 'dissemination',
    version: '1.0',
    title: 'Согласие на предоставление данных одногруппникам',
    shortTitle: 'Данные в материалах группы',
    url: '/legal/consent-dissemination.html',
    required: true,
  },
  push: {
    id: 'push',
    version: '1.0',
    title: 'Согласие на уведомления в приложении (Web Push)',
    shortTitle: 'Push-уведомления',
    url: '/legal/consent-push.html',
    required: false,
  },
  terms: {
    id: 'terms',
    version: '1.0',
    title: 'Пользовательское соглашение',
    shortTitle: 'Пользовательское соглашение',
    url: '/legal/terms.html',
    required: true,
  },
  guest: {
    id: 'guest',
    version: '1.0',
    title: 'Согласие для гостевого режима',
    shortTitle: 'Гостевой режим',
    url: '/legal/consent-guest.html',
    required: false,
  },
  age: {
    id: 'age',
    version: '1.0',
    title: 'Подтверждение возраста 18+',
    shortTitle: 'Подтверждение 18+',
    url: '/legal/age-18.html',
    required: true,
  },
};

/** Политика — информационный документ, галочки не требует. */
export const POLICY_DOCUMENT = {
  id: 'privacy',
  version: '1.0',
  title: 'Политика обработки персональных данных',
  url: '/legal/privacy-policy.html',
} as const;

/** Что обязательно принять при обычном входе. */
export const LOGIN_CONSENTS: LegalDocId[] = [
  'processing',
  'dissemination',
  'terms',
  'age',
];

/** Что обязательно принять гостю. */
export const GUEST_CONSENTS: LegalDocId[] = ['processing', 'terms', 'age', 'guest'];

/** Что нужно для включения Web Push. */
export const PUSH_CONSENTS: LegalDocId[] = ['push'];

/**
 * Полный набор обязательных документов для уже существующего пользователя.
 *
 * Push становится обязательным только если у человека уже есть подписки:
 * нельзя требовать согласие на канал, которым он не пользуется. Если push
 * включён позже, согласие спрашивается в момент подписки.
 */
export function requiredDocIds(user: {
  isGuest?: boolean;
  pushSubscriptions?: unknown[];
}): LegalDocId[] {
  const ids: LegalDocId[] = ['processing', 'terms', 'age'];

  if (user.isGuest === true) {
    ids.push('guest');
  } else {
    ids.push('dissemination');
  }

  if ((user.pushSubscriptions?.length ?? 0) > 0) ids.push('push');

  return ids;
}

export function isConsentCurrent(
  consent: ConsentSnapshot | undefined,
  document: LegalDocument,
): boolean {
  return !!consent && consent.version === document.version;
}

/** Документы, которые пользователь ещё не принял в актуальной версии. */
export function missingConsents(user: {
  consents?: Partial<Record<LegalDocId, ConsentSnapshot>>;
  isGuest?: boolean;
  pushSubscriptions?: unknown[];
}): LegalDocId[] {
  return requiredDocIds(user).filter(
    (id) => !isConsentCurrent(user.consents?.[id], LEGAL_DOCUMENTS[id]),
  );
}

export function hasAllConsents(user: {
  consents?: Partial<Record<LegalDocId, ConsentSnapshot>>;
  isGuest?: boolean;
  pushSubscriptions?: unknown[];
}): boolean {
  return missingConsents(user).length === 0;
}
