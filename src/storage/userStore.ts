import { JsonStore } from '../utils/jsonStore.ts';

/**
 * Состояние машины онбординга через БАРС МЭИ.
 */
export type AuthState = 'AWAIT_LOGIN' | 'AWAIT_PASSWORD' | 'AWAIT_2FA' | null;

/**
 * Зашифрованные данные доступа к личному кабинету БАРС МЭИ.
 *
 * Логин и пароль шифруются AES-256-GCM раздельно, каждое со своим IV и tag:
 * повторное использование одной пары (ключ, IV) в GCM раскрывает XOR ключевого потока
 * и делает аутентификацию небезопасной.
 */
export interface BarsAuthData {
  encryptedLogin: string;
  encryptedPass: string;
  /** IV для encryptedLogin */
  iv: string;
  /** auth tag для encryptedLogin */
  tag: string;
  /** IV для encryptedPass */
  ivPass?: string;
  /** auth tag для encryptedPass */
  tagPass?: string;
  /** Сохраненная сессия (cookies в формате tough-cookie toJSON + finalUrl) */
  cookiesJson: string;
  /** Дата последней успешной проверки сессии */
  savedAt?: string;
}

/**
 * Профиль студента, извлеченный из личного кабинета БАРС.
 */
export interface StudentProfile {
  fullName: string;
  recordBookNumber?: string;
  /** Официальное название группы из БАРС */
  groupName?: string;
}

/**
 * Промежуточные данные текущей попытки авторизации.
 */
export interface TempAuthData {
  login?: string;
  password?: string;
  stepTokens?: Record<string, string>;
}

export interface TelegramUser {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  /** Название группы МЭИ (заполняется автоматически из БАРС) */
  groupName?: string;
  /** ID группы на ts.mpei.ru (заполняется автоматически из БАРС) */
  groupId?: number;
  faculty?: string;
  registeredAt: string;
  /** ID единственного "главного" сообщения бота в чате */
  mainMessageId?: number;
  /** Нижняя клавиатура (ДЗ / Важное) уже отправлена */
  replyKeyboardSent?: boolean;
  /** Данные доступа к БАРС МЭИ (зашифрованные) */
  barsAuth?: BarsAuthData;
  /** ФИО и номер зачётной книжки */
  studentProfile?: StudentProfile;
  /** Текущий шаг входа в БАРС */
  authState?: AuthState;
  /** Временные данные авторизации */
  tempAuthData?: TempAuthData;
  /** Дата последнего успешного входа */
  barsAuthedAt?: string;
}

const store = new JsonStore<TelegramUser>('users.json');

// Для незарегистрированных пользователей держим ID главного сообщения в памяти
const pendingMainMessageIds = new Map<number, number>();
// Временные сообщения с файлами, которые удаляются при следующем действии
const transientMessageIds = new Map<number, number[]>();

/**
 * Удаляет ключи с неопределенным значением, чтобы не затирать существующие данные в JSON.
 */
function compact<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) {
      (out as Record<string, unknown>)[key] = val;
    }
  }
  return out;
}

export const userStore = {
  get(telegramId: number): TelegramUser | undefined {
    return store.get(telegramId);
  },

  /**
   * Создаёт или полностью обновляет запись пользователя.
   */
  save(user: TelegramUser): void {
    const prev = store.get(user.telegramId);
    const base: TelegramUser = prev ?? { ...user };

    const next = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(user)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }

    next.mainMessageId =
      user.mainMessageId ?? prev?.mainMessageId ?? pendingMainMessageIds.get(user.telegramId);

    store.set(user.telegramId, next as unknown as TelegramUser);
  },

  /**
   * Точечное обновление полей пользователя.
   * Явно переданный `undefined` удаляет поле (например, сброс tempAuthData).
   */
  patch(telegramId: number, patch: Partial<TelegramUser>): TelegramUser | undefined {
    const prev = store.get(telegramId);
    if (!prev) return undefined;

    const next = { ...prev } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }

    store.set(telegramId, next as unknown as TelegramUser);
    return next as unknown as TelegramUser;
  },

  /**
   * Создает минимальную запись пользователя, если её ещё нет.
   */
  ensureUser(telegramId: number, init: Partial<TelegramUser>): TelegramUser {
    const prev = store.get(telegramId);
    if (prev) return prev;

    const created = {
      ...compact(init),
      telegramId,
      firstName: init.firstName ?? 'Студент',
      registeredAt: init.registeredAt ?? new Date().toISOString(),
    } as TelegramUser;

    store.set(telegramId, created);
    return created;
  },

  /**
   * Полностью удаляет запись пользователя.
   */
  remove(telegramId: number): TelegramUser | undefined {
    pendingMainMessageIds.delete(telegramId);
    transientMessageIds.delete(telegramId);
    return store.delete(telegramId);
  },

  /**
   * Все записи пользователей (включая неавторизованных).
   */
  all(): TelegramUser[] {
    return store.values();
  },

  /**
   * Полностью удаляет данные авторизации БАРС (вход заново).
   */
  clearAuth(telegramId: number): void {
    const prev = store.get(telegramId);
    if (!prev) return;
    const next: TelegramUser = { ...prev };
    delete next.barsAuth;
    delete next.studentProfile;
    delete next.barsAuthedAt;
    next.authState = 'AWAIT_LOGIN';
    next.tempAuthData = undefined;
    store.set(telegramId, next);
  },

  getMainMessageId(telegramId: number): number | undefined {
    return store.get(telegramId)?.mainMessageId ?? pendingMainMessageIds.get(telegramId);
  },

  setMainMessageId(telegramId: number, messageId: number): void {
    pendingMainMessageIds.set(telegramId, messageId);
    const user = store.get(telegramId);
    if (user && user.mainMessageId !== messageId) store.set(telegramId, { ...user, mainMessageId: messageId });
  },

  markReplyKeyboardSent(telegramId: number): void {
    const user = store.get(telegramId);
    if (user) store.set(telegramId, { ...user, replyKeyboardSent: true });
  },

  addTransientMessage(telegramId: number, messageId: number): void {
    const list = transientMessageIds.get(telegramId) ?? [];
    list.push(messageId);
    transientMessageIds.set(telegramId, list);
  },

  takeTransientMessages(telegramId: number): number[] {
    const list = transientMessageIds.get(telegramId) ?? [];
    transientMessageIds.delete(telegramId);
    return list;
  },
};

/**
 * Авторизован ли пользователь в БАРС МЭИ (есть ли зашифрованные данные и профиль).
 */
export function isBarsAuthorized(user: TelegramUser | undefined): user is TelegramUser {
  if (!user) return false;
  return Boolean(user.barsAuth && user.studentProfile?.fullName);
}

/**
 * Готов ли пользователь к показу расписания (авторизация + найдена группа на ts.mpei.ru).
 */
export function isScheduleReady(user: TelegramUser | undefined): user is TelegramUser {
  if (!isBarsAuthorized(user)) return false;
  return typeof user.groupId === 'number' && user.groupId > 0;
}