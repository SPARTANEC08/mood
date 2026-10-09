import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { searchGroupOnMpei } from '../parser/mpeiApi.ts';
import { BarsClient, SessionExpiredError } from '../services/bars/barsClient.js';
import { BarsService } from '../services/bars/barsService.js';
import type { SavedSessionData, StudentInfo } from '../services/bars/barsClient.js';
import { TelegramUser, userStore } from '../storage/userStore.ts';
import { decrypt, encrypt } from '../utils/crypto.ts';
import { b, esc, i, quote, RULE, toneButton, truncate } from './format.ts';
import { buildMainScheduleView, InlineButton } from './scheduleView.ts';
import {
  buildAuthErrorView,
  buildTwoFactorPromptView,
} from './authView.ts';

/**
 * Асинхронное событие онбординга, которое нужно «доставить» в чат
 * (главное сообщение редактируется из фоновой задачи авторизации).
 */
export interface AuthFlowUpdate {
  telegramId: number;
  messageText: string;
  keyboard?: InlineButton[][];
  toast?: string;
}

export type AuthFlowListener = (update: AuthFlowUpdate) => void | Promise<void>;

const DEFAULT_DASHBOARD_URL = '/bars_web/ST_Study/Main/Main';

/** Сколько ждём код 2FA от пользователя, прежде чем сбросить воронку. */
const TWO_FA_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Отложенное разрешение: воронка 2FA ждёт код из следующего сообщения пользователя.
 */
interface DeferredCode {
  resolve: (code: string) => void;
}

const pending2FA = new Map<number, DeferredCode>();
const loginInFlight = new Set<number>();

let listener: AuthFlowListener | null = null;

/**
 * Регистрирует канал доставки асинхронных обновлений онбординга (telegramService).
 */
export function setAuthFlowListener(fn: AuthFlowListener | null): void {
  listener = fn;
}

function emit(update: AuthFlowUpdate): void {
  if (!listener) {
    console.warn('[AuthFlow] Нет слушателя обновлений, сообщение не доставлено:', update.messageText);
    return;
  }
  try {
    const res = listener(update);
    if (res instanceof Promise) {
      res.catch((err: unknown) => console.error('[AuthFlow] Ошибка доставки обновления:', err));
    }
  } catch (err: unknown) {
    console.error('[AuthFlow] Ошибка доставки обновления:', err);
  }
}

/**
 * Временный файл сессии: не хранит пароль на диске, удаляется сразу после чтения.
 */
function makeTempSessionPath(): string {
  return path.join(os.tmpdir(), `zbot-bars-${randomUUID()}.json`);
}

async function removeTempSessionFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * Расшифровывает сохраненные логин и пароль из записи пользователя.
 */
export function readBarsCredentials(user: TelegramUser): { login: string; password: string } {
  const auth = user.barsAuth;
  if (!auth) {
    throw new Error('Данные авторизации БАРС не найдены.');
  }

  // У пароля собственные IV и tag; fallback на iv/tag логина — для записей,
  // созданных до разделения nonce.
  const passIv = auth.ivPass ?? auth.iv;
  const passTag = auth.tagPass ?? auth.tag;

  return {
    login: decrypt(auth.encryptedLogin, auth.iv, auth.tag),
    password: decrypt(auth.encryptedPass, passIv, passTag),
  };
}

/**
 * Живой BarsClient пользователя, готовый к запросам.
 */
interface CachedBarsClient {
  service: BarsService;
  /** Отпечаток сессии: меняется при каждом новом входе. */
  sessionKey: string;
  /** Когда клиент последний раз использовали — по этому живёт TTL. */
  usedAt: number;
  /** Создаётся ли клиент прямо сейчас: параллельные вызовы ждут один промис. */
  inflight: Promise<BarsService> | null;
}

