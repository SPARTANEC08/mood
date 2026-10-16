/**
 * Профиль и агрегированный ответ для первого экрана приложения.
 *
 * /api/auth/me и /api/auth/config — дешёвые ответы о самом человеке и сроке
 * токена. /api/bootstrap — один запрос вместо пяти: профиль, статус сессии
 * БАРС, текущая дата и неделя, диапазон расписания и число непрочитанных.
 */

import type { FastifyInstance } from 'fastify';

import { isBarsSessionValid } from '../../../services/bars/barsServiceFactory.ts';
import { getGroupSchedule } from '../../../bot/scheduleCache.ts';
import { peekMailPreview } from '../../../services/mail/mailPreviewCache.ts';
import { PWA_TOKEN_TTL_MS } from '../../../utils/pwaAuth.ts';
import { toMoscow } from '../../../utils/time.ts';
import { isBarsAuthorized } from '../../../storage/userStore.ts';
import { requireUser } from '../../middleware/auth.ts';
import type { BootstrapResponse } from '../../types.ts';
import { buildProfile } from './helpers.ts';

/**
 * Номер учебной недели.
 *
 * Заданного учебного календаря у нас нет, поэтому неделя считается от
 * первого понедельника года: ISO-недели и учебные почти совпадают в первой
 * половине года и расходятся лишь в последнюю неделю декабря.
 */
function currentWeekNumber(now: Date = new Date()): number {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

/** Ограничение по времени: внешний сервис не должен блокировать ответ API. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    // unref: висящий таймаут не должен удерживать event loop, если всё
    // остальное уже завершилось (например, ответ пришёл раньше срока).
    timer.unref?.();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

/**
 * Регистрирует /api/auth/me, /api/auth/config и /api/bootstrap.
 *
 * /api/bootstrap — агрегированные данные для первого экрана приложения.
 * Один запрос вместо пяти: профиль, статус сессии, текущая дата и неделя.
 */
export function registerBootstrapRoutes(app: FastifyInstance): void {
  /** GET /api/auth/me — текущий пользователь. */
  app.get('/api/auth/me', async (request, reply) => {
    return reply.send(buildProfile(requireUser(request)));
  });

  /** Срок жизни токена: клиенту нужно знать, зачем обновлять сессию. */
  app.get('/api/auth/config', async () => ({ tokenTtlMs: PWA_TOKEN_TTL_MS }));

  app.get('/api/bootstrap', async (request, reply) => {
    const student = requireUser(request);

    const profile = buildProfile(student);
    const barsAuthorized = isBarsAuthorized(student);

    let sessionValid: boolean | null = null;
    let scheduleRange: BootstrapResponse['scheduleRange'] = null;
    let mailUnread: number | null = null;

    if (barsAuthorized) {
      // Всё необязательное уходит ПАРАЛЛЕЛЬНО: ответ упирается в самый
      // медленный источник, а не в их сумму. Таймауты маленькие, потому что
      // bootstrap открывает приложение, и держать его на скелете вредно.
      const [valid, range] = await Promise.all([
        withTimeout(isBarsSessionValid(student), 2500, null),
        typeof student.groupId === 'number' && student.groupId > 0
          ? withTimeout(
              getGroupSchedule(student.groupId, student.groupName ?? '', student.faculty).then(
                (s) => s.dateRange,
              ),
              2500,
              null,
            )
          : Promise.resolve(null),
      ]);

      sessionValid = valid;
      scheduleRange = range;
      // Значок непрочитанных берётся из превью почты, которое заполняет
      // фоновый нотификатор, и НЕ подгружается: bootstrap открывает приложение,
      // а поход в IMAP — отдельная авторизация на сервере МЭИ. Пока превью нет,
      // значок просто не показывается.
      mailUnread = peekMailPreview(student.userId)?.unseen ?? null;
    }

    const response: BootstrapResponse = {
      profile,
      barsAuthorized,
      sessionValid,
      today: toMoscow().rawDate,
      weekNumber: currentWeekNumber(),
      scheduleRange,
      mailUnread,
    };

    return reply.send(response);
  });
}
