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

import { isBarsAuthorized, type StoredUser, userStore } from '../../../../db/storage/userStore.ts';
import { safeErrorMessage } from '../../../../tg/format.ts';
import { snapshotStore, type UserSnapshot } from '../../../../db/storage/snapshotStore.ts';
import { userEventStore } from '../../../../db/storage/userEventStore.ts';
import { toMoscow } from '../../../utils/time.ts';
import { forgetBarsClient, forgetBarsSessionValid } from '../../bars/barsServiceFactory.ts';
import { clearMailStatus, putMailStatus } from '../../mail/mailStatusCache.ts';
import { forgetOwaClient } from '../../mail/owaClientRegistry.ts';
import { forget, markActive, markChecked, notifierPollOverrideMs } from '../pollSchedule.ts';
import { sendPushToUser } from '../webPush.ts';
import { collectState } from './collect.ts';
import {
  buildGradesHash,
  buildScholarshipStatus,
  diffSnapshots,
  isTransientNetworkError,
  orderKey,
  renderNotification,
  type NotificationEvent,
} from './diff.ts';

/**
 * Период запуска цикла опроса. По умолчанию 20 минут; `NOTIFIER_POLL_MS`
 * переопределяет и цикл, и интервалы источников (см. pollSchedule), чтобы
 * отладку можно было вести без пересборки.
 */
const POLL_INTERVAL_MS = notifierPollOverrideMs() ?? 20 * 60 * 1000;

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

/** Сколько дней хранить in-app историю для тех, кто давно не заходил. */
const IN_APP_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Когда человек последний раз пользовался приложением.
 *
 * Отдельного поля «последняя активность» в записи нет, и заводить его ради
 * фильтра не нужно: отметки уже есть у PWA-токенов (`lastUsedAt` обновляется
 * раз в час при запросах) и у входа в БАРС.
 *
 * `updatedAt` здесь намеренно не используется: нотификатор сам патчит запись
 * при обновлении сессии OWA, и «активность» оказывалась бы свежей у человека,
 * который месяцами не открывал приложение.
 */
function lastAppActivityMs(user: StoredUser): number {
  const times: number[] = [];

  for (const token of user.pwaTokens ?? []) {
    for (const value of [token.lastUsedAt, token.createdAt]) {
      const ts = value ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(ts)) times.push(ts);
    }
  }

  for (const value of [user.barsAuthedAt, user.createdAt]) {
    const ts = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ts)) times.push(ts);
  }

  return times.length > 0 ? Math.max(...times) : 0;
}

/** Стоит ли писать событие в историю приложения этому пользователю. */
function shouldStoreInApp(user: StoredUser, now: Date): boolean {
  return now.getTime() - lastAppActivityMs(user) <= IN_APP_HISTORY_WINDOW_MS;
}

/**
 * Функция отправки сообщения конкретному пользователю.
 * Регистрируется telegramService, чтобы сервис не зависел от grammY.
 */
export type NotificationSender = (
  chatId: number,
  text: string,
  kind?: NotificationEvent['kind'],
) => Promise<void>;

let sender: NotificationSender | null = null;
let timer: NodeJS.Timeout | null = null;
let isCycleRunning = false;
/** Когда закончился последний полный круг (для админской диагностики). */
let lastCycleFinishedAt: number | null = null;

/**
 * Функция доставки одного события в Web Push.
 *
 * Отдельный тип, а не прямой вызов: тесты подменяют канал, чтобы проверить
 * поведение снимка без сети и без настоящих подписок.
 */
export type PushSender = (user: StoredUser, event: NotificationEvent) => Promise<boolean>;

let pushSender: PushSender | null = sendPushToUser;

/**
 * Регистрирует канал доставки уведомлений.
 */
export function setNotificationSender(fn: NotificationSender | null): void {
  sender = fn;
}

