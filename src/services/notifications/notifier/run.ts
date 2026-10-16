/**
 * Фоновый цикл мониторинга БАРС МЭИ и почты ОСЭП.
 *
 * Ключевые ограничения, заложенные в архитектуру:
 * - опрос строго последовательный, с паузой между студентами (anti-ban для МЭИ);
 * - ночью (по Москве) воркер спит;
 * - любая ошибка сети глушится и переносится на следующий круг, процесс бота не падает.
 *
 * Сервис не знает про Telegram: получателю сообщений передаётся функция отправки,
 * которую регистрирует telegramService.
 */

import { isBarsAuthorized, type StoredUser, userStore } from '../../../storage/userStore.ts';
import { safeErrorMessage } from '../../../bot/format.ts';
import { snapshotStore, type UserSnapshot } from '../../../storage/snapshotStore.ts';
import { toMoscow } from '../../../utils/time.ts';
import { forgetBarsClient } from '../../bars/barsServiceFactory.ts';
import { MAIL_PREVIEW_LIMIT } from '../../bars/barsSnapshotCache.ts';
import { clearMailPreview, putMailPreview } from '../../mail/mailPreviewCache.ts';
import { forget, markActive, markChecked } from '../pollSchedule.ts';
import { collectState } from './collect.ts';
import {
  buildGradesHash,
  buildScholarshipStatus,
  diffSnapshots,
  isTransientNetworkError,
  renderNotification,
  type NotificationEvent,
} from './diff.ts';

/** Период запуска цикла опроса. */
const POLL_INTERVAL_MS = 20 * 60 * 1000;

/** Активное окно работы по Москве: 08:00–23:00. */
const ACTIVE_FROM_HOUR = 8;
const ACTIVE_TO_HOUR = 23;

/** Пауза между студентами: не меньше 2.5 с, чтобы не поймать бан по IP. */
const USER_DELAY_MS = 2500;

/** Пауза между студентами варьируется, чтобы трафик не выглядел роботизированным. */
const USER_DELAY_JITTER_MS = 500;

/**
 * Сколько подряд идущих сетевых сбоев терпим, прежде чем прервать весь круг.
 * Нужно, чтобы при лежащем bars.mpei.ru не высасывать по очереди всех студентов.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Таймаут одного пользователя, чтобы зависший запрос не держал весь цикл. */
const PER_USER_TIMEOUT_MS = 60 * 1000;

/**
 * Функция отправки сообщения конкретному пользователю.
 * Регистрируется telegramService, чтобы сервис не зависел от grammY.
 */
export type NotificationSender = (chatId: number, text: string) => Promise<void>;

let sender: NotificationSender | null = null;
let timer: NodeJS.Timeout | null = null;
let isCycleRunning = false;

/**
 * Регистрирует канал доставки уведомлений.
 */