/**
 * Клиенты БАРС в памяти, по одному на пользователя.
 *
 * Раньше клиент пересоздавался на каждый вызов сервиса, а восстановление сессии
 * шло через временный файл: запись и удаление на каждый чих. При 50 студентах
 * и 3 круга нотификатора в час это сотни операций FS в час ради данных,
 * которые уже лежат в том же users.json.
 *
 * Время жизни клиента ограничено TTL: иначе 50 клиентов с CookieJar висели бы
 * в памяти до перезапуска. Отпечаток сессии в ключе означает, что повторный
 * вход пользователя сам собой даёт новый клиент, а старый вытесняется.
 */
const barsClients = new Map<number, CachedBarsClient>();

/** Клиент бездействует дольше этого — вытесняется. */
const BARS_CLIENT_TTL_MS = 30 * 60 * 1000;

/** Больше этого клиентов одновременно в памяти держать нельзя. */
const BARS_CLIENT_LIMIT = 60;

/** Отпечаток сессии: участвует в ключе, чтобы релогин дал новый клиент. */
function sessionFingerprint(user: TelegramUser): string {
  const auth = user.barsAuth;
  return `${auth?.savedAt ?? ''}:${auth?.cookiesJson?.length ?? 0}:${auth?.cookiesJson ?? ''}`.slice(0, 512);
}

/**
 * Отбрасывает клиенты, которые давно не использовались, и лишние сверх потолка.
 * Вызывается перед созданием нового клиента.
 */
function evictBarsClients(now: number): void {
  for (const [id, entry] of barsClients) {
    if (!entry.inflight && now - entry.usedAt > BARS_CLIENT_TTL_MS) {
      barsClients.delete(id);
    }
  }

  while (barsClients.size >= BARS_CLIENT_LIMIT) {
    // Map обходит ключи в порядке вставки: первый — самый давно использованный.
    const oldest = barsClients.keys().next();
    if (oldest.done) break;
    barsClients.delete(oldest.value);
  }
}

/**
 * Забывает клиента пользователя: после сброса авторизации или смены входа
 * следующий вызов обязан создать нового клиента с нуля.
 */
export function forgetBarsClient(telegramId: number): void {
  barsClients.delete(telegramId);
}

/**
 * Сколько клиентов сейчас в памяти. Только для тестов и диагностики.
 */
export function barsClientCacheStats(): { clients: number } {
  return { clients: barsClients.size };
}

/**
 * Восстанавливает BarsClient из сохраненной сессии пользователя.
 * Используется всеми сервисными разделами (оценки, пропуски, приказы, книги).
 */
export async function createBarsServiceForUser(user: TelegramUser): Promise<BarsService> {
  const auth = user.barsAuth;
  if (!auth) {
    throw new SessionExpiredError('Нет сохраненной сессии БАРС. Требуется повторный вход.');
  }

  const now = Date.now();
  const key = sessionFingerprint(user);
  const cached = barsClients.get(user.telegramId);

  // Готовый клиент с той же сессией — возвращаем его и продлеваем жизнь.
  if (cached && !cached.inflight && cached.sessionKey === key) {
    cached.usedAt = now;
    barsClients.delete(user.telegramId);
    barsClients.set(user.telegramId, cached);
    return cached.service;
  }

  // Сессия сменилась (повторный вход) — прежний клиент больше не годится.
  if (cached && cached.sessionKey !== key) {
    barsClients.delete(user.telegramId);
  }

  // Клиент уже создаётся — ждём тот же промис, второй temp-файл не пишем.
  if (barsClients.get(user.telegramId)?.inflight) {
    return barsClients.get(user.telegramId)!.inflight!;
  }

  evictBarsClients(now);

  const inflight = buildBarsService(user);
  barsClients.set(user.telegramId, { service: null as never, sessionKey: key, usedAt: now, inflight });

  try {
    const service = await inflight;
    barsClients.set(user.telegramId, { service, sessionKey: key, usedAt: now, inflight: null });
    return service;
  } catch (err: unknown) {
    // Не оставляем неудавшийся промис в кэше: следующий вызов должен повторить.
    barsClients.delete(user.telegramId);
    throw err;
  }
}

/**
 * Создаёт клиента с нуля: расшифровывает сессию, пишет temp-файл, читает его.
 * Temp-файл нужен только здесь — loadSavedSession() умеет читать лишь с диска.
 */
