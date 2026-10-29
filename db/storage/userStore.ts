import { randomUUID } from 'node:crypto';

import { JsonDocument } from '../jsonStore.ts';
import { computeBarsLoginHash } from '../../backend/utils/barsLoginHash.ts';
import type { UserPlatform } from '../../backend/utils/platform.ts';
import type { ConsentSnapshot, LegalDocId } from '../../backend/legal/types.ts';
import {
  emptyDocument,
  nowIso,
  reindex,
  resolveUserId,
  type UsersDocument,
} from './userStore/indexes.ts';

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
 * Сессия OWA (веб-почта mail.mpei.ru/owa).
 *
 * Хранится ОТДЕЛЬНО от `barsAuth`: это другая сессия другого сервиса, и её
 * истечение/сброс не должны затрагивать БАРС (и наоборот). Креды те же (логин
 * БАРС), но cookie-сессия своя.
 */
export interface OwaAuthData {
  /** cookies OWA в формате tough-cookie toJSON (строка). */
  cookiesJson: string;
  /** Момент сохранения (мс) — для TTL/диагностики. */
  savedAt: number;
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

/**
 * Активный PWA-токен.
 *
 * Хранится только хэш: сам токен живёт в localStorage телефона, и в базе он
 * лежать не должен — иначе утечка файла даёт готовые сессии. Хэш нужен, чтобы
 * отозвать конкретный токен (выход) и убрать просроченные.
 */
export interface PwaTokenRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

/**
 * Подписка браузера на Web Push.
 *
 * endpoint — адрес push-сервиса (FCM, Mozilla, Apple), он же уникальный ключ
 * устройства. keys — публичная часть шифрования payload; приватный ключ
 * остаётся в браузере и на сервер не попадает.
 */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  /** Когда подписка последний раз успешно принимала пуш. */
  lastUsedAt?: string;
  /** User-Agent устройства — только для диагностики, без личности. */
  userAgent?: string;
}

/**
 * Запись пользователя.
 *
 * Ключ — userId, а не telegramId, потому что человек может пользоваться
 * приложением вообще без Telegram: PWA вход идёт по логину БАРС, и телеграм у
 * такого пользователя может быть чужим или отсутствовать совсем. userId
 * выдаётся при первом входе где угодно и дальше не меняется.
 *
 * telegramId опционален: он есть только у тех, кто подключил уведомления.
 * Значение null означает «была привязка, теперь её нет» — в отличие от
 * отсутствующего поля, которое означает «привязки не было никогда». Различие
 * нужно для переезда между аккаунтами: снять старую привязку и записать новую
 * должна одна и та же операция, а раз она одна — состояния неразличимы и не
 * нужны. В индексе byTelegramId null не попадает (см. reindex).
 */
export interface StoredUser {
  userId: string;
  /** sha256 от нормализованного логина БАРС — общая точка для бота и PWA */
  barsLoginHash: string;
  /** Telegram-аккаунт, подключённый к уведомлениям. null = отвязан. */
  telegramId?: number | null;
  /**
   * Присылать ли уведомления в Telegram.
   *
   * Не флаг «включены», а флаг согласия: уведомления идут всем, кто привязан,
   * кроме тех, кто их явно выключил (false). Отсутствие поля — обычное
   * состояние, оно равносильно true, иначе каждый новый пользователь молчал бы
   * до первого открытия профиля.
   */
  notificationsEnabled?: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
  /** Название группы МЭИ (заполняется автоматически из БАРС) */
  groupName?: string;
  /** ID группы на ts.mpei.ru (заполняется автоматически из БАРС) */
  groupId?: number;
  faculty?: string;
  /**
   * Гостевой профиль: группа и имя без входа в БАРС.
   *
   * Гость не имеет barsAuth, не получает уведомления и не считается
   * BARS-сессией. Флаг нужен, чтобы не путать его с обычным пользователем
   * в статистике и в guard'ах.
   */
  isGuest?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Данные доступа к БАРС МЭИ (зашифрованные) */
  barsAuth?: BarsAuthData;
  /** Сессия веб-почты OWA (cookies), отдельно от БАРС */
  owaAuth?: OwaAuthData;
  /** ФИО и номер зачётной книжки */
  studentProfile?: StudentProfile;
  /** Текущий шаг входа в БАРС */
  authState?: AuthState;
  /** Временные данные авторизации */
  tempAuthData?: TempAuthData;
  /** Дата последнего успешного входа */
  barsAuthedAt?: string;
  /** Активные PWA-токены (только хэши) */
  pwaTokens?: PwaTokenRecord[];
  /** Подписки на Web Push: по одной на устройство. */
  pushSubscriptions?: PushSubscriptionRecord[];
  /**
   * Присылать ли Web Push в приложение.
   *
   * Независим от notificationsEnabled (это Telegram): человек сам выбирает
   * канал — Telegram, приложение, оба или ни одного. Отсутствие поля означает
   * «включено»: подписка всё равно появляется только после явного разрешения
   * в браузере, и молчаливого канала из ниоткуда не возникает.
   */
  pushEnabled?: boolean;
  /**
   * Актуальные акцепты юридических документов: тип → версия и метаданные.
   *
   * Здесь только текущее состояние. Полная история (включая отзывы) — в
   * consents.json, см. db/storage/consentStore.ts.
   */
  consents?: Partial<Record<LegalDocId, ConsentSnapshot>>;
  /**
   * Платформа последнего клиента (iOS / Android / Web / unknown).
   *
   * Обновляется при входе и при смене заголовков запроса, а не на каждый
   * запрос: иначе users.json переписывался бы постоянно. Отсутствие поля —
   * обычное состояние старых записей, в статистике оно считается как unknown.
   */
  platform?: UserPlatform;
}

