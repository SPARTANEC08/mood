/**
 * Типы процесса входа в БАРС через PWA.
 *
 * Вынесены отдельно, потому что разделяются между логином (создаёт попытку),
 * продолжением входа кодом 2FA (дожидается того же промиса) и вспомогательными
 * модулями. Здесь нет логики — только форма данных.
 */

import type { SavedSessionData, StudentInfo } from '../../../services/bars/barsClient.ts';

/**
 * Незавершённый вход с двухфакторной аутентификацией. Хранится в памяти
 * процесса: код подтверждения живёт минуты и переживать перезапуск не должен.
 */
export interface PendingLogin {
  /** Ключ этой попытки в pendingLogins; он же challengeId для клиента. */
  challengeId: string;
  login: string;
  password: string;
  barsLoginHash: string;
  /** Ключ ограничителя: адрес клиента, начавшего вход. */
  owner: string;
  createdAt: number;
  /** БАРС уже попросил код: попытку можно переиспользовать при повторном входе. */
  needs2fa: boolean;
  /** Вход завершился (успехом или ошибкой); переиспользовать нельзя. */
  settled: boolean;
  /** Разрешает ожидание кода внутри BarsAuth. */
  resolveCode: (code: string) => void;
  /** Промис входа, запущенный в момент создания записи. */
  loginPromise: Promise<BarsLoginResult>;
}

/** Результат успешного входа в БАРС. */
export interface BarsLoginResult {
  success: boolean;
  studentInfo: StudentInfo;
  sessionData: SavedSessionData;
}

/** Итог попытки входа: завершилась, требует кода или упала. */
export type LoginOutcome =
  | { kind: 'done'; result: BarsLoginResult }
  | { kind: 'two_factor' }
  | { kind: 'error'; error: unknown };
