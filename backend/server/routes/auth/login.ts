/**
 * Вход в PWA по логину и паролю БАРС, включая продолжение кодом 2FA.
 *
 * Единственный способ входа — логин и пароль личного кабинета. Отдельного шага
 * «регистрация» нет: POST /api/auth/login заводит запись, если её ещё нет, а
 * /api/auth/register оставлен алиасом для развёрнутых сборок в кэше SW.
 *
 * Здесь живёт и состояние незавершённых входов (pendingLogins): вход начинается
 * сразу и висит, ожидая код, а запрос с кодом дожидается того же промиса, чтобы
 * не платить второй поход в БАРС.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { forgetBarsClient, forgetBarsSessionValid } from '../../../services/bars/barsServiceFactory.ts';
import { looksLikeStudentProfile } from '../../../services/bars/barsAuth.ts';
import { safeErrorMessage } from '../../../../tg/format.ts';
import { searchGroupOnMpei } from '../../../parser/mpeiApi.ts';
import { BarsClient } from '../../../services/bars/barsClient.ts';
import { encrypt } from '../../../utils/crypto.ts';
import { computeBarsLoginHash } from '../../../utils/barsLoginHash.ts';
import {
  checkLoginAllowed,
  formatRetryAfter,
  registerLoginFailure,
  registerLoginSuccess,
} from '../../../utils/loginLimiter.ts';
import { type StoredUser, userStore } from '../../../../db/storage/userStore.ts';
import { registrationStore } from '../../../../db/storage/registrationStore.ts';
import { detectPlatform, type UserPlatform } from '../../../utils/platform.ts';
import { AuthError } from '../../middleware/auth.ts';
import { acceptConsents } from '../../../legal/consentService.ts';
import type { LegalDocId } from '../../../legal/types.ts';
import { assertLoginConsents, clientKey, readConsents, readCredentials } from './helpers.ts';
import { issueToken } from './tokens.ts';
import type { BarsLoginResult, LoginOutcome, PendingLogin } from './types.ts';

/**
 * Сколько сервер ждёт ответа БАРС на логин с паролем.
 *
 * 45 секунд — с запасом над клиентским таймаутом входа (60 с), чтобы решение
 * «не дождались» принимал сервер, а не телефон: в этом случае он может сказать
 * «БАРС не ответил» вместо «нет связи с сервером», и человек понимает, что
 * повторять надо позже, а не чинить сеть.
 *
 * Почему ограничение вообще нужно. axios в BarsClient имеет свой таймаут в 30 с,
 * но вход — это не один запрос, а цепочка из пяти (см. barsAuth), и между ними
 * ждёт код подтверждения. Если БАРС зависнет намертво, без предела здесь запрос
 * висел бы до бесконечности: клиент отвалится по своему таймауту, а попытка
 * останется в pendingLogins и будет держать открытый поход в БАРС.
 */
const LOGIN_ATTEMPT_TIMEOUT_MS = 45_000;

const pendingLogins = new Map<string, PendingLogin>();
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Убирает протукшие попытки: иначе память растёт с каждым неудачным входом. */
function sweepPending(): void {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (now - entry.createdAt > PENDING_TTL_MS) {
      pendingLogins.delete(id);
      // Не оставляем BarsAuth навсегда висящим на незавершённом коде 2FA.
      entry.resolveCode('');
      void entry.loginPromise.then(
        () => cleanupSessionFile(id),
        () => cleanupSessionFile(id),
      );
    }
  }
}

const pendingSweepTimer = setInterval(sweepPending, 60_000);
pendingSweepTimer.unref?.();

/** Путь временного файла сессии конкретной попытки. */
function sessionFile(challengeId: string): string {
  return path.join(os.tmpdir(), `mood-bars-${challengeId}.json`);
}

/**
 * Запускает вход в БАРС и следит, попросит ли БАРС код подтверждения.
 *
 * Вход начинается сразу, а не после ответа клиенту: иначе второй запрос с
 * кодом запустил бы новый поход в БАРС и получил бы другую сессию, чем первый.
 *
 * Гонка между завершением входа и флагом «нужен код» позволяет ответить
 * клиенту сразу, не дожидаясь входа.
 */
