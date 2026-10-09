/**
 * Фоновый сервис мониторинга БАРС МЭИ и почты ОСЭП.
 *
 * Ключевые ограничения, заложенные в архитектуру:
 * - опрос строго последовательный, с паузой между студентами (anti-ban для МЭИ);
 * - ночью (по Москве) воркер спит;
 * - любая ошибка сети глушится и переносится на следующий круг, процесс бота не падает.
 *
 * Сервис не знает про Telegram: получателю сообщений передаётся функция отправки,
 * которую регистрирует telegramService.
 */

import type { SemesterGrades } from '../bars/parsers/gradesParser.js';
import type { OrderItem, ScholarshipInfo } from '../bars/parsers/studentInfoParser.js';
import type { OsepMessageBrief } from '../mail/types.js';
import { isBarsAuthorized, TelegramUser, userStore } from '../../storage/userStore.js';
import { isBaselineSnapshot, snapshotStore, UserSnapshot } from '../../storage/snapshotStore.js';
import { toMoscow } from '../../utils/time.js';
import { b, esc, fmtNum, i, RULE } from '../../bot/format.js';
import { readBarsCredentials } from '../../bot/authFlow.js';
import { createBarsServiceForUser } from '../../bot/authFlow.js';
import { OsepMailClient } from '../mail/osepMailClient.js';
import {
  dueSources,
  forget,
  markActive,
  markChecked,
  type Source,
} from './pollSchedule.js';

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

/**
 * Текущий час по Москве (0–23).
 */
function getMoscowHour(): number {
  const { time } = toMoscow();
  return Number.parseInt(time.split(':')[0], 10) || 0;
}

/**
 * Находится ли сервер МЭИ внутри активного окна 08:00–23:00 МСК.
 */
export function isWithinActiveWindow(now: Date = new Date()): boolean {
  const hour = getMoscowHour();
  return hour >= ACTIVE_FROM_HOUR && hour < ACTIVE_TO_HOUR;
}

/**
 * Собирает ключи баллов вида "Дисциплина_КТ1" из страницы успеваемости.
 * null означает, что контрольная точка ещё не закрыта баллом.
 */
export function buildGradesHash(grades: SemesterGrades): Record<string, number | null> {
  const out: Record<string, number | null> = {};

  for (const subject of grades.subjects) {
    const discipline = subject.discipline.trim();
    for (const point of subject.controlPoints) {
      out[`${discipline}_КТ${point.number}`] = point.score;
    }
  }

  return out;
}

/**
 * Нормализует статус стипендии в короткую строку для сравнения.
 */
export function buildScholarshipStatus(scholarship: ScholarshipInfo): string {
  if (!scholarship.isAppointed) return 'нет';
  return [scholarship.type, scholarship.period].filter(Boolean).join(', ') || 'назначена';
}

/**
 * Определяет, является ли ошибка сетевой/серверной, а не логической.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? '';

  return (
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up/i.test(
      `${message} ${code}`,
    ) ||
    /HTTP error (429|500|502|503|504)|status code (429|500|502|503|504)/i.test(message) ||
    /Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-out/i.test(message) ||
    /\b(429|500|502|503|504)\b/.test(message)
  );
}

/**
 * Событие, готовое к отправке студенту.
 */
export interface NotificationEvent {
  kind: 'grade' | 'mail' | 'order' | 'scholarship';
  title: string;
  lines: string[];
}

