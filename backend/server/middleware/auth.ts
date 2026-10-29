/**
 * Авторизация запросов PWA.
 *
 * Единственный способ подтвердить личность здесь — токен, выданный при входе
 * по логину и паролю БАРС. Подписи Telegram (initData) больше не проверяются
 * нигде: Mini App удалён, а приложение открывается как обычный сайт и как PWA
 * с иконки, где initData не существует вовсе.
 *
 * Что стоит за проверкой.
 *
 * Токен — это base64url(userId).base64url(exp).base64url(hmac). Подпись
 * считается PWA_AUTH_SECRET, поэтому подделать содержимое нельзя, а сменить
 * userId на чужой — тем более. Дополнительно хэш токена должен лежать в
 * pwaTokens пользователя: без этого проверки подписи было бы достаточно,
 * чтобы выпустить токен с произвольным userId и сроком на 90 дней.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { type StoredUser, userStore } from '../../../db/storage/userStore.ts';
import { missingConsents } from '../../legal/registry.ts';
import { detectPlatform } from '../../utils/platform.ts';
import { hashToken, verifyPwaToken } from '../../utils/pwaAuth.ts';

/**
 * Ошибка запроса, у которой известен и код ответа, и машинное имя ошибки.
 *
 * Отдельный класс нужен, чтобы обработчик ошибок мог отдать осмысленный код,
 * а обработчики — не ловить всё подряд.
 *
 * Машинное имя обязано быть отдельным полем, а не выводиться из HTTP-кода:
 * клиент различает «неверный пароль» (401 invalid_credentials) и «слишком
 * много попыток» (429), и по одному только коду он показал бы в обоих случаях
 * один и тот же экран входа. Поле retryAfterMs отдаётся клиенту, чтобы он
 * показал паузу, а не «попробуйте ещё раз».
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: number = 401,
    readonly error: string = 'unauthorized',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Идентификатор пользователя из проверенного токена. */
    userId?: string;
    /** Запись пользователя, загруженная по userId. */
    student?: StoredUser;
  }
}

export type AuthedRequest = FastifyRequest & {
  userId?: string;
  student?: StoredUser;
};

/**
 * Достаёт PWA-токен из заголовка.
 *
 * Заголовок, а не query-параметр: токен — это пароль, и в query он попадает в
 * access-логи nginx, историю браузера и заголовок Referer. Префиксы Bearer и
 * Token отбрасываются, чтобы клиент мог слать токен как есть.
 */
function extractPwaToken(request: FastifyRequest): string {
  const raw = request.headers['x-pwa-token'];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.replace(/^(Bearer|Token)\s+/i, '');
}

/**
 * Fastify-хук: ставит userId и student на каждый /api/* запрос.
 *
 * Регистрируется как preHandler на префиксе /api, поэтому ни один обработчик
 * не может работать, не проверив токен: авторизация одна на все маршруты.
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const req = request as AuthedRequest;

  const token = extractPwaToken(request);

  if (!token) {
    await unauthorized(reply, 'Требуется вход в приложение.');
    return;
  }

  const verified = verifyPwaToken(token);

  if (!verified) {
    await unauthorized(reply, 'Сессия истекла или недействительна. Войдите заново.');
    return;
  }

  const user = userStore.getByUserId(verified.userId);

  if (!user) {
    await unauthorized(reply, 'Пользователь не найден. Войдите заново.');
    return;
  }

  // Хэш токена должен числиться в записи: подпись доказывает, что токен выпущен
  // сервером, а эта проверка — что он не отозван выходом и не истёк раньше срока
  // в самой подписи (например, если срок в подписи продлили вручную).
  if (!userStore.hasToken(verified.userId, hashToken(token))) {
    await unauthorized(reply, 'Сессия завершена на устройстве. Войдите заново.');
    return;
  }

  req.userId = user.userId;
  req.student = user;

  // Платформа обновляется только при реальном изменении: иначе users.json
  // переписывался бы на каждый запрос. Смена устройства или заголовка — редкое
  // событие, и запись здесь стоит ровно один раз на изменение.
  const platform = detectPlatform(request.headers);
  if (user.platform !== platform) {
    userStore.patch(user.userId, { platform });
    req.student = { ...user, platform };
  }

  // Отметка об использовании: один patch на каждый запрос писал бы весь
  // users.json, поэтому время обновляется не чаще раза в час.
  if (shouldTouch(user)) {
    userStore.touchToken(user.userId, hashToken(token));
  }
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const lastTouch = new Map<string, number>();

function shouldTouch(user: StoredUser): boolean {
  const now = Date.now();
  const last = lastTouch.get(user.userId) ?? 0;

  if (now - last < TOUCH_INTERVAL_MS) return false;

  lastTouch.set(user.userId, now);
  return true;
}

async function unauthorized(reply: FastifyReply, message: string): Promise<void> {
  await reply.code(401).send({ error: 'unauthorized', message, needBarsLogin: false });
}

/**
 * Возвращает запись студента, требуя авторизации.
 *
 * Отдельный помощник нужен для разделов БАРС, почты и расписания: без входа
 * в личный кабинет там нечего показывать.
 */
export function requireBars(request: FastifyRequest): StoredUser {
  const req = request as AuthedRequest;
  const user = req.student;

  if (!user || !req.userId) {
    throw new AuthError('Запрос не авторизован.', 401, 'unauthorized');
  }

  if (missingConsents(user).length > 0) {
    throw new AuthError(
      'Чтобы продолжить, примите обновлённые условия обработки данных.',
      403,
      'consent_required',
    );
  }

  if (!user.barsAuth || !user.studentProfile?.fullName) {
    throw new AuthError(
      'Требуется вход в личный кабинет БАРС МЭИ. Войдите логином и паролем.',
      401,
      'bars_login_required',
    );
  }

  return user;
}

/**
 * Доступ к расписанию: обычный студент с БАРС или гость с выбранной группой.
 *
 * Гость не имеет barsAuth, поэтому requireBars для него не подходит. Но и
 * пускать его дальше расписания нельзя: все остальные разделы продолжают
 * требовать полноценный вход.
 */
export function requireScheduleAccess(request: FastifyRequest): StoredUser {
  const user = requireUser(request);

  if (missingConsents(user).length > 0) {
    throw new AuthError(
      'Чтобы продолжить, примите обновлённые условия обработки данных.',
      403,
      'consent_required',
    );
  }

  if (user.isGuest) {
    if (typeof user.groupId !== 'number' || !user.groupName) {
      throw new AuthError(
        'У гостя не выбрана группа. Выберите группу в настройках.',
        403,
        'group_required',
      );
    }
    return user;
  }

  if (!user.barsAuth || !user.studentProfile?.fullName) {
    throw new AuthError(
      'Требуется вход в личный кабинет БАРС МЭИ. Войдите логином и паролем.',
      401,
      'bars_login_required',
    );
  }

  return user;
}

/**
 * Возвращает текущего пользователя, требуя только действующей сессии.
 */
export function requireUser(request: FastifyRequest): StoredUser {
  const req = request as AuthedRequest;
  const user = req.student;

  if (!user || !req.userId) {
    throw new AuthError('Запрос не авторизован.', 401, 'unauthorized');
  }

  return user;
}

/** Идентификатор текущего пользователя — для случаев, где нужна сама строка. */
export function requireUserId(request: FastifyRequest): string {
  const req = request as AuthedRequest;

  if (!req.userId) {
    throw new AuthError('Запрос не авторизован.', 401, 'unauthorized');
  }

  return req.userId;
}