function startLoginAttempt(
  request: FastifyRequest,
  challengeId: string,
  client: BarsClient,
  credentials: { login: string; password: string },
  consents: LegalDocId[],
): { awaitOutcome: () => Promise<LoginOutcome> } {
  let resolveCode: (code: string) => void = () => {};
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });

  let markTwoFactor: () => void = () => {};
  const twoFactorFlag = new Promise<void>((resolve) => {
    markTwoFactor = resolve;
  });

  const entry: PendingLogin = {
    challengeId,
    login: credentials.login,
    password: credentials.password,
    barsLoginHash: computeBarsLoginHash(credentials.login),
    consents,
    owner: clientKey(request),
    createdAt: Date.now(),
    needs2fa: false,
    settled: false,
    resolveCode,
    loginPromise: null as unknown as Promise<BarsLoginResult>,
  };

  entry.loginPromise = client.login({
    username: credentials.login,
    password: credentials.password,
    // Сессия пишется во временный файл на каждую попытку: BarsAuth пишет его
    // с флагом 'wx', и общий отладочный файл на все попытки конфликтовал бы.
    saveSessionPath: sessionFile(challengeId),
    on2FACodeNeeded: async () => {
      entry.needs2fa = true;
      markTwoFactor();
      return codePromise;
    },
  });

  pendingLogins.set(challengeId, entry);

  const done: Promise<LoginOutcome> = entry.loginPromise.then(
    (result) => {
      entry.settled = true;
      return { kind: 'done', result } as LoginOutcome;
    },
    (error: unknown) => {
      entry.settled = true;
      return { kind: 'error', error } as LoginOutcome;
    },
  );

  // Пока жив только флаг «нужен код», промис входа не трогаем: он продолжает
  // ждать подтверждения и станет результатом второго запроса.
  const twoFactor: Promise<LoginOutcome> = twoFactorFlag.then(
    () => ({ kind: 'two_factor' }) as LoginOutcome,
  );

  return { awaitOutcome: () => awaitOutcomeWithDeadline(done, twoFactor, entry.createdAt) };
}

/**
 * Ожидание исхода попытки с предельным временем.
 *
 * Гонка трёх исходов: БАРС ответил, БАРС попросил код, или прошло LOGIN_ATTEMPT_
 * TIMEOUT_MS. Таймер намеренно НЕ трогает сам промис входа: тот продолжает
 * висеть, и его результатом воспользуется второй запрос с кодом — если человек
 * всё-таки получит СМС. Сбрасывается он только на «положенное время истекло».
 */
function awaitOutcomeWithDeadline(
  done: Promise<LoginOutcome>,
  twoFactor: Promise<LoginOutcome>,
  startedAt: number,
): Promise<LoginOutcome> {
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, LOGIN_ATTEMPT_TIMEOUT_MS - elapsed);

  if (remaining === 0) return Promise.resolve(logTimeout());

  return new Promise<LoginOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: LoginOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => finish(logTimeout()), remaining);
    // unref: таймер ожидания не должен удерживать процесс от завершения.
    timer.unref?.();

    // Таймер снимаем, когда исход уже известен: иначе через 45 секунд в журнал
    // попадало «БАРС не ответил», хотя вход давно попросил код или завершился.
    void done.then(finish);
    void twoFactor.then(finish);
  });
}

function logTimeout(): LoginOutcome {
  console.warn(`[Auth] попытка входа не уложилась в ${LOGIN_ATTEMPT_TIMEOUT_MS}мс — БАРС не ответил`);
  return { kind: 'error', error: new Error('БАРС МЭИ не ответил вовремя.') };
}

/**
 * Полный вход: проверка пароля, разбор профиля, привязка группы, сохранение.
 *
 * Запись заводится, если её ещё нет, и это не отдельное решение человека:
 * человек пришёл с логином и паролем БАРС, и БАРС их только что проверил.
 * Спрашивать «вы здесь впервые?» значило бы спрашивать о вещи, которую сервер
 * и так знает наверняка.
 */
