/**
 * Фабрика клиентов БАРС: живой BarsService по записи пользователя.
 *
 * Почему этот модуль существует отдельно. Клиент нужен трём потребителям, и
 * только одному из них раньше был нужен бот: REST API веб-приложения
 * (`/api/bars/**`), фоновый нотификатор (`barsNotifier`) и сам бот. После
 * превращения бота в тонкий push-канал его доля исчезает совсем, а удалять
 * вместе с ней фабрику было бы нельзя: без неё в PWA перестали бы работать
 * оценки, пропуски, приказы, стипендия и библиотека, и не приходили бы
 * уведомления.
 *
 * Что внутри и почему так.
 *
 * - Кэш клиентов в памяти (`barsClients`): клиент пересоздаётся не на каждый
 *   вызов, а один раз на пользователя до истечения TTL. Без этого при полусотне
 *   студентов и трёх кругах нотификатора в час получаются сотни операций с
 *   файловой системой в час ради данных, которые уже лежат в users.json.
 *
 * - Ключ кэша — `userId`, а не `telegramId`. Пользователь PWA в Telegram может
 *   не быть вовсе, и при ключе по телеграму его запись не попадала бы в кэш
 *   никогда, и каждый запрос писал бы временный файл заново.
 *
 * - Отпечаток сессии в ключе: повторный вход в БАРС сам собой вытесняет старый
 *   клиент, потому что печенье у новой сессии другое.
 *
 * - Временный файл сессии создаётся ОДИН раз на клиента, а не на каждый
 *   вызов: `loadSavedSession()` умеет читать только с диска. Права 0600 и
 *   флаг 'wx' (O_EXCL) обязательны — без них любой локальный пользователь
 *   читал бы валидные cookie-сессии студентов прямо из /tmp.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  BarsClient,
  SessionExpiredError,
  type SavedSessionData,
} from './barsClient.ts';
import { BarsService } from './barsService.ts';
import { safeErrorMessage } from '../../bot/format.ts';
import { decrypt } from '../../utils/crypto.ts';
import { type StoredUser, userStore } from '../../storage/userStore.ts';

/** Клиент бездействует дольше этого — вытесняется. */
const BARS_CLIENT_TTL_MS = 30 * 60 * 1000;

/** Больше этого клиентов одновременно в памяти держать нельзя. */
const BARS_CLIENT_LIMIT = 60;

/**
 * Адрес дашборда, когда в сессии нет finalUrl.
 *
 * Относительный путь, а не полный URL: клиент идёт на bars.mpei.ru сам и
 * получает сессионные куки именно того домена, которому они принадлежат.
 */
const DEFAULT_DASHBOARD_URL = '/bars_web/ST_Study/Main/Main';

/** Префикс временных файлов сессии — по нему чистим осиротевшие. */
const TEMP_SESSION_PREFIX = 'hub-bars-';

/**
 * Чистим осиротевшие файлы один раз при загрузке модуля.
 *
 * Штатно файл удаляется в finally, но при SIGKILL или падении процесса между
 * записью и удалением в /tmp остаётся валидная сессия — навсегда, до
 * перезагрузки. Файлы своей свежей сессии не трогаем: они создаются после
 * чистки и по времени старта заметно старше.
 */
void sweepOrphanedSessionFiles();

/**
 * Расшифровывает сохранённые логин и пароль из записи пользователя.
 *
 * Ошибка здесь — не «нет данных», а «сессия просрочила»: вызывающий код
 * различает их по типу исключения.
 */
