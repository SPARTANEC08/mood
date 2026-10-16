/**
 * Ограничитель попыток входа в БАРС МЭИ.
 *
 * Зачем: раньше воронка принимала неограниченное число логин/пароль, поэтому
 * бот был готовым прокси для перебора university-аккаунтов. И блокировка прилетала
 * по IP сервера, то есть досталась бы владельцу бота, а не атакующему.
 *
 * Счётчики живут в памяти процесса и не переживают перезапуск — этого достаточно:
 * обход по перезапуску стоит атакующему дороже, чем сам перебор.
 *
 * Лимит считается по двум осям сразу:
 * - по владельцу сессии: у бота это Telegram ID, у PWA — адрес клиента;
 * - по логину БАРС (чтобы поймать подбор разных учёток с одного клиента).
 *
 * Ось владельца не может быть «просто пользователем приложения»: блокировка
 * по логину БАРС ограничила бы перебор, но не ограничила бы подбор пароля к
 * одному логину с тысячи разных адресов. По той же причине у PWA ключом
 * служит адрес, а не userId: иначе блокировка накапливалась бы на том, кто
 * уже вошёл, и не защищала бы ни вход, ни перебор.
 */

interface Bucket {
  /** Время первого неудачного входа в текущем окне. */
  startedAt: number;
  /** Сколько неудачных попыток в этом окне. */
  failures: number;
  /** До какого момента вход заблокирован (0 — не заблокирован). */
  blockedUntil: number;
  /** Сколько блокировок подряд — от этого растёт пауза. */
  strikes: number;
}

/** Неудачных попыток в окне, после которого вход блокируется. */
const MAX_FAILURES = 5;

/** Длина окна подсчёта попыток. */
const WINDOW_MS = 15 * 60 * 1000;

/** Базовая пауза после исчерпания попыток. */
const BLOCK_MS = 15 * 60 * 1000;

/** Каждая следующая блокировка удваивается, но не выше потолка. */
const MAX_BLOCK_MS = 6 * 60 * 60 * 1000;

const byOwner = new Map<string, Bucket>();
const byLogin = new Map<string, Bucket>();

/** Периодическая уборка: иначе память растёт вместе с числом попыток. */
const MAX_TRACKED = 10_000;
const sweeps = [byOwner, byLogin];

function sweep(map: Map<string | number, Bucket>, now: number): void {
  for (const [key, bucket] of map) {
    const expired = now - bucket.startedAt > WINDOW_MS && now > bucket.blockedUntil;
    if (expired) map.delete(key);
  }
  // Аварийный потолок: если ключей неприлично много, чистим самые старые.
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const map of sweeps) sweep(map, now);
}, 5 * 60 * 1000);
sweepTimer.unref?.();

function touch(map: Map<string | number, Bucket>, key: string | number, now: number): Bucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { startedAt: now, failures: 0, blockedUntil: 0, strikes: 0 };
    map.set(key, bucket);
    return bucket;
  }
  // Окно истекло и блокировка снята — начинаем заново.
  if (now - bucket.startedAt > WINDOW_MS && now > bucket.blockedUntil) {
    bucket.startedAt = now;
    bucket.failures = 0;
    bucket.blockedUntil = 0;
    bucket.strikes = 0;
  }
  return bucket;
}

export interface LoginAttemptState {
  /** Вход заблокирован. */
  blocked: boolean;
  /** Через сколько миллисекунд можно попробовать снова. */
  retryAfterMs: number;
}

/**
 * Проверяет, можно ли сейчас пробовать вход. Ничего не расходует —
 * только чтение состояния.
 */
export function checkLoginAllowed(ownerKey: number | string, login?: string): LoginAttemptState {
  const now = Date.now();
  const buckets: Bucket[] = [touch(byOwner, String(ownerKey), now)];

  const key = normalizeLogin(login);
  if (key) buckets.push(touch(byLogin, key, now));

  let retryAfterMs = 0;
  for (const bucket of buckets) {
    const remaining = bucket.blockedUntil - now;
    if (remaining > retryAfterMs) retryAfterMs = remaining;
  }

  return { blocked: retryAfterMs > 0, retryAfterMs };
}

/**
 * Регистрирует неудачную попытку. Возвращает состояние после учёта —
 * если оно became blocked, значит пора показать пользователю паузу.
 */
export function registerLoginFailure(ownerKey: number | string, login?: string): LoginAttemptState {
  const now = Date.now();
  const key = normalizeLogin(login);
  const keys: string[] = [String(ownerKey)];
  if (key) keys.push(key);

  let maxBlock = 0;

  for (const k of keys) {
    // Первый ключ — владелец сессии, остальные — варианты того же логина.
    const map = (k === keys[0] ? byOwner : byLogin) as Map<string | number, Bucket>;
    const bucket = touch(map, k, now);
    bucket.failures += 1;

    if (bucket.failures >= MAX_FAILURES) {
      // Чем дольше долбят, тем дольше пауза: каждая блокировка удваивает её,
      // но не выше потолка. Успешный вход обнуляет счётчик (registerLoginSuccess).
      bucket.strikes += 1;
      const block = Math.min(BLOCK_MS * 2 ** (bucket.strikes - 1), MAX_BLOCK_MS);
      bucket.blockedUntil = now + block;
      // Окно сдвигаем, чтобы следующая серия попыток считалась заново.
      bucket.startedAt = now;
      bucket.failures = 0;
      if (block > maxBlock) maxBlock = block;
    }
  }

  return { blocked: maxBlock > 0, retryAfterMs: maxBlock };
}

/** Успешный вход сбрасывает счётчики — человек не должен ждать после успеха. */
export function registerLoginSuccess(ownerKey: number | string, login?: string): void {
  byOwner.delete(String(ownerKey));
  const key = normalizeLogin(login);
  if (key) byLogin.delete(key);
}

/** Сброс для тестов и диагностики. */
export function resetLoginLimiter(): void {
  byOwner.clear();
  byLogin.clear();
}

/** Логин приводится к виду, в котором его шлют в БАРС. */
function normalizeLogin(login: string | undefined): string | null {
  const trimmed = (login ?? '').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Пауза в человекочитаемом виде для показа пользователю.
 */
export function formatRetryAfter(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;

  const noun =
    mod10 === 1 && mod100 !== 11
      ? 'минуту'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'минуты'
        : 'минут';

  return `${minutes} ${noun}`;
}