async function performLogin(
  request: FastifyRequest,
  credentials: { login: string; password: string },
  consents: LegalDocId[],
): Promise<{ user: StoredUser } | { need2fa: true; challengeId: string }> {
  assertLoginConsents(consents);

  const { login, password } = credentials;
  const barsLoginHash = computeBarsLoginHash(login);
  const owner = clientKey(request);
  const startedAt = Date.now();

  sweepPending();

  const limiter = checkLoginAllowed(owner, login);
  if (limiter.blocked) {
    throw new AuthError(
      `Слишком много попыток. Повторите через ${formatRetryAfter(limiter.retryAfterMs)}.`,
      429,
      'too_many_attempts',
      limiter.retryAfterMs,
    );
  }

  const existing = userStore.getByBarsLoginHash(barsLoginHash);

  const challengeId = crypto.randomUUID();
  const client = new BarsClient();

  console.log(
    `[Auth] вход начат: ${existing ? 'существующий' : 'новый'} аккаунт`,
  );

  const outcome = await startLoginAttempt(request, challengeId, client, credentials, consents).awaitOutcome();

  console.log(`[Auth] исход входа: ${outcome.kind} за ${Date.now() - startedAt}мс`);

  if (outcome.kind !== 'two_factor') {
    const pending = pendingLogins.get(challengeId);
    pendingLogins.delete(challengeId);
    if (pending) {
      // При таймауте сетевой промис мог пережить HTTP-запрос. Разрешаем
      // возможное ожидание 2FA и удаляем его temp-сессию после завершения.
      if (outcome.kind === 'error') pending.resolveCode('');
      void pending.loginPromise.then(
        () => cleanupSessionFile(challengeId),
        () => cleanupSessionFile(challengeId),
      );
    }
  }

  if (outcome.kind === 'two_factor') {
    return { need2fa: true, challengeId };
  }

  if (outcome.kind === 'error') {
    registerLoginFailure(owner, login);
    await cleanupSessionFile(challengeId);
    throw new AuthError(
      `Не удалось войти: ${safeErrorMessage(outcome.error)}`,
      401,
      'invalid_credentials',
    );
  }

  if (!outcome.result.success) {
    registerLoginFailure(owner, login);
    await cleanupSessionFile(challengeId);
    throw new AuthError('Неверный логин или пароль.', 401, 'invalid_credentials');
  }

  registerLoginSuccess(owner, login);

  const user = await completeRegistration({
    existing: existing ?? null,
    barsLoginHash,
    login,
    password,
    studentInfo: outcome.result.studentInfo,
    sessionData: outcome.result.sessionData,
    platform: detectPlatform(request.headers),
  });

  await cleanupSessionFile(challengeId);

  const withConsents = acceptConsents(user, consents, { ip: owner, method: 'pwa' });

  return { user: withConsents };
}

/**
 * Завершает вход кодом подтверждения.
 *
 * Код отдаётся уже начатому входу, поэтому второй поход в БАРС не нужен и
 * сессия получается ровно той же, что была начата первым запросом.
 */
async function finishTwoFactorLogin(
  challengeId: string,
  code: string,
  platform: UserPlatform,
  owner: string,
): Promise<StoredUser> {
  sweepPending();

  const entry = pendingLogins.get(challengeId);

  if (!entry) {
    throw new AuthError('Попытка входа истекла. Начните заново.', 401, 'invalid_credentials');
  }

  /*
   * Попытка принадлежит тому же клиенту, который начинал вход. Без этой
   * проверки challengeId, утёкший в общий NAT/браузер, позволял бы завершить
   * чужой вход. Чужой запрос не удаляет попытку: иначе им можно было бы
   * намеренно сорвать вход владельцу.
   */
  if (entry.owner !== owner) {
    throw new AuthError('Попытка входа истекла. Начните заново.', 401, 'invalid_credentials');
  }

  // Запись удаляется сразу: код одноразовый, и повторная отправка не должна
  // продлевать ту же попытку.
  pendingLogins.delete(challengeId);

  entry.resolveCode(code);

  let result: BarsLoginResult;
  try {
    result = await entry.loginPromise;
  } catch (err: unknown) {
    const reason = safeErrorMessage(err);
    console.warn(`[Auth] 2FA не подтверждён: ${reason}`);
    // Не называем любую ошибку «код не подошёл»: сетевой сбой или отказ БАРС
    // человеку нужно видеть как есть, иначе он вводит заведомо верный код снова.
    const wrongCode = /неверный код/i.test(reason);
    if (wrongCode) registerLoginFailure(entry.owner, entry.login);
    throw new AuthError(
      wrongCode ? 'Код не подошёл. Попробуйте ещё раз.' : reason,
      401,
      wrongCode ? 'invalid_credentials' : 'login_failed',
    );
  } finally {
    await cleanupSessionFile(challengeId);
  }

  if (!result.success) {
    registerLoginFailure(entry.owner, entry.login);
    throw new AuthError('Код не подошёл.', 401, 'invalid_credentials');
  }

  // Счётчики сбрасываются по ключу того же клиента, что и начинал вход:
  // сброс по хэшу логина обнулял бы чужую ветку ограничителя.
  registerLoginSuccess(entry.owner, entry.login);

  const user = await completeRegistration({
    existing: userStore.getByBarsLoginHash(entry.barsLoginHash) ?? null,
    barsLoginHash: entry.barsLoginHash,
    login: entry.login,
    password: entry.password,
    studentInfo: result.studentInfo,
    sessionData: result.sessionData,
    platform,
  });

  return acceptConsents(user, entry.consents, { ip: entry.owner, method: 'pwa' });
}