export function setNotificationSender(fn: NotificationSender | null): void {
  sender = fn;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Текущий час по Москве (0–23). */
function getMoscowHour(): number {
  const { time } = toMoscow();
  return Number.parseInt(time.split(':')[0], 10) || 0;
}

/** Находится ли сервер МЭИ внутри активного окна 08:00–23:00 МСК. */
export function isWithinActiveWindow(now: Date = new Date()): boolean {
  const hour = getMoscowHour();
  return hour >= ACTIVE_FROM_HOUR && hour < ACTIVE_TO_HOUR;
}

/**
 * Обновляет снимок по одному пользователю и возвращает отправленные события.
 */
export async function checkUser(
  user: StoredUser,
  now: Date = new Date()
): Promise<NotificationEvent[]> {
  const prev = snapshotStore.get(user.userId);
  const { state, fetched } = await collectState(user, now);
  markChecked(user.userId, fetched, now);

  // Превью почты для интерфейса собираем ЗДЕСЬ ЖЕ. Это единственный путь, которым
  // почта попадает в приложение: пользователь её вручную не обновляет, а
  // приложение читает готовое (peekMailPreview). Если на этом круге почту не
  // смогли получить (state.mails === null), прежнее превью не трогаем — пусть
  // останется последнее известное.
  if (state.mails !== null) {
    const unread = state.mails.filter((m) => !m.isSeen);
    const messages = unread
      .slice()
      .sort((a, b) => b.date.getTime() - a.date.getTime() || b.uid - a.uid)
      .slice(0, MAIL_PREVIEW_LIMIT)
      .map((m) => ({
        uid: m.uid,
        from: m.from,
        subject: m.subject,
        date: m.date.toISOString(),
        isSeen: m.isSeen,
        hasAttachments: m.hasAttachments,
      }));

    putMailPreview(user.userId, {
      total: state.mails.length,
      unseen: unread.length,
      messages,
    });
  }

  // Источники, которые на этом круге не опрашивались, сохраняют прошлые значения.
  // Если этого не сделать, пропущенный круг обнулит приказы и стипендию,
  // а на следующем круге пришёл бы ложный дифф с «новыми приказами».
  const next: UserSnapshot = {
    gradesHash:
      state.grades !== null ? buildGradesHash(state.grades) : (prev?.gradesHash ?? {}),
    lastSeenMailUid:
      state.mails !== null
        ? Math.max(
            prev?.lastSeenMailUid ?? 0,
            state.mails.reduce((max, m) => Math.max(max, m.uid), 0),
          )
        : (prev?.lastSeenMailUid ?? 0),
    ordersCount: state.orders !== null ? state.orders.length : (prev?.ordersCount ?? 0),
    scholarshipStatus:
      state.scholarship !== null
        ? buildScholarshipStatus(state.scholarship)
        : (prev?.scholarshipStatus ?? 'нет'),
    lastCheckedAt: now.toISOString(),
  };

  // Уведомления строим только по фактически полученным данным: дифф со снимком,
  // где часть полей восстановлена из prev, событий не даёт.
  const events = diffSnapshots(prev, next, {
    grades: state.grades ?? undefined,
    mails: state.mails ?? undefined,
    orders: state.orders ?? undefined,
  });

  // Снимок обновляем всегда: даже если отправка не удалась, повторно не нотифицируем.
  // Запись идёт в память: на диск всё сбрасывается одним save() в конце круга.
  snapshotStore.stage(user.userId, next);

  /*
   * Отправляем только тем, кто подключил уведомления и не выключил их.
   *
   * Два условия, и оба обязательны. `typeof === 'number'` вместо проверки на
   * undefined: telegramId бывает null у отвязанного аккаунта, и такой null
   * прошёл бы проверку «поле есть», а отправка ушла бы в null вместо отказа.
   *
   * Снимок при этом обновляется ВЫШЕ, как и раньше. Иначе при включении
   * уведомлений человек получил бы пачку накопившихся событий за все дни, пока
   * они были выключены, — от баллов, за которые он давно сдал работу.
   */
  const canNotify = typeof user.telegramId === 'number' && user.notificationsEnabled !== false;

  if (events.length > 0 && sender && canNotify && typeof user.telegramId === 'number') {
    try {
      await sender(user.telegramId, renderNotification(events));
    } catch (err: unknown) {
      console.error('[Notifier] Не удалось отправить уведомление:', safeErrorMessage(err));
    }
  }

  return events;
}

/**
 * Один полный круг опроса: последовательно, с паузой, с отказоустойчивостью.
 */
export async function runCycle(): Promise<void> {
  if (isCycleRunning) {
    console.warn('[Notifier] Предыдущий цикл ещё идёт, пропускаю запуск.');
    return;
  }

  if (!isWithinActiveWindow()) {
    console.log('[Notifier] Вне активного окна (08:00–23:00 МСК), пропускаю цикл.');
    return;
  }

  isCycleRunning = true;
  let processed = 0;
  let notified = 0;
  let consecutiveFailures = 0;

  try {
    // Только те, кому есть смысл ходить: у PWA-пользователя может не быть
    // Telegram, но почту и уведомления в приложении он видит — его аккаунт тоже
    // обновляем. Отправка всё равно отфильтруется по telegramId ниже.
    const users = userStore
      .all()
      .filter(isBarsAuthorized)
      .filter((u) => u.telegramId !== undefined || (u.pwaTokens?.length ?? 0) > 0);

    console.log(`[Notifier] Цикл опроса: ${users.length} авторизованных пользователей.`);

    for (const user of users) {
      // Цикл мог начаться в 22:59 и затянуться за полночь — дальше не идём.
      if (!isWithinActiveWindow()) {
        console.log('[Notifier] Активное окно закрылось, остаток круга пропущен.');
        break;
      }
      // Успех сбрасывает счётчик сетевых сбоев
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[Notifier] ${consecutiveFailures} сетевых сбоев подряд — прерываю круг до следующего раунда.`,
        );
        break;
      }

      try {
        const withTimeout = Promise.race([
          checkUser(user),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Превышен таймаут проверки пользователя')), PER_USER_TIMEOUT_MS),
          ),
        ]);

        const events = await withTimeout;
        consecutiveFailures = 0;
        processed += 1;

        if (events.length > 0) {
          notified += 1;
          console.log(`[Notifier] События: ${events.map((e) => e.kind).join(', ')}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Notifier] Ошибка проверки:', safeErrorMessage(err));

        if (isTransientNetworkError(err)) {
          consecutiveFailures += 1;
        }

        // Сессия БАРС истекла: чистим, чтобы пользователя больше не мучили ошибками
        if (/сессия/i.test(msg) || /SessionExpiredError/.test(msg)) {
          userStore.clearAuth(user.userId);
          snapshotStore.remove(user.userId);
          clearMailPreview(user.userId);
          forget(user.userId);
          if (typeof user.telegramId === 'number') {
            forgetBarsClient(user.telegramId);
          }
        }
      }

      // Пауза между студентами — обязательна, иначе МЭИ забанит по IP.
      await sleep(USER_DELAY_MS + Math.floor(Math.random() * USER_DELAY_JITTER_MS));
    }

    console.log(
      `[Notifier] Цикл завершён: проверено ${processed}, уведомлений ${notified}.`,
    );
  } catch (err: unknown) {
    // Страховка: фоновая задача не должна ронять процесс бота.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Notifier] Цикл прерван, переносим на следующий круг: ${msg}`);
  } finally {
    // Единственная запись bars_snapshots.json за круг, независимо от числа
    // пользователей и от того, чем закончился круг. Несохранённые снимки при
    // падении процесса привели бы к повторным уведомлениям на следующем круге.
    snapshotStore.flush();
    isCycleRunning = false;
  }
}