async function buildBarsService(user: TelegramUser): Promise<BarsService> {
  const auth = user.barsAuth;
  if (!auth) {
    throw new SessionExpiredError('Нет сохраненной сессии БАРС. Требуется повторный вход.');
  }

  const restored = readSavedSessionPayload(auth.cookiesJson);

  const client = new BarsClient();
  const tempPath = makeTempSessionPath();

  try {
    // Сессия кладётся во временный файл и сразу удаляется: на диске остаются
    // только зашифрованные данные пользователя. Файл создаётся один раз на
    // клиента, а не на каждый сервисный вызов.
    await fs.writeFile(
      tempPath,
      JSON.stringify(
        {
          savedAt: auth.savedAt,
          finalUrl: restored.finalUrl ?? DEFAULT_DASHBOARD_URL,
          cookies: restored.cookies,
        },
        null,
        2,
      ),
      'utf-8',
    );
    await client.loadSavedSession(tempPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SessionExpiredError(`Не удалось восстановить сессию БАРС: ${msg}`);
  } finally {
    await removeTempSessionFile(tempPath);
  }

  return new BarsService(client);
}

/**
 * Разбирает сохранённую сессию. Поддерживает как «голые» куки,
 * так и конверт { cookies, finalUrl }.
 */
function readSavedSessionPayload(cookiesJson: string): SavedSessionData {
  const parsed = JSON.parse(cookiesJson) as unknown;

  if (parsed && typeof parsed === 'object' && 'cookies' in (parsed as Record<string, unknown>)) {
    return parsed as SavedSessionData;
  }

  return { cookies: parsed };
}

/**
 * Автоматически находит groupId группы на ts.mpei.ru по названию из БАРС.
 */
async function resolveGroupOnMpei(
  groupName: string
): Promise<{ groupId?: number; groupName?: string; faculty?: string; error?: string }> {
  try {
    const res = await searchGroupOnMpei(groupName);
    if (res.success && res.group) {
      return {
        groupId: res.group.id,
        groupName: res.group.label,
        faculty: res.group.description,
      };
    }

    const suggestions = res.suggestions?.map((s) => s.label).join(', ');
    return {
      error: suggestions
        ? `Группа «${groupName}» не найдена на ts.mpei.ru. Возможно: ${suggestions}`
        : (res.error ?? `Группа «${groupName}» не найдена на ts.mpei.ru.`),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Не удалось связать группу с расписанием МЭИ: ${msg}` };
  }
}

/**
 * Финальный шаг онбординга: сохраняет ФИО, группу, зашифрованные креды и куки.
 */
async function finalizeRegistration(
  user: TelegramUser,
  login: string,
  password: string,
  studentInfo: StudentInfo,
  sessionData: SavedSessionData
): Promise<void> {
  const fullName = studentInfo.studentName?.trim() || 'Студент';
  const barsGroupName = studentInfo.groupName?.trim() || '';

  // Автоматически подтягиваем группу для расписания
  const group = barsGroupName ? await resolveGroupOnMpei(barsGroupName) : { error: 'В ЛК не указана группа.' };

  const encLogin = encrypt(login);
  const encPass = encrypt(password);

  const updated: Partial<TelegramUser> = {
    firstName: fullName.split(' ')[0] || user.firstName,
    barsAuth: {
      encryptedLogin: encLogin.encryptedData,
      encryptedPass: encPass.encryptedData,
      iv: encLogin.iv,
      tag: encLogin.tag,
      ivPass: encPass.iv,
      tagPass: encPass.tag,
      cookiesJson: JSON.stringify({
        cookies: sessionData.cookies ?? null,
        finalUrl: sessionData.finalUrl,
      }),
      savedAt: sessionData.savedAt ?? new Date().toISOString(),
    },
    studentProfile: {
      fullName,
      recordBookNumber: studentInfo.studyCard,
      groupName: barsGroupName || undefined,
    },
    groupName: group.groupName ?? barsGroupName ?? undefined,
    groupId: group.groupId,
    faculty: group.faculty,
    authState: null,
    tempAuthData: undefined,
    barsAuthedAt: new Date().toISOString(),
  };

const saved = userStore.patch(user.telegramId, updated);
  if (!saved) return;

  // Новый вход = новая сессия в cookies. Старый клиент в памяти больше не
  // годится: он держит CookieJar от прошлой авторизации.
  forgetBarsClient(user.telegramId);

  // Мгновенно отрисовываем новый главный экран.
  // Ошибка загрузки расписания не должна откатывать успешный вход,
  // поэтому экран ошибки показываем внутри, а не бросаем наружу.
  let view: { text: string; keyboard: InlineButton[][] };
  try {
    view = await renderMainSchedule(saved, group.error);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    view = {
      text: [
        `✅ ${b(`Вход выполнен: ${fullName}`)}`,
        '',
        `⚠️ ${b('Не удалось загрузить расписание')}`,
        '',
        quote(esc(truncate(msg, 240))),
      ].join('\n'),
      keyboard: [
        [toneButton('🔄 Повторить', 'session', 'refresh_schedule')],
        [toneButton('⚙️ Остальное', 'more', 'nav_more')],
        [toneButton('🚪 Выйти из аккаунта БАРС', 'logout', 'auth_logout')],
      ],
    };
  }

  emit({
    telegramId: user.telegramId,
    messageText: view.text,
    keyboard: view.keyboard,
    toast: group.error
      ? 'Вход выполнен, но расписание не найдено'
      : `Добро пожаловать, ${fullName.split(' ')[0]}!`,
  });
}

/**
 * Строит главный экран расписания, либо экран ошибки связки с МЭИ.
 */
async function renderMainSchedule(
  user: TelegramUser,
  groupWarning?: string
): Promise<{ text: string; keyboard: InlineButton[][] }> {
  const { getCachedSchedule } = await import('./botEngine.ts');

  if (typeof user.groupId !== 'number' || user.groupId <= 0) {
    return {
      text: [
        `⚠️ ${b('Не удалось определить группу')}`,
        '',
        quote(esc(truncate(groupWarning ?? 'Группа не найдена на ts.mpei.ru', 240))),
        '',
        i('Обновите сессию — группа подтянется из личного кабинета.'),
      ].join('\n'),
      keyboard: [
        [toneButton('🔄 Обновить сессию', 'session', 'auth_refresh_session')],
        [toneButton('🚪 Выйти из аккаунта БАРС', 'logout', 'auth_logout')],
      ],
    };
  }

  const schedule = await getCachedSchedule(user);
  const view = buildMainScheduleView(schedule, undefined, user);

  if (groupWarning) {
    return {
      text: `${view.text}\n\n⚠️ ${groupWarning}`,
      keyboard: view.keyboard,
    };
  }

  return view;
}

/**
 * Шаг 2: запускает вход по логину/паролю в фоне.
 */
export function startBarsLogin(user: TelegramUser, login: string, password: string): void {
  const telegramId = user.telegramId;

  if (loginInFlight.has(telegramId)) {
    return;
  }
  loginInFlight.add(telegramId);

  // Пароль намеренно НЕ сохраняется в users.json: он живёт только в памяти
  // до момента авторизации. На диск попадает исключительно зашифрованный пароль.
  userStore.patch(telegramId, { tempAuthData: { login } });

  void (async () => {
    const client = new BarsClient();
    const tempPath = makeTempSessionPath();

    try {
      const result = await client.login({
        username: login,
        password,
        saveSessionPath: tempPath,
        onStep: (msg: string) => console.log(`[AuthFlow][${telegramId}] ${msg}`),
        on2FACodeNeeded: async (info) => {
          userStore.patch(telegramId, { authState: 'AWAIT_2FA' });
          emit({
            telegramId,
            messageText: buildTwoFactorPromptView(info.channelHint).text,
            keyboard: [],
          });

          const code = await waitForTwoFactorCode(telegramId, TWO_FA_TIMEOUT_MS);
          return code;
        },
      });

      pending2FA.delete(telegramId);
      await finalizeRegistration(user, login, password, result.studentInfo, result.sessionData);
    } catch (err: unknown) {
      pending2FA.delete(telegramId);
      handleAuthFailure(user, login, err);
    } finally {
      loginInFlight.delete(telegramId);
      await removeTempSessionFile(tempPath);
    }
  })();
}

/**
 * Ожидает код 2FA от пользователя с таймаутом.
 * Таймаут нужен, чтобы «зависшая» сессия входа не блокировала бота навсегда.
 */
function waitForTwoFactorCode(telegramId: number, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending2FA.delete(telegramId);
      userStore.patch(telegramId, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
      reject(new Error('Код подтверждения не был введен.'));
    }, timeoutMs);

    pending2FA.set(telegramId, {
      resolve: (code: string) => {
        clearTimeout(timer);
        resolve(code);
      },
    });
  });
}

/**
 * Шаг 3: отправляет введённый код 2FA в шлюз авторизации.
 */
export function submitTwoFactorCode(user: TelegramUser, code: string): boolean {
  const deferred = pending2FA.get(user.telegramId);
  if (!deferred) {
    return false;
  }
  pending2FA.delete(user.telegramId);
  deferred.resolve(code);
  return true;
}

/**
 * Есть ли активный запрос кода 2FA для пользователя.
 */
export function hasPendingTwoFactor(userId: number): boolean {
  return pending2FA.has(userId);
}

/**
 * Есть ли незавершённый процесс входа (пароль принят, ждём 2FA/результат).
 */
export function isLoginInFlight(userId: number): boolean {
  return loginInFlight.has(userId);
}

/**
 * Единая обработка ошибок авторизации с возвратом на нужный шаг воронки.
 */
function handleAuthFailure(user: TelegramUser, login: string, err: unknown): void {
  const telegramId = user.telegramId;
  const rawMessage = err instanceof Error ? err.message : String(err);

  const isBadCredentials = /неверный логин или пароль/i.test(rawMessage);
  const isBad2FA = /неверный код/i.test(rawMessage);
  const isNoCode = /код подтверждения не был введен/i.test(rawMessage);

  if (isBad2FA) {
    // Сессия БАРС после неверного кода непригодна — возвращаем на ввод логина
    userStore.patch(telegramId, {
      authState: 'AWAIT_LOGIN',
      tempAuthData: undefined,
    });
    emit({
      telegramId,
      messageText: buildAuthErrorView('Неверный код подтверждения. Начните вход заново.').text,
      keyboard: buildAuthErrorView('Неверный код подтверждения. Начните вход заново.').keyboard,
    });
    return;
  }

  if (isBadCredentials) {
    userStore.patch(telegramId, {
      authState: 'AWAIT_LOGIN',
      tempAuthData: undefined,
    });
    emit({
      telegramId,
      messageText: [
        `❌ ${b('Неверный логин или пароль')}`,
        '',
        `Введите ${b('логин')} ещё раз:`,
        i('   например: st123456'),
      ].join('\n'),
      keyboard: [],
    });
    return;
  }

  if (isNoCode) {
    userStore.patch(telegramId, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
    emit({
      telegramId,
      messageText: `❌ ${b('Код подтверждения не введён')}\n${i('Начните вход заново.')}`,
      keyboard: [],
    });
    return;
  }

  userStore.patch(telegramId, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
  const view = buildAuthErrorView(`Ошибка входа: ${rawMessage}`, login);
  emit({ telegramId, messageText: view.text, keyboard: view.keyboard });
}

/**
 * Принудительно сбрасывает воронку входа (например, по кнопке «Начать заново»).
 */
export function resetAuthFlow(telegramId: number): void {
  pending2FA.delete(telegramId);
  // Клиент держит CookieJar отменённой авторизации — забываем вместе с воронкой.
  forgetBarsClient(telegramId);
  userStore.patch(telegramId, {
    authState: 'AWAIT_LOGIN',
    tempAuthData: undefined,
  });
}

/**
 * Проверяет актуальность сохранённой сессии БАРС.
 */
export async function isBarsSessionValid(user: TelegramUser): Promise<boolean> {
  try {
    const service = await createBarsServiceForUser(user);
    return await service.isSessionValid();
  } catch {
    return false;
  }
}