/** Подменяет push-канал. null — канал выключен (тесты, отладка). */
export function setPushSender(fn: PushSender | null): void {
  pushSender = fn;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Час по Москве (0–23) для указанного момента.
 *
 * Параметр обязателен не для красоты: раньше функция брала «сейчас» изнутри,
 * а `isWithinActiveWindow(now)` этот аргумент молча игнорировал — передать дату
 * в проверку окна было нельзя, и тесты/диагностика получали результат «как
 * сейчас на сервере», а не для запрошенного момента.
 */
function getMoscowHour(now: Date = new Date()): number {
  const { time } = toMoscow(now);
  return Number.parseInt(time.split(':')[0], 10) || 0;
}

/** Находится ли сервер МЭИ внутри активного окна 08:00–23:00 МСК. */
export function isWithinActiveWindow(now: Date = new Date()): boolean {
  const hour = getMoscowHour(now);
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

  // Статус почты для интерфейса: только числа, без содержимого писем.
  // Если на этом круге почту получить не удалось (state.mailIds === null),
  // прежний статус не трогаем — пусть останется последнее известное число.
  if (state.mailIds !== null && state.mailStatus !== null) {
    putMailStatus(user.userId, {
      total: state.mailStatus.total,
      unseen: state.mailStatus.unread,
      lastUid: state.mailIds.reduce((max, message) => Math.max(max, message.uid), 0),
    });
  }

  // Источники, которые на этом круге не опрашивались, сохраняют прошлые значения.
  // Если этого не сделать, пропущенный круг обнулит приказы и стипендию,
  // а на следующем круге пришёл бы ложный дифф с «новыми приказами».
  const currentOrderKeys = state.orders !== null ? state.orders.map(orderKey) : null;
  const seenOrders = currentOrderKeys
    ? Array.from(new Set([...(prev?.ordersSeen ?? []), ...currentOrderKeys])).slice(-500)
    : prev?.ordersSeen;
  const ordersInitialized =
    state.orders !== null ? true : (prev?.ordersInitialized ?? false);

  const next: UserSnapshot = {
    gradesHash:
      state.grades !== null ? buildGradesHash(state.grades) : (prev?.gradesHash ?? {}),
    lastSeenMailUid:
      state.mailIds !== null
        ? Math.max(
            prev?.lastSeenMailUid ?? 0,
            state.mailIds.reduce((max, message) => Math.max(max, message.uid), 0),
          )
        : (prev?.lastSeenMailUid ?? 0),
    ordersCount: state.orders !== null ? state.orders.length : (prev?.ordersCount ?? 0),
    ordersSeen: seenOrders,
    ordersInitialized,
    scholarshipStatus:
      state.scholarship !== null
        ? buildScholarshipStatus(state.scholarship)
        : (prev?.scholarshipStatus ?? 'нет'),
    lastCheckedAt: now.toISOString(),
  };

  // Количество новых писем считается по уже полученным UID. Темы, отправители
  // и тела не читаются: в уведомление уходит только число.
  const newMailCount =
    state.mailIds !== null
      ? state.mailIds.filter((message) => message.uid > (prev?.lastSeenMailUid ?? 0)).length
      : 0;

  // Уведомления строим только по фактически полученным данным: дифф со снимком,
  // где часть полей восстановлена из prev, событий не даёт.
  const events = diffSnapshots(prev, next, {
    orders: state.orders ?? undefined,
    newMailCount,
  });

  // In-app уведомления: детали храним для PWA, Telegram получает только тип.
  // Ключ события стабилен, поэтому повтор круга после сбоя не создаёт дубль.
  //
  // История нужна не только владельцам живого PWA-токена: человек мог выйти
  // с устройства и вернуться позже. Пишем тем, кто заходил за последние 30 дней,
  // чтобы не копить 50 событий для брошенных записей.
  if (events.length > 0 && shouldStoreInApp(user, now)) {
    const createdAt = now.toISOString();
    for (const event of events) {
      userEventStore.add({
        userId: user.userId,
        key: event.key,
        kind: event.kind,
        label: event.label,
        details: event.details,
        createdAt,
      });
    }
  }

  /*
   * Отправляем только тем, кто подключил уведомления и не выключил их.
   *
   * Два условия, и оба обязательны. `typeof === 'number'` вместо проверки на
   * undefined: telegramId бывает null у отвязанного аккаунта, и такой null
   * прошёл бы проверку «поле есть», а отправка ушла бы в null вместо отказа.
   */
  const canNotify = typeof user.telegramId === 'number' && user.notificationsEnabled !== false;
  const shouldSend =
    events.length > 0 && sender !== null && canNotify && typeof user.telegramId === 'number';

  /*
   * Push — независимый канал. Условия свои: включён флагом pushEnabled, есть
   * хотя бы одно устройство и пользователь не гость. Telegram может быть не
   * привязан вовсе — это нормальный случай для PWA-пользователя.
   */
  const canPush =
    user.pushEnabled !== false &&
    user.isGuest !== true &&
    (user.pushSubscriptions?.length ?? 0) > 0;
  const shouldPush = events.length > 0 && pushSender !== null && canPush;

  let delivered = false;
  if (shouldSend && sender && typeof user.telegramId === 'number') {
    try {
      // Адресат в журнале: без него «События: mail» не отвечает на главный
      // вопрос — кому именно пытались отправить.
      console.log(
        `[Notifier] → Telegram ${user.telegramId}: ${events.map((event) => event.kind).join(', ')}`,
      );
      // Каждое событие — отдельным сообщением: в Telegram уходит только тип,
      // без деталей, поэтому смешивать их в одну пачку незачем.
      for (const event of events) {
        await sender(user.telegramId, renderNotification(event), event.kind);
      }
      delivered = true;
      console.log(`[Notifier] доставлено (${user.telegramId})`);
    } catch (err: unknown) {
      console.error(
        `[Notifier] Не удалось отправить уведомление (${user.telegramId}):`,
        safeErrorMessage(err),
      );
    }
  }

  let pushed = false;
  if (shouldPush && pushSender) {
    try {
      console.log(
        `[Push] → ${user.userId}: ${events.map((event) => event.kind).join(', ')}`,
      );

      let accepted = 0;
      for (const event of events) {
        if (await pushSender(user, event)) accepted += 1;
      }

      pushed = accepted > 0;
      console.log(
        pushed
          ? `[Push] доставлено (${user.userId})`
          : `[Push] не доставлено (${user.userId})`,
      );
    } catch (err: unknown) {
      console.error(`[Push] Ошибка отправки (${user.userId}):`, safeErrorMessage(err));
    }
  }

  /*
   * Снимок сдвигаем ПОСЛЕ отправки, и только если она удалась (или отправка не
   * требовалась: нет событий, уведомления выключены, каналы не подключены).
   *
   * Раньше снимок обновлялся всегда. Один сбой Telegram (таймаут, 429, 5xx) —
   * и событие считалось «доставленным»: следующий круг его уже не видел, и
   * уведомление терялось навсегда. Теперь неудачная попытка оставляет прежний
   * снимок, и следующий круг повторяет ту же пачку. Возможный дубль при
   * неоднозначном таймауте лучше молчаливой потери.
   *
   * С двумя каналами правило мягче: достаточно, чтобы событие принял ХОТЯ БЫ
   * один канал. Иначе сбой Telegram заставлял бы повторять пачку, и человек
   * получал бы дубль в приложении — то есть сбой одного канала портил бы
   * работающий.
   *
   * Если уведомления выключены или каналы не подключены, снимок всё равно
   * двигается: иначе при включении пришла бы пачка старых событий.
   */
  snapshotStore.stage(
    user.userId,
    snapshotAfterDelivery(prev, next, shouldSend, delivered, shouldPush, pushed),
  );

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
          clearMailStatus(user.userId);
          forget(user.userId);
          // clearAuth сбрасывает и owaAuth — клиент с прежней сессией больше
          // не нужен, иначе следующий заход пойдёт со старым jar. Кэш
          // «сессия БАРС действительна» тоже недействителен.
          forgetOwaClient(user.userId);
          forgetBarsSessionValid(user.userId);
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
    lastCycleFinishedAt = Date.now();
  }
}