/**
 * Сбрасывает накопленные снимки при остановке процесса.
 * Вызывается из telegramService по SIGTERM/SIGINT, чтобы systemd-рестарт
 * не приводил к повторной рассылке уже отправленных уведомлений.
 */
export function flushSnapshots(): void {
  snapshotStore.flush();
}

/**
 * Запускает фоновый цикл. Безопасно вызывать несколько раз — таймер не дублируется.
 */
export function startNotifier(): void {
  if (timer) return;

  console.log(
    `[Notifier] Фоновый мониторинг запущен: каждые ${POLL_INTERVAL_MS / 60000} мин, окно 08:00–23:00 МСК.`,
  );

  timer = setInterval(() => {
    void runCycle();
  }, POLL_INTERVAL_MS);

  // Первый прогон — с небольшой задержкой, чтобы бот успел поднять polling.
  setTimeout(() => {
    void runCycle();
  }, 30_000);

  // Таймер не должен удерживать процесс.
  timer.unref?.();
}

/**
 * Останавливает фоновый цикл (например, в тестах или при остановке бота).
 */
export function stopNotifier(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log('[Notifier] Фоновый мониторинг остановлен.');
}

/**
 * Немедленный прогон одного пользователя — удобно для ручной проверки и тестов.
 * Принудительно опрашивает все источники, игнорируя график частот.
 */
export async function checkUserNow(telegramId: number): Promise<NotificationEvent[]>;
export async function checkUserNow(userId: string): Promise<NotificationEvent[]>;
export async function checkUserNow(key: number | string): Promise<NotificationEvent[]> {
  const user = typeof key === 'number' ? userStore.get(key) : userStore.getByUserId(key);
  if (!isBarsAuthorized(user)) {
    throw new Error('Пользователь не авторизован в БАРС МЭИ.');
  }
  forget(user.userId);
  return checkUser(user);
}

export { markActive };