/** Удаляет временный файл сессии попытки. */
async function cleanupSessionFile(challengeId: string): Promise<void> {
  try {
    await fs.rm(sessionFile(challengeId), { force: true });
  } catch {
    // файла уже нет — ничего страшного
  }
}

/**
 * Сохраняет результат успешного входа: креды, профиль, группу.
 *
 * Запись либо обновляется (повторный вход), либо создаётся (первый).
 * userId при повторном входе НЕ меняется: он и есть личность человека, и
 * смена сделала бы его собственные ДЗ чужими для него самого.
 */
async function completeRegistration(input: {
  existing: StoredUser | null;
  barsLoginHash: string;
  login: string;
  password: string;
  studentInfo: import('../../../services/bars/barsClient.ts').StudentInfo;
  sessionData: import('../../../services/bars/barsClient.ts').SavedSessionData;
  /** Платформа клиента: сохраняется в профиле вместе с остальным входом. */
  platform: UserPlatform;
}): Promise<StoredUser> {
  const { existing, barsLoginHash, login, password, studentInfo, sessionData, platform } = input;
  const startedAt = Date.now();

  // Единственная точка создания записи. Если регистрация закрыта, а записи ещё
  // нет — вход не завершаем. Существующие пользователи проходят дальше.
  if (!existing && !registrationStore.isOpen()) {
    throw new AuthError(
      'Регистрация новых аккаунтов временно закрыта. Вход доступен только тем, кто уже пользуется Mood.',
      403,
      'registration_closed',
    );
  }

  const fullName = studentInfo.studentName?.trim() || 'Студент';
  const barsGroupName = studentInfo.groupName?.trim() || '';
  const profileOk = looksLikeStudentProfile(studentInfo);

  // Новый аккаунт без студенческого профиля не заводим: БАРС пускает и
  // служебные/нестуденческие логины, из которых раньше появлялись записи
  // «Главная» с группой-заглушкой. Существующего человека при этом не трогаем:
  // разовый сбой разбора страницы не должен выкидывать его из аккаунта.
  if (!existing && !profileOk) {
    // Без пароля и токенов: только то, что увидели на странице БАРС. По этому
    // логу видно, это «Главная» вместо ФИО, пустая группа или реально
    // нестуденческий аккаунт.
    console.warn(
      '[Auth] профиль не распознан:',
      JSON.stringify({
        name: studentInfo.studentName,
        group: studentInfo.groupName,
        studyCard: studentInfo.studyCard ?? null,
        email: studentInfo.email ?? null,
      }),
    );

    throw new AuthError(
      'Этот аккаунт БАРС не похож на студенческий: не удалось определить ФИО и группу. Войдите студенческим логином.',
      403,
      'not_a_student',
    );
  }

  // Группа нужна для расписания: без неё показывать нечего.
  let groupId: number | undefined;
  let groupName: string | undefined;
  let faculty: string | undefined;

  if (barsGroupName) {
    try {
      const res = await searchGroupOnMpei(barsGroupName);
      if (res.success && res.group) {
        groupId = res.group.id;
        groupName = res.group.label;
        faculty = res.group.description;
      }
    } catch (err: unknown) {
      // Группа не нашлась — вход всё равно состоялся, расписание просто не
      // подтянется. Пользователь увидит это в интерфейсе, а не вместо входа.
      console.warn('[Auth] группа не найдена на ts.mpei.ru:', safeErrorMessage(err));
    }
  }

  // Отдельно от записи в базу: это единственный поход во ВНЕШНИЙ сервис внутри
  // сохранения, и именно он объясняет «вход шёл минуту, а пароль был верный».
  console.log(`[Auth] сохранение входа: БАРС и ts.mpei.ru за ${Date.now() - startedAt}мс`);

  const encLogin = encrypt(login);
  const encPass = encrypt(password);

  const patch: Partial<StoredUser> = {
    firstName: profileOk ? fullName.split(' ')[0] || undefined : existing?.firstName,
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
    // Плохой разбор страницы не должен затирать нормальный профиль: сохраняем
    // прежние ФИО/группу, но креды и сессию обновляем — вход-то состоялся.
    ...(profileOk
      ? {
          studentProfile: {
            fullName,
            recordBookNumber: studentInfo.studyCard,
            groupName: barsGroupName || undefined,
          },
          groupName: groupName ?? existing?.groupName,
          groupId: groupId ?? existing?.groupId,
          faculty: faculty ?? existing?.faculty,
        }
      : {}),
    authState: null,
    tempAuthData: undefined,
    barsAuthedAt: new Date().toISOString(),
    platform,
  };

  const user = existing
    ? userStore.patch(existing.userId, patch) ?? existing
    : userStore.patch(userStore.create({ barsLoginHash, firstName: fullName.split(' ')[0] }).userId, patch)!;

  // Сессия в cookies сменилась: клиент в памяти больше не годится, а кэш
  // «сессия действительна» посчитан для прошлого входа — сбрасываем оба.
  forgetBarsClient(user.userId);
  forgetBarsSessionValid(user.userId);

  return user;
}