export function readBarsCredentials(user: StoredUser): { login: string; password: string } {
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
 * Креды для веб-почты OWA.
 *
 * Логин и пароль те же, что у БАРС (единая учётка МЭИ), но авторизуются они в
 * ДРУГОМ сервисе — сессия OWA хранится отдельно (`StoredUser.owaAuth`). Функция
 * оставлена отдельной, чтобы читатель кода не подумал, что OWA ходит под
 * cookie-сессией БАРС.
 */
export function readOwaCredentials(user: StoredUser): { login: string; password: string } {
  return readBarsCredentials(user);
}

/** Живой BarsClient пользователя, готовый к запросам. */
interface CachedBarsClient {
  service: BarsService;
  /** Отпечаток сессии: меняется при каждом новом входе. */
  sessionKey: string;
  /** Когда клиент последний раз использовали — по этому живёт TTL. */
  usedAt: number;
  /** Создаётся ли клиент прямо сейчас: параллельные вызовы ждут один промис. */
  inflight: Promise<BarsService> | null;
}

/** Клиенты БАРС в памяти, по одному на пользователя. */
const barsClients = new Map<string, CachedBarsClient>();

/** Отпечаток сессии: участвует в ключе, чтобы релогин дал новый клиент. */
function sessionFingerprint(user: StoredUser): string {
  const auth = user.barsAuth;
  const cookies = auth?.cookiesJson ?? '';
  // cookiesJson бывает в сотни килобайт, а для отпечатка хватает префикса:
  // режем ДО сложения со строкой, иначе шаблонная строка скопировала бы весь
  // JSON целиком на каждый вызов, чтобы тут же его отбросить.
  return `${auth?.savedAt ?? ''}:${cookies.length}:${cookies.slice(0, 512)}`;
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
 *
 * Принимает и `telegramId`, и `userId`: вызывающий код у бота мыслит в
 * телеграме, у API и нотификатора — в userId.
 */
export function forgetBarsClient(key: number | string): void {
  if (typeof key === 'number') {
    const user = userStore.get(key);
    if (user) barsClients.delete(user.userId);
    return;
  }

  barsClients.delete(key);
}

/** Сколько клиентов сейчас в памяти. Только для тестов и диагностики. */
export function barsClientCacheStats(): { clients: number } {
  return { clients: barsClients.size };
}

/**
 * Восстанавливает BarsClient из сохранённой сессии пользователя.
 *
 * Точка входа для всех, кому нужен живой доступ к ЛК: оценки, пропуски, приказы,
 * книги, фоновое опрашивание.
 */
export async function createBarsServiceForUser(user: StoredUser): Promise<BarsService> {
  const auth = user.barsAuth;
  if (!auth) {
    throw new SessionExpiredError('Нет сохраненной сессии БАРС. Требуется повторный вход.');
  }

  const now = Date.now();
  const key = sessionFingerprint(user);
  const cached = barsClients.get(user.userId);

  // Готовый клиент с той же сессией — возвращаем его и продлеваем жизнь.
  if (cached && !cached.inflight && cached.sessionKey === key) {
    cached.usedAt = now;
    barsClients.delete(user.userId);
    barsClients.set(user.userId, cached);
    return cached.service;
  }

  // Сессия сменилась (повторный вход) — прежний клиент больше не годится.
  if (cached && cached.sessionKey !== key) {
    barsClients.delete(user.userId);
  }

  // Клиент уже создаётся — ждём тот же промис, второй temp-файл не пишем.
  const pending = barsClients.get(user.userId)?.inflight;
  if (pending) return pending;

  evictBarsClients(now);

  const inflight = buildBarsService(user);
  barsClients.set(user.userId, { service: null as never, sessionKey: key, usedAt: now, inflight });

  try {
    const service = await inflight;
    barsClients.set(user.userId, { service, sessionKey: key, usedAt: now, inflight: null });
    return service;
  } catch (err: unknown) {
    // Не оставляем неудавшийся промис в кэше: следующий вызов должен повторить.
    barsClients.delete(user.userId);
    throw err;
  }
}

/**
 * Создаёт клиента с нуля: расшифровывает сессию, пишет temp-файл, читает его.
 * Temp-файл нужен только здесь — loadSavedSession() умеет читать лишь с диска.
 */
async function buildBarsService(user: StoredUser): Promise<BarsService> {
  const auth = user.barsAuth;
  if (!auth) {
    throw new SessionExpiredError('Нет сохраненной сессии БАРС. Требуется повторный вход.');
  }

  const restored = readSavedSessionPayload(auth.cookiesJson);
  const client = new BarsClient();
  const tempPath = makeTempSessionPath();

  try {
    // Сессия кладётся во временный файл и сразу удаляется: на диске остаются
    // только зашифрованные данные пользователя.
    await writeTempSession(tempPath, {
      savedAt: auth.savedAt,
      finalUrl: restored.finalUrl ?? DEFAULT_DASHBOARD_URL,
      cookies: restored.cookies,
    });
    await client.loadSavedSession(tempPath);
  } catch (err: unknown) {
    throw new SessionExpiredError(
      `Не удалось восстановить сессию БАРС: ${safeErrorMessage(err)}`,
    );
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
 * Временный файл сессии: не хранит пароль на диске, удаляется сразу после чтения.
 *
 * Пишется в общий os.tmpdir(), поэтому права закрываются явно: 0600 и флаг 'wx'
 * (O_EXCL). Без этого любой локальный пользователь читал бы валидные
 * cookie-сессии студентов прямо из /tmp.
 */
function makeTempSessionPath(): string {
  return path.join(os.tmpdir(), `hub-bars-${randomUUID()}.json`);
}

/** Записывает сессию во временный файл с закрытыми правами. */
async function writeTempSession(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
    // O_EXCL: отказ, если файл уже существует — исключает подмену и гонку.
    flag: 'wx',
  });
}

async function removeTempSessionFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // файла уже нет — ничего страшного
  }
}

/**
 * Удаляет осиротевшие временные файлы сессий.
 *
 * Штатно файл удаляется в finally, но при SIGKILL или падении процесса между
 * записью и удалением в /tmp остаётся валидная сессия — навсегда, до перезагрузки.
 * Чистка на старте закрывает эту дыру. Файлы своей свежей сессии не трогаем:
 * они создаются после чистки, а по времени старта заметно старше.
 */
async function sweepOrphanedSessionFiles(maxAgeMs = 60 * 60 * 1000): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(os.tmpdir());
  } catch {
    return;
  }

  const now = Date.now();

  for (const name of entries) {
    if (!name.startsWith(TEMP_SESSION_PREFIX) || !name.endsWith('.json')) continue;

    const full = path.join(os.tmpdir(), name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      await fs.unlink(full);
    } catch {
      // файл уже исчез или занят — не страшно
    }
  }
}

/**
 * Проверяет актуальность сохранённой сессии БАРС.
 *
 * Любая ошибка — это «недействительна»: человек всё равно не сможет открыть
 * разделы ЛК, и разбираться в причине ему незачем.
 */
export async function isBarsSessionValid(user: StoredUser): Promise<boolean> {
  try {
    const service = await createBarsServiceForUser(user);
    return await service.isSessionValid();
  } catch {
    return false;
  }
}