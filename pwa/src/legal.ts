/**
 * Клиентские метаданные документов для экрана входа и профиля.
 *
 * Версии здесь не хранятся: сервер — источник правды и сам подставляет
 * актуальную версию при приёме согласия. Клиенту нужны только название и
 * ссылка, чтобы человек мог прочитать текст до галочки.
 */

import type { LegalDocId } from '@/types/api';

export interface LoginDocumentLink {
  id: LegalDocId;
  title: string;
  url: string;
}

/** Что показывается при обычном входе. Порядок = порядок галочек. */
export const LOGIN_DOCUMENTS: LoginDocumentLink[] = [
  {
    id: 'processing',
    title: 'Согласие на обработку персональных данных',
    url: '/legal/consent-processing.html',
  },
  {
    id: 'dissemination',
    title: 'Согласие на предоставление данных одногруппникам',
    url: '/legal/consent-dissemination.html',
  },
  {
    id: 'terms',
    title: 'Пользовательское соглашение',
    url: '/legal/terms.html',
  },
  {
    id: 'age',
    title: 'Подтверждение возраста 18+',
    url: '/legal/age-18.html',
  },
];

/** Гостевой вход: обработка, соглашение, 18+ и короткое согласие гостя. */
export const GUEST_DOCUMENTS: LoginDocumentLink[] = [
  LOGIN_DOCUMENTS.find((document) => document.id === 'processing')!,
  LOGIN_DOCUMENTS.find((document) => document.id === 'terms')!,
  LOGIN_DOCUMENTS.find((document) => document.id === 'age')!,
  {
    id: 'guest',
    title: 'Согласие для гостевого режима',
    url: '/legal/consent-guest.html',
  },
];

/** Политика — справочный документ, без отдельной галочки. */
export const POLICY_LINK = {
  title: 'Политика обработки персональных данных',
  url: '/legal/privacy-policy.html',
};

/** Согласие на Web Push требуется в момент включения уведомлений. */
export const PUSH_DOCUMENT: LoginDocumentLink = {
  id: 'push',
  title: 'Согласие на push-уведомления',
  url: '/legal/consent-push.html',
};