export function registerLoginRoutes(app: FastifyInstance): void {
  /**
   * POST /api/auth/login — вход по логину и паролю БАРС.
   *
   * Запись заводится автоматически, если её ещё нет: отдельного «регистрационного»
   * шага нет ни у человека, ни в API.
   *
   * Войти можно и в аккаунт, который уже использует Telegram: оба клиента
   * работают с одной записью пользователя. Неверный пароль и «логина нет»
   * по-прежнему неразличимы — иначе перебором логинов можно было бы выяснить,
   * кто уже пользуется приложением, не имея паролей.
   */
  app.post('/api/auth/login', async (request, reply) => {
    const result = await performLogin(request, readCredentials(request), readConsents(request));

    if ('need2fa' in result) {
      return reply.code(401).send({
        error: 'need_2fa',
        message: 'Требуется код подтверждения.',
        challengeId: result.challengeId,
      });
    }

    return reply.send(issueToken(result.user));
  });

  /**
   * POST /api/auth/register — алиас на /api/auth/login.
   *
   * Оставлен только для обратной совместимости: клиент его больше не зовёт
   * (см. pwa/src/auth.ts), и разницы в поведении между ним и login больше нет.
   * Удалять опасно — на него мог ссылаться развёрнутый билд, который у
   * человека ещё лежит в кэше Service Worker.
   */
  app.post('/api/auth/register', async (request, reply) => {
    const result = await performLogin(request, readCredentials(request), readConsents(request));

    if ('need2fa' in result) {
      return reply.code(401).send({
        error: 'need_2fa',
        message: 'Требуется код подтверждения.',
        challengeId: result.challengeId,
      });
    }

    return reply.send(issueToken(result.user));
  });

  /**
   * POST /api/auth/2fa — продолжение входа кодом из БАРС.
   *
   * Отдельный маршрут, потому что код приходит человеку в другой канал
   * (SMS или приложение БАРС), а запрос к БАРС уже висит и ждёт ответа.
   */
  app.post('/api/auth/2fa', async (request, reply) => {
    const body = (request.body ?? {}) as { challengeId?: unknown; code?: unknown };
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';

    if (!challengeId || !code) {
      return reply.code(400).send({ error: 'bad_request', message: 'Нужен код подтверждения.' });
    }

    return reply.send(
      issueToken(
        await finishTwoFactorLogin(
          challengeId,
          code,
          detectPlatform(request.headers),
          clientKey(request),
        ),
      ),
    );
  });
}
