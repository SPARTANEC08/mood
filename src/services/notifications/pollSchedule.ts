/**
 * График частот фонового опроса.
 *
 * Раньше нотификатор ходил по всем источникам каждые 20 минут для каждого
 * студента. Это 3 страницы БАРС + 1 сессия IMAP на студента каждые 20 минут,
 * то есть 216 HTTP-запросов к bars.mpei.ru на студента в сутки — ради данных,
 * которые меняются от раза к разу в разы реже.
 *
 * Здесь описано, как часто опрашивать каждый источник. Дефолты совпадают с
 * прежним поведением (20 минут на всё), поэтому включение этого модуля само по
 * себе ничего не меняет для пользователя. Экономия достигается двухфазной
 * проверкой (см. barsNotifier) и адаптивностью по активности.
 *
 * Чтобы перейти на экономный режим, достаточно поменять значения ниже —
 * например, GRADES_INTERVAL_MS на 3 часа. Это осознанный размен: уведомление
 * о новой оценке будет приходить позже, но не позже чем на этот интервал.
 */

/** Источники данных, опрашиваемых независимо друг от друга. */
export type Source = 'mail' | 'grades' | 'info';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Почта ОСЭП: единственный источник, где события приходят в течение часа,
 * поэтому частота остаётся прежней.
 */
export const MAIL_INTERVAL_MS = 20 * MINUTE;

/**
 * Успеваемость (`/ST_Study/Main/Main`): контрольные точки закрываются
 * преподавателями в произвольные моменты, но не чаще пары раз в день.
 */
export const GRADES_INTERVAL_MS = 20 * MINUTE;

/**
 * Приказы и стипендия: меняются раз в семестр, часовой частоты не требуют.
 */
export const INFO_INTERVAL_MS = 20 * MINUTE;

/** Базовые интервалы по источникам. */
export const BASE_INTERVAL_MS: Record<Source, number> = {
  mail: MAIL_INTERVAL_MS,
  grades: GRADES_INTERVAL_MS,
  info: INFO_INTERVAL_MS,
};

/**
 * Активность пользователя: когда он последний раз заходил в бота.
 * Не заходил дольше этого времени — понижаем частоту.
 */
export const ACTIVE_WITHIN_MS = 48 * HOUR;

/**
 * Множитель интервала для пользователей, которые давно не заходили.
 * Их уведомления всё равно дойдут, но реже: 6 часов вместо 20 минут.
 */
export const DORMANT_MULTIPLIER = 18;

/**
 * Время последней проверки по каждому источнику, в памяти процесса.
 * Не сохраняется на диск намеренно: после рестарта процесса все проверяются
 * один раз заново, что к тому же нужно — состояние БАРС могло устареть,
 * пока бот лежал.
 */
const lastChecked = new Map<string, Partial<Record<Source, number>>>();

/** Когда пользователь последний раз пользовался ботом, в памяти процесса. */
const lastActivity = new Map<string, number>();

/**
 * Помечает пользователя активным. Вызывается из botEngine на каждом апдейте.
 */
export function markActive(userId: string, now: Date = new Date()): void {
  lastActivity.set(userId, now.getTime());
}

/**
 * Интервал для конкретного пользователя и источника с учётом активности.
 */
export function intervalFor(userId: string, source: Source, now: Date = new Date()): number {
  const base = BASE_INTERVAL_MS[source];
  const seen = lastActivity.get(userId);

  // Активность известна только из текущего процесса. Неизвестна — считаем активным,
  // чтобы не понижать частоту у пользователя, который просто перезапустил VPS.
  if (seen === undefined) return base;

  const idleMs = now.getTime() - seen;
  return idleMs > ACTIVE_WITHIN_MS ? base * DORMANT_MULTIPLIER : base;
}

/**
 * Пора ли опрашивать источник: прошло ли достаточно времени с прошлой проверки.
 * Первый вызов всегда «пора» — иначе новый пользователь не получит уведомлений.
 */
export function isDue(userId: string, source: Source, now: Date = new Date()): boolean {
  const last = lastChecked.get(userId)?.[source];
  if (last === undefined) return true;
  return now.getTime() - last >= intervalFor(userId, source, now);
}

/**
 * Какие источники нужно опросить на этом круге.
 */
export function dueSources(userId: string, now: Date = new Date()): Source[] {
  return (['mail', 'grades', 'info'] as Source[]).filter((s) => isDue(userId, s, now));
}

/**
 * Отмечает источник как только что проверенный.
 */
export function markChecked(userId: string, sources: Source[], now: Date = new Date()): void {
  const entry = lastChecked.get(userId) ?? {};
  for (const source of sources) {
    entry[source] = now.getTime();
  }
  lastChecked.set(userId, entry);
}

/**
 * Забывает график пользователя: после сброса авторизации в БАРС
 * следующая проверка должна быть немедленной.
 */
export function forget(userId: string): void {
  lastChecked.delete(userId);
  lastActivity.delete(userId);
}

/**
 * Сбрасывает весь график. Только для тестов.
 */
export function resetSchedule(): void {
  lastChecked.clear();
  lastActivity.clear();
}