/** Состояние нотификатора для админской диагностики. */
export function notifierRuntimeStatus(): {
  running: boolean;
  lastCycleFinishedAt: number | null;
  activeWindow: boolean;
} {
  return {
    running: isCycleRunning,
    lastCycleFinishedAt,
    activeWindow: isWithinActiveWindow(),
  };
}

/** Идёт ли сейчас любой прогон (фоновый или принудительный). */
export function isNotifierCycleRunning(): boolean {
  return isCycleRunning;
}

/**
 * Что записать в снимок после попытки доставки.
 *
 * Вынесено отдельной функцией ради теста: именно здесь раньше терялись
 * уведомления. Если отправка была нужна, но не удалась — оставляем прежний
 * снимок, чтобы следующий круг повторил события. Во всех остальных случаях
 * (нечего отправлять, уведомления выключены, каналы не подключены, отправлено)
 * снимок сдвигается.
 *
 * С двумя каналами «удалась» означает «принял хотя бы один». Повторять пачку
 * из-за сбоя второго канала значило бы дублировать её в первом.
 */
export function snapshotAfterDelivery(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
  shouldSend: boolean,
  delivered: boolean,
  shouldPush = false,
  pushed = false,
): UserSnapshot {
  if (!shouldSend && !shouldPush) return next;

  const anyChannelDelivered = (shouldSend && delivered) || (shouldPush && pushed);
  return anyChannelDelivered ? next : (prev ?? next);
}