/**
 * Файл users.json: записи и индексы (см. userStore/indexes.ts).
 */
const document = new JsonDocument<UsersDocument>('users.json');

function read(): UsersDocument {
  const doc = document.read();
  // Форма может быть старой (плоская карта telegramId → запись) или пустой:
  // приводим к новой на чтении, чтобы один неудачный запуск не ломал бот.
  if (!doc || typeof doc !== 'object') return emptyDocument();

  if (!doc.users || !doc.index) return emptyDocument();

  doc.index.byTelegramId ??= {};
  doc.index.byBarsLoginHash ??= {};

  return doc;
}

/** Пишет документ и оба индекса одной атомарной операцией. */
function commit(doc: UsersDocument): void {
  document.stage(doc);
  document.save();
}

/**
 * Пользователь в коде бота.
 *
 * Отличие от StoredUser одно: telegramId обязателен. Запись, найденная по
 * Telegram ID, всегда его содержит, и боту незачем везде проверять на
 * undefined — он физически не работает с записями, у которых нет телеграма.
 */
export type TelegramUser = StoredUser & { telegramId: number };

function lookup(key: number | string): StoredUser | undefined {
  const doc = read();
  const userId = resolveUserId(doc, key);
  return userId ? doc.users[userId] : undefined;
}

function getUser(key: number): TelegramUser | undefined;
function getUser(key: string): StoredUser | undefined;
function getUser(key: number | string): StoredUser | undefined {
  const user = lookup(key);
  if (user && typeof key === 'number') return user as TelegramUser;
  return user;
}

/**
 * Основное хранилище пользователей.
 *
 * Методы, где первым аргументом стоит telegramId, оставлены по привычному для
 * бота виду: бот знает только Telegram ID, а userId он получает через индекс.
 * Всё внутри работает с userId — то есть с той же записью, к которой приходит
 * PWA по своему токену.
 */