function truncate(value: string, max: number): string {
  const clean = (value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Сравнивает снимки и формирует список событий.
 * Пустой prev означает базовую линию: уведомления не шлём, только сохраняем.
 */
export function diffSnapshots(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
  context: {
    grades?: SemesterGrades;
    mails?: OsepMessageBrief[];
    orders?: OrderItem[];
  } = {},
): NotificationEvent[] {
  if (isBaselineSnapshot(prev) || !prev) return [];

  const events: NotificationEvent[] = [];

  // 1. Новые баллы по контрольным точкам
  const changedGrades = Object.entries(next.gradesHash).filter(
    ([key, value]) =>
      value !== null &&
      (prev.gradesHash[key] === undefined || prev.gradesHash[key] === null || prev.gradesHash[key] !== value),
  );

  if (changedGrades.length > 0) {
    const lines = changedGrades.map(([key, value]) => {
      const idx = key.lastIndexOf('_КТ');
      const discipline = idx > 0 ? key.slice(0, idx) : key;
      const point = idx > 0 ? key.slice(idx + 1) : '';
      const before = prev.gradesHash[key];
      const delta =
        before !== null && before !== undefined && typeof before === 'number' && value !== null
          ? value - before
          : null;
      const deltaStr = delta !== null && delta !== 0 ? ` ${i(`(${delta > 0 ? '+' : ''}${fmtNum(delta)})`)}` : '';
      return `• ${b(esc(truncate(discipline, 60)))} ${i(esc(point))}: ${b(fmtNum(value))}${deltaStr}`;
    });

    events.push({
      kind: 'grade',
      title: `📊 ${b('Новые баллы в БАРС')}`,
      lines,
    });
  }

  // 2. Новые письма ОСЭП
  if (next.lastSeenMailUid > prev.lastSeenMailUid) {
    const fresh = (context.mails ?? [])
      .filter((m) => m.uid > prev.lastSeenMailUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, 5);

    const lines = fresh.length > 0
      ? fresh.map((m) => {
          const att = m.hasAttachments ? '  📎' : '';
          return `• ${b(esc(truncate(m.subject, 60)))}${att}\n   ${i(esc(truncate(m.from, 40)))}`;
        })
      : [i('Подробнее — в разделе «📬 ОСЭП».')];

    events.push({
      kind: 'mail',
      title: `📬 ${b('Новое письмо на почте МЭИ')}`,
      lines,
    });
  }

  // 3. Новые приказы
  if (next.ordersCount > prev.ordersCount) {
    const added = Math.max(0, next.ordersCount - prev.ordersCount);
    const latest = (context.orders ?? []).slice(0, 3).map((o) => {
      const num = o.number ? `№${esc(o.number)}` : '';
      const date = o.date ? ` от ${esc(o.date)}` : '';
      return `• ${i(`${num}${date}`.trim())} ${esc(truncate(o.title, 60))}`;
    });

    events.push({
      kind: 'order',
      title: `📜 ${b('Новые приказы')}`,
      lines: [`Новых приказов: ${b(String(added))}`, ...latest],
    });
  }

  // 4. Изменение стипендии
  if (next.scholarshipStatus !== prev.scholarshipStatus) {
    events.push({
      kind: 'scholarship',
      title: `🎓 ${b('Изменение стипендии')}`,
      lines: [`Статус: ${esc(next.scholarshipStatus)}`],
    });
  }

  return events;
}

/**
 * Собирает текст сообщения из событий.
 *
 * Снизу добавляется подпись: главное сообщение бота перезаписывается при каждом
 * действии, а уведомление остаётся в переписке. Без пояснения кнопка «Скрыть»
 * выглядит неожиданно, и часть пользователей просто её не нажимает.
 */
export function renderNotification(events: NotificationEvent[]): string {
  const blocks = events.map((event) => [event.title, RULE, ...event.lines].join('\n'));
  return [...blocks, i('Сообщение можно скрыть кнопкой ниже.')].join('\n\n');
}

interface CollectedState {
  grades: SemesterGrades | null;
  orders: OrderItem[] | null;
  scholarship: ScholarshipInfo | null;
  mails: OsepMessageBrief[] | null;
}

/**
 * Что реально удалось собрать на этом круге. Незапрошенные источники остаются
 * null, и в снимке сохраняются прежние значения — иначе пропущенный круг
 * обнулил бы приказы и стипендию и вызвал бы ложное уведомление.
 */
export interface FetchResult {
  state: CollectedState;
  fetched: Source[];
}

/**
 * Выполняет сетевой заход по данным пользователя.
 *
 * Каждый блок изолирован: падение почты не должно обнулять оценки.
 * Источники опрашиваются только те, что `due` по графику частот.
 */
async function collectState(user: TelegramUser, now: Date): Promise<FetchResult> {
  const sources = dueSources(user.telegramId, now);
  if (sources.length === 0) {
    return { state: { grades: null, orders: null, scholarship: null, mails: null }, fetched: [] };
  }

  const state: CollectedState = { grades: null, orders: null, scholarship: null, mails: null };
  const service = await createBarsServiceForUser(user);
  const scraper = service.getScraper();

  const barsJobs: Promise<void>[] = [];

  // Оценки. Разбор страницы — 9.8 мс, из них 5.1 мс уходит на cheerio.load.
  // Пропускать разбор по хешу HTML не стали: выигрыш копеечный, а проверка
  // протухшей сессии живёт внутри cheerio-разбора, и подмена её на регулярки
  // грозит тихой поломкой (бот будет биться в стену вместо запроса нового входа).
  if (sources.includes('grades')) {
    barsJobs.push(
      scraper.getCurrentSemesterGrades().then((grades) => {
        state.grades = grades;
      }),
    );
  }

  // Приказы и стипендия меняются от раза к разу в семестр.
  if (sources.includes('info')) {
    barsJobs.push(
      scraper.getOrders().then((orders) => {
        state.orders = orders;
      }),
    );
    barsJobs.push(
      scraper.getScholarship().then((scholarship) => {
        state.scholarship = scholarship;
      }),
    );
  }

  // Почта ОСЭП: отдельный блок, ошибки не влияют на остальные данные.
  // Нотификатору нужно лишь понять, что письмо новое, поэтому берём
  // метаданные из ENVELOPE/BODYSTRUCTURE без скачивания тел.
  const mailJob = (async () => {
    try {
      const { login, password } = readBarsCredentials(user);
      const mail = new OsepMailClient({ user: login, pass: password });
      state.mails = await mail.fetchMessageBriefs({ onlyUnread: false, limit: 15 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Notifier][${user.telegramId}] ОСЭП недоступна, пропускаю: ${msg}`);
    }
  })();

  const [barsResults, mailDone] = await Promise.all([
    Promise.allSettled(barsJobs),
    mailJob,
  ]);

  // БАРС целиком недоступен — считаем это сетевой ошибкой, снимок не обновляем.
  const barsErrors = barsResults
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  if (barsErrors.length > 0) {
    const first = barsErrors[0];
    throw first instanceof Error ? first : new Error(String(first ?? 'БАРС недоступен'));
  }

  markChecked(user.telegramId, sources, now);

  return {
    state,
    fetched: sources.filter((s) => (s === 'mail' ? state.mails !== null : true)),
  };
}

/**
 * Обновляет снимок по одному пользователю и возвращает отправленные события.
 */
export async function checkUser(
  user: TelegramUser,
  now: Date = new Date()
): Promise<NotificationEvent[]> {
  const prev = snapshotStore.get(user.telegramId);
  const { state } = await collectState(user, now);

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
  snapshotStore.stage(user.telegramId, next);

  if (events.length > 0 && sender) {
    try {
      await sender(user.telegramId, renderNotification(events));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Notifier][${user.telegramId}] Не удалось отправить уведомление: ${msg}`);
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
    const users = userStore.all().filter(isBarsAuthorized);

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
          console.log(
            `[Notifier][${user.telegramId}] События: ${events.map((e) => e.kind).join(', ')}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Notifier][${user.telegramId}] Ошибка проверки: ${msg}`);

        if (isTransientNetworkError(err)) {
          consecutiveFailures += 1;
        }

        // Сессия БАРС истекла: чистим, чтобы пользователя больше не мучили ошибками
        if (/сессия/i.test(msg) || /SessionExpiredError/.test(msg)) {
          userStore.clearAuth(user.telegramId);
          snapshotStore.remove(user.telegramId);
          forget(user.telegramId);
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
export async function checkUserNow(telegramId: number): Promise<NotificationEvent[]> {
  const user = userStore.get(telegramId);
  if (!isBarsAuthorized(user)) {
    throw new Error('Пользователь не авторизован в БАРС МЭИ.');
  }
  forget(telegramId);
  return checkUser(user);
}

export { markActive };