export interface ForcedCycleResult {
  processed: number;
  notified: number;
  errors: number;
}

/** Прогресс прогона: сколько уже проверено из скольких. */
export type ForcedCycleProgress = (processed: number, total: number) => void | Promise<void>;

/**
 * Принудительный прогон для админской кнопки «Обновить почту».
 *
 * Отличия от обычного круга:
 *  - не смотрит на активное окно (админ нажал — значит надо сейчас);
 *  - проверяет ВСЕХ авторизованных в БАРС, а не только тех, у кого есть
 *    Telegram/PWA-токены;
 *  - возвращает счётчики вместо void, чтобы админ увидел результат.
 *
 * Пауза между пользователями и таймаут — те же, что в фоновом цикле: это
 * защита МЭИ от бана, и админская кнопка не должна её обходить. Общий флаг
 * `isCycleRunning` не даёт запустить два прогона одновременно (ни фоновый,
 * ни второй принудительный).
 */
export async function runCycleForced(onProgress?: ForcedCycleProgress): Promise<ForcedCycleResult | null> {
  if (isCycleRunning) return null;

  isCycleRunning = true;
  let processed = 0;
  let notified = 0;
  let errors = 0;

  try {
    const users = userStore.all().filter(isBarsAuthorized);
    console.log(`[Notifier] Принудительный прогон: ${users.length} пользователей.`);

    // Стартовый прогресс (0/N) — чтобы у админа сразу появился счётчик, а не
    // только «идёт». На пустом списке не трогаем: иначе покажем 0/0 и финал.
    if (users.length > 0) await onProgress?.(0, users.length);

    for (let index = 0; index < users.length; index += 1) {
      const user = users[index]!;

      try {
        const withTimeout = Promise.race([
          checkUser(user),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Превышен таймаут проверки пользователя')), PER_USER_TIMEOUT_MS),
          ),
        ]);

        const events = await withTimeout;
        processed += 1;
        if (events.length > 0) notified += 1;
      } catch (err: unknown) {
        errors += 1;
        console.error(`[Notifier] Принудительный прогон, ошибка пользователя:`, safeErrorMessage(err));
      }

      // Прогресс после каждого пользователя: админская кнопка идёт минуты, и
      // молчащее сообщение выглядит как зависание.
      await onProgress?.(index + 1, users.length);

      if (index < users.length - 1) {
        await sleep(USER_DELAY_MS + Math.floor(Math.random() * USER_DELAY_JITTER_MS));
      }
    }

    console.log(
      `[Notifier] Принудительный прогон завершён: проверено ${processed}, уведомлений ${notified}, ошибок ${errors}.`,
    );
  } finally {
    snapshotStore.flush();
    isCycleRunning = false;
    lastCycleFinishedAt = Date.now();
  }

  return { processed, notified, errors };
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

  const intervalLabel = POLL_INTERVAL_MS < 60_000
    ? `${Math.round(POLL_INTERVAL_MS / 1000)} с`
    : `${POLL_INTERVAL_MS / 60000} мин`;
  console.log(
    `[Notifier] Фоновый мониторинг запущен: каждые ${intervalLabel}, окно 08:00–23:00 МСК.`,
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
