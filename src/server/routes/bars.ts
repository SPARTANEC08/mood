/**
 * /api/bars/* — данные личного кабинета БАРС МЭИ.
 *
 * Эндпоинты намеренно разделены, а не объединены в один: приложение открывает
 * нужный раздел по табу, и грузить все данные БАРС сразу — это лишние
 * обращения к сайту МЭИ, который лучше не дёргать часто.
 *
 * При этом ходит в БАРС теперь не эндпоинт, а barsSnapshotCache: все три
 * раздела читают один и тот же снимок, собранный не чаще раза в 20 минут.
 * Разделение маршрутов осталось, но теперь оно разделяет форму ответа, а не
 * походы в МЭИ — раньше переход на вкладку «Успеваемость» и вкладку
 * «Кабинет» стоили двух полных обходов сайта.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { createBarsServiceForUser } from '../../services/bars/barsServiceFactory.ts';
import { safeErrorMessage } from '../../bot/format.ts';
import {
  getBarsSnapshot,
  invalidateBarsSnapshot,
  type BarsSnapshotOptions,
} from '../../services/bars/barsSnapshotCache.ts';
import { SessionExpiredError } from '../../services/bars/barsClient.js';
import { type StoredUser, userStore } from '../../storage/userStore.ts';
import { requireBars } from '../middleware/auth.ts';
import type { BarsSnapshotResponse } from '../types.ts';

/**
 * Единый обработчик отказа БАРС.
 *
 * Истёкшая сессия — это не 500, а понятный клиенту сигнал: показать экран
 * входа и предложить обновить сессию. Поэтому здесь 401 + needBarsLogin.
 */
function sendBarsError(
  student: StoredUser,
  reply: FastifyReply,
  err: unknown,
): unknown {
  if (err instanceof SessionExpiredError) {
    // Сессию чистим на сервере, чтобы следующий запрос не падал снова.
    // Ключ — userId: тот же человек может прийти и из бота, и из PWA,
    // и запись у него одна.
    userStore.clearAuth(student.userId);
    // Снимок выбран этой (уже мёртвой) сессией — оставлять его нельзя,
    // иначе после повторного входа приложение продолжит показывать
    // то, что было до сброса.
    invalidateBarsSnapshot(student.userId);
    return reply.code(401).send({
      error: 'session_expired',
      message: 'Сессия БАРС истекла. Войдите логином и паролем заново.',
      needBarsLogin: true,
    });
  }

  console.error('[API bars]', safeErrorMessage(err));
  return reply.code(502).send({
    error: 'bars_unavailable',
    message: 'Личный кабинет БАРС временно недоступен.',
    needBarsLogin: false,
  });
}

/**
 * Снимок БАРС для пользователя.
 *
 * Почту этот путь НЕ трогает: её обновляет только фоновый нотификатор, а
 * приложение читает готовое превью (peekMailPreview). Поэтому в снимок почта не
 * собирается даже при force-обновлении — иначе кнопка «Обновить» в приложении
 * косвенно дёргала бы IMAP.
 */
export async function loadBarsSnapshot(
  student: StoredUser,
  opts: BarsSnapshotOptions = {},
): Promise<BarsSnapshotResponse> {
  const service = await createBarsServiceForUser(student);
  return getBarsSnapshot(student.userId, service, null, opts);
}

export async function registerBarsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/bars/grades', async (request, reply) => {
    const student = requireBars(request);

    try {
      const snapshot = await loadBarsSnapshot(student);
      return reply.send(snapshot.grades);
    } catch (err: unknown) {
      return sendBarsError(student, reply, err);
    }
  });

  app.get('/api/bars/attendance', async (request, reply) => {
    const student = requireBars(request);

    try {
      const snapshot = await loadBarsSnapshot(student);
      return reply.send(snapshot.attendance);
    } catch (err: unknown) {
      return sendBarsError(student, reply, err);
    }
  });

  app.get('/api/bars/more', async (request, reply) => {
    const student = requireBars(request);

    try {
      const snapshot = await loadBarsSnapshot(student);
      return reply.send(snapshot.more);
    } catch (err: unknown) {
      return sendBarsError(student, reply, err);
    }
  });

  /**
   * Принудительное обновление — кнопка «Обновить» на вкладках «Успеваемость»
   * и «Кабинет».
   *
   * Единственный маршрут, который сознательно идёт в МЭИ мимо TTL. Возвращает
   * весь снимок: он всё равно собирается целиком, а клиенту после кнопки
   * «Обновить» нужны и оценки, и пропуски, и рейтинг, и стипендия сразу.
   */
  app.post('/api/bars/refresh', async (request, reply) => {
    const student = requireBars(request);

    try {
      const snapshot = await loadBarsSnapshot(student, { force: true });
      return reply.send(snapshot);
    } catch (err: unknown) {
      return sendBarsError(student, reply, err);
    }
  });
}