export const userStore = {
  // ── чтение ──────────────────────────────────────────────────────────────

  /** По userId — так приходит PWA. */
  getByUserId(userId: string): StoredUser | undefined {
    return read().users[userId];
  },

  /** По Telegram ID (бот) или userId (PWA). */
  get: getUser,

  /** По хэшу логина БАРС — мост между ботом и PWA. */
  getByBarsLoginHash(barsLoginHash: string): StoredUser | undefined {
    const doc = read();
    const userId = doc.index.byBarsLoginHash[barsLoginHash];
    return userId ? doc.users[userId] : undefined;
  },

  /** По самому логину: хэш считается здесь же. */
  getByBarsLogin(login: string): StoredUser | undefined {
    return this.getByBarsLoginHash(computeBarsLoginHash(login));
  },

  all(): StoredUser[] {
    return Object.values(read().users);
  },

  // ── создание и запись ────────────────────────────────────────────────────

  /**
   * Создаёт запись пользователя.
   *
   * userId выдаётся здесь и больше не меняется: это и есть личность человека
   * для обоих клиентов.
   */
  create(init: {
    barsLoginHash: string;
    telegramId?: number;
    firstName?: string;
  }): StoredUser {
    const doc = read();

    const user: StoredUser = {
      userId: randomUUID(),
      barsLoginHash: init.barsLoginHash,
      telegramId: init.telegramId,
      firstName: init.firstName ?? 'Студент',
      pwaTokens: [],
      pushSubscriptions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    doc.users[user.userId] = user;
    reindex(doc);
    commit(doc);

    return user as TelegramUser;
  },

  /**
   * Запись целиком: поля с `undefined` удаляются, остальные перезаписываются.
   */
  save(user: StoredUser): void {
    const doc = read();

    const next = { ...(doc.users[user.userId] ?? {}), ...user } as Record<string, unknown>;
    for (const [key, value] of Object.entries(user)) {
      if (value === undefined) delete next[key];
    }

    next.userId = user.userId;
    next.updatedAt = nowIso();

    doc.users[user.userId] = next as unknown as StoredUser;
    reindex(doc);
    commit(doc);
  },

  /**
   * Точечное обновление полей пользователя.
   * Явно переданный `undefined` удаляет поле (например, сброс tempAuthData).
   */
  patch(key: number | string, patch: Partial<StoredUser>): StoredUser | undefined {
    const doc = read();
    const userId = resolveUserId(doc, key);
    const prev = userId ? doc.users[userId] : undefined;
    if (!userId || !prev) return undefined;

    const next = { ...prev } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }

    next.updatedAt = nowIso();

    doc.users[userId] = next as unknown as StoredUser;
    // Индексы пересобираются только когда меняются ключевые поля: точечные
    // обновления (отметка токена, флаг уведомлений, креды) их не трогают, и
    // лишний проход по всем записям на каждую операцию не нужен.
    if ('telegramId' in patch || 'barsLoginHash' in patch) reindex(doc);
    commit(doc);

    return next as unknown as StoredUser;
  },

  /**
   * Точечное обновление записи по userId.
   *
   * Обёртка над patch, существующая ради читаемости вызова: patch принимает
   * `number | string`, и в коде привязки Telegram то и дело передаётся то
   * telegramId, то userId. Перепутать их молча нельзя, потому что оба — числа
   * рядом с собой, а resolveUserId трактует их по-разному.
   */
  patchByUserId(userId: string, patch: Partial<StoredUser>): StoredUser | undefined {
    return this.patch(userId, patch);
  },

  /**
   * Запись по Telegram ID.
   *
   * Возвращает undefined и для «не привязан», и для «привязка снята»: обе
   * ситуации означают одно и то же — уведомления этому чату не уходят.
   */
  findUserByTelegramId(telegramId: number): StoredUser | undefined {
    return getUser(telegramId);
  },

  /**
   * Запись по Telegram ID, создаётся при необходимости.
   *
   * Создавать заранее нечем: без хэша логина БАРС она всё равно не связана ни с
   * одним аккаунтом, поэтому настоящая личность появляется только при
   * успешном входе.
   */
  ensureByTelegramId(telegramId: number, init: Partial<StoredUser>): StoredUser {
    const existing = getUser(telegramId);
    if (existing) return existing;

    const doc = read();
    const user: StoredUser = {
      userId: randomUUID(),
      // Пустой хэш означает «зарегистрирован в Telegram, но БАРС ещё не входили».
      // Он не попадает в индекс: иначе два разных человека с пустым хэшем
      // сочлись бы одним пользователем.
      barsLoginHash: '',
      telegramId,
      firstName: init.firstName ?? 'Студент',
      lastName: init.lastName,
      username: init.username,
      pwaTokens: [],
      pushSubscriptions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    doc.users[user.userId] = user;
    reindex(doc);
    commit(doc);

    return user;
  },

  /** Прежнее имя ensureByTelegramId: вызывается из бота. */
  ensureUser(telegramId: number, init: Partial<StoredUser>): TelegramUser {
    return this.ensureByTelegramId(telegramId, init) as TelegramUser;
  },

  /**
   * Удаляет запись целиком.
   *
   * Принимается и userId, и Telegram ID — тем же правилом, что и остальные
   * методы: бот знает только Telegram ID, а вызывающий код не должен помнить,
   * какой у него ключ.
   *
   * Пользоваться надо осторожно: вместе с записью теряется привязка к БАРС,
   * и следующий вход выдаст новый userId — то есть прежние ДЗ перестанут быть
   * его. Для «выйти из аккаунта» есть logoutBarsAccount.
   */
  remove(key: number | string): StoredUser | undefined {
    const doc = read();
    const userId = resolveUserId(doc, key);
    const removed = userId ? doc.users[userId] : undefined;
    if (!userId || !removed) return undefined;

    delete doc.users[userId];
    reindex(doc);
    commit(doc);

    return removed;
  },

  /**
   * Полностью удаляет данные авторизации БАРС (вход заново).
   *
   * Запись и userId остаются: иначе человек, забывший пароль, потерял бы ещё и
   * все свои ДЗ, а при следующем входе получил бы новый userId — то есть
   * прежние записи перестали бы быть его.
   */
  clearAuth(key: number | string): void {
    const userId = resolveUserId(read(), key);
    if (!userId) return;

    this.patch(userId, {
      barsAuth: undefined,
      owaAuth: undefined,
      studentProfile: undefined,
      barsAuthedAt: undefined,
      groupId: undefined,
      faculty: undefined,
      authState: 'AWAIT_LOGIN',
      tempAuthData: undefined,
    });
  },

  /** Сохраняет cookie-сессию OWA (после успешного входа/перелогина). */
  setOwaAuth(key: number | string, cookiesJson: string): StoredUser | undefined {
    const userId = resolveUserId(read(), key);
    if (!userId) return undefined;
    return this.patch(userId, { owaAuth: { cookiesJson, savedAt: Date.now() } });
  },

  /** Забывает сессию OWA (протухла/недействительна). БАРС не трогает. */
  clearOwaAuth(key: number | string): void {
    const userId = resolveUserId(read(), key);
    if (!userId) return;
    this.patch(userId, { owaAuth: undefined });
  },

  /**
   * Выход из аккаунта БАРС в боте.
   *
   * Отличие от clearAuth — здесь исчезает и Telegram-привязка, чтобы завершить
   * использование аккаунта в боте. Для входа в PWA отвязывать Telegram больше
   * не требуется: оба клиента могут использовать одну запись.
   *
   * Сама запись и userId остаются: иначе, войдя в PWA, человек получил бы
   * новый userId и не увидел бы своих ДЗ.
   */
  logoutBarsAccount(key: number | string): void {
    const userId = resolveUserId(read(), key);
    if (!userId) return;

    this.patch(userId, {
      telegramId: undefined,
      barsAuth: undefined,
      owaAuth: undefined,
      studentProfile: undefined,
      barsAuthedAt: undefined,
      groupId: undefined,
      faculty: undefined,
      authState: 'AWAIT_LOGIN',
      tempAuthData: undefined,
    });
  },

  // ── PWA-токены ──────────────────────────────────────────────────────────

  /** Выдача токена: хэш кладётся в запись, сам токен уходит клиенту. */
  addToken(key: number | string, tokenHash: string, expiresAt: Date): StoredUser | undefined {
    const user = lookup(key);
    if (!user) return undefined;
    const userId = user.userId;

    const tokens = (user.pwaTokens ?? []).filter((t) => t.tokenHash !== tokenHash);
    tokens.push({
      tokenHash,
      createdAt: nowIso(),
      expiresAt: expiresAt.toISOString(),
    });

    return this.patch(userId, { pwaTokens: tokens });
  },

  revokeToken(key: number | string, tokenHash: string): void {
    const user = lookup(key);
    if (!user) return;
    const userId = user.userId;

    this.patch(userId, {
      pwaTokens: (user.pwaTokens ?? []).filter((t) => t.tokenHash !== tokenHash),
    });
  },

  /** Есть ли такой токен и не истёк ли он. */
  hasToken(key: number | string, tokenHash: string, now: Date = new Date()): boolean {
    const user = lookup(key);
    if (!user) return false;

    const token = (user.pwaTokens ?? []).find((t) => t.tokenHash === tokenHash);
    if (!token) return false;

    return Date.parse(token.expiresAt) > now.getTime();
  },

  /** Отметка «токеном пользовались» — чтобы видеть живые сессии. */
  touchToken(key: number | string, tokenHash: string): void {
    const user = lookup(key);
    if (!user) return;
    const userId = user.userId;

    this.patch(userId, {
      pwaTokens: (user.pwaTokens ?? []).map((t) =>
        t.tokenHash === tokenHash ? { ...t, lastUsedAt: nowIso() } : t,
      ),
    });
  },

  /** Убирает просроченные токены — вызывается при выдаче нового. */
  pruneTokens(key: number | string, now: Date = new Date()): void {
    const user = lookup(key);
    if (!user) return;
    const userId = user.userId;

    const tokens = (user.pwaTokens ?? []);
    const alive = tokens.filter((t) => Date.parse(t.expiresAt) > now.getTime());
    if (alive.length === tokens.length) return;

    this.patch(userId, { pwaTokens: alive });
  },

  /** Сбрасывает базу целиком. Используется только скриптом сброса и тестами. */
  reset(): void {
    document.replace(emptyDocument());
  },

  /** Путь к файлу — нужен скрипту сброса базы. */
  get filePath(): string {
    return document.path;
  },
};

/**
 * Авторизован ли пользователь в БАРС МЭИ (есть ли зашифрованные данные и профиль).
 */
export function isBarsAuthorized(user: StoredUser | undefined): user is StoredUser {
  if (!user) return false;
  return Boolean(user.barsAuth && user.studentProfile?.fullName);
}

/**
 * Готов ли пользователь к показу расписания (авторизация + найдена группа на ts.mpei.ru).
 */
export function isScheduleReady(user: StoredUser | undefined): user is StoredUser {
  if (!isBarsAuthorized(user)) return false;
  return typeof user.groupId === 'number' && user.groupId > 0;
}
