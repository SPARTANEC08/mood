/**
 * Почтовый клиент МЭИ через OWA-скрапинг (mail.mpei.ru/owa).
 *
 * ПОЧЕМУ НЕ IMAP. Порт `mail.mpei.ru:993` режется Forefront TMG: TCP
 * устанавливается, но сервер рвёт TLS-рукопожатие (`RST` на ClientHello), и
 * сертификат не отдаётся вовсе. Веб-интерфейс `https://mail.mpei.ru/owa` при
 * этом работает: TMG пропускает HTTPS, а вход идёт через обычную форму (FBA,
 * «частный компьютер»). Поэтому единственный рабочий путь — логиниться в OWA
 * так же, как браузер, и забирать список писем из его внутренних эндпоинтов.
 *
 * КОНТРАКТ (Exchange / OWA 2013 JSON, соответствует mail.mpei.ru). Точные
 * имена полей ниже — стандартный протокол OWA 2013; при первом запуске с живым
 * ящиком включите `OWA_DEBUG=1` и сверьте по журналу (см. `debug()`), при
 * расхождении поправьте здесь.
 *
 *  1. Вход (FBA, OWA 2010-сборка mail.mpei.ru — подтверждено GET /owa/):
 *     GET  /owa/            — страница формы (200, форма `POST /CookieAuth.dll?Logon`);
 *                             из неё берём скрытые input (curl, flags,
 *                             forcedownlevel, formdir, isUtf8, chpwd, chkBsc).
 *     POST /CookieAuth.dll?Logon — form-urlencoded: все скрытые поля +
 *                             username, password, trusted=4 («частный компьютер»).
 *     Успех: редирект на /owa/ и куки сессии (cadata/sessionid).
 *     Неверный пароль: возврат на форму входа. 403/«Network Access Message» /
 *     «The page cannot be displayed»/`/Wbo-` — Forefront TMG (нет сети МЭИ/VPN).
 *
 *  2. Все запросы после входа шлют заголовок `X-OWA-CANARY` со значением
 *     одноимённой cookie (если OWA её выдал) — без него часть запросов даёт 401.
 *
 *  3. Число писем:
 *     POST /owa/service.svc?action=GetFolder&AC=1  (JSON GetFolderJsonRequest,
 *     FolderIds=[DistinguishedFolderId inbox], свойства folder:UnreadCount,
 *     folder:TotalCount).
 *
 *  4. Список писем:
 *     POST /owa/service.svc?action=FindItem&AC=1  (JSON FindItemJsonRequest,
 *     BaseShape IdOnly + Subject/DateTimeReceived/From/HasAttachments/IsRead,
 *     Paging IndexedPageView, сортировка по DateTimeReceived вниз).
 *
 * Стек — как в `barsClient.ts`: axios + axios-cookiejar-support + tough-cookie.
 * Сессия OWA (cookie) хранится ОТДЕЛЬНО от сессии БАРС (`StoredUser.owaAuth`).
 */

import axios, { type AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as https from 'node:https';

import { MailAuthError, MailTimeoutError, MailUnreachableError } from './mailErrors.ts';
import type { OsepMessageBrief } from './types.js';

const OWA_ORIGIN = 'https://mail.mpei.ru';
const OWA_BASE = `${OWA_ORIGIN}/owa`;
const LOGIN_PAGE = `${OWA_BASE}/`;
const AUTH_URL = `${OWA_BASE}/auth.owa`;
const OWA_TIMEOUT_MS = 20_000;

/** Заголовки «как браузер»: OWA отдаёт разные представления отрезанному клиенту. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
};

/** Диагностический лог OWA. Включается `OWA_DEBUG=1`; секреты редактируются. */
function debug(stage: string, data?: Record<string, unknown>): void {
  if (process.env.OWA_DEBUG !== '1') return;
  const safe = data
    ? Object.fromEntries(
        Object.entries(data).map(([k, v]) => {
          // Пароль и cookie не логируем ни при каких условиях.
          if (/pass|cookie|canary|authorization/i.test(k)) return [k, '<redacted>'];
          if (typeof v === 'string' && v.length > 300) return [k, `${v.slice(0, 300)}…(${v.length})`];
          return [k, v];
        }),
      )
    : undefined;
  console.log(`[OWA] ${stage}`, safe ? JSON.stringify(safe) : '');
}

export interface OwaCredentials {
  /** Логин БАРС (без @mpei.ru — сервер принимает оба). */
  user: string;
  pass: string;
}

export interface OwaInboxStatus {
  total: number;
  unread: number;
}

interface OwaOptions {
  /** Ранее сохранённые cookies (JSON tough-cookie) — переиспользовать сессию. */
  cookiesJson?: string;
  /** Отключить проверку TLS (корень УЦ МЭИ недоступен); по умолчанию строго. */
  tlsInsecure?: boolean;
}

/** Тело JSON-заголовка OWA 2013, которое шлёт браузер. */
const OWA_HEADER = {
  __type: 'JsonRequestHeaders',
  RequestServerVersion: 'Exchange2013',
} as const;

export class OwaMailClient {
  private readonly credentials: OwaCredentials;
  private jar: CookieJar;
  private client: AxiosInstance;
  /** Флаг «сессию уже проверили/подняли» — чтобы не логиниться на каждый вызов. */
  private sessionReady = false;

  constructor(credentials: OwaCredentials, options: OwaOptions = {}) {
    this.credentials = {
      user: credentials.user.trim().replace(/@mpei\.ru$/i, ''),
      pass: credentials.pass,
    };
    this.jar = options.cookiesJson ? loadJar(options.cookiesJson) : new CookieJar();
    this.client = this.createAxiosInstance(options.tlsInsecure ?? process.env.OWA_TLS_INSECURE === '1');
  }

  private createAxiosInstance(insecureTls: boolean): AxiosInstance {
    return wrapper(
      axios.create({
        proxy: false,
        maxRedirects: 10,
        timeout: OWA_TIMEOUT_MS,
        headers: BROWSER_HEADERS,
        // Строгая проверка TLS по умолчанию; внутри сети МЭИ/при самоподписанном
        // сертификате TMG включается OWA_TLS_INSECURE=1 (см. §17 info.md).
        httpsAgent: new https.Agent({ rejectUnauthorized: !insecureTls, keepAlive: true }),
        validateStatus: (s) => s >= 200 && s < 500,
      }),
    );
  }

  /** Сериализованная сессия для сохранения в `StoredUser.owaAuth.cookiesJson`. */
  serializeCookies(): string {
    return JSON.stringify(this.jar.serializeSync() ?? { cookies: [] });
  }

  /** Плоский список cookies (key/value) — для проверки сессии и canary. */
  private cookies(): Array<{ key: string; value: string }> {
    const serialized = this.jar.serializeSync();
    const list = serialized?.cookies ?? [];
    return list.map((c) => ({ key: String(c.key ?? ''), value: String(c.value ?? '') }));
  }

  /**
   * Гарантирует живой сессию: переиспользует cookies, иначе логинится.
   * Прозрачно перелогинивается один раз при 401.
   */
  async ensureSession(): Promise<void> {
    if (this.sessionReady) return;

    // Есть cookies — считаем сессию поднятой; проверит первый же запрос.
    if (this.cookies().length > 0) {
      this.sessionReady = true;
      return;
    }

    await this.login();
  }

  /** Полный вход по форме (FBA). */
  async login(): Promise<void> {
    debug('login: GET', { url: LOGIN_PAGE });
    const page = await this.rawGet(LOGIN_PAGE, { Accept: 'text/html,application/xhtml+xml' });

    const $ = cheerio.load(page.body);
    const form = $('form').first();
    const action = form.attr('action') || AUTH_URL;

    const hidden: Record<string, string> = {};
    form.find('input').each((_, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      hidden[name] = $(el).attr('value') ?? '';
    });

    // Тело FBA: сохраняем ВСЕ скрытые поля формы (curl, flags, forcedownlevel,
    // formdir, isUtf8, chpwd, chkBsc) и подставляем логин/пароль. `trusted=4` —
    // выбор «частный компьютер» (в форме это radio 0/4).
    const body = new URLSearchParams(hidden);
    body.set('username', this.credentials.user);
    body.set('password', this.credentials.pass);
    body.set('trusted', '4');

    // action в этой сборке OWA — абсолютный путь от корня хоста
    // (`/CookieAuth.dll?Logon`), а не относительно /owa/.
    const authUrl = /^https?:/i.test(action)
      ? action
      : `${OWA_ORIGIN}${action.startsWith('/') ? action : `/${action}`}`;
    debug('login: POST', { url: authUrl, fields: Object.keys(hidden) });

    const res = await this.rawPost(authUrl.toString(), body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
      Referer: LOGIN_PAGE,
    });

    const lower = res.body.toLowerCase();
    if (res.status === 403 || lower.includes('network access message') || lower.includes('error code 403')) {
      throw new MailUnreachableError();
    }
    if (res.status === 401) {
      throw new MailAuthError('OWA отклонил вход (401).');
    }
    // Возврат на форму входа = неверный логин/пароль.
    if (lower.includes('name="password"') && (lower.includes('logon') || lower.includes('auth.owa'))) {
      throw new MailAuthError('Не удалось войти в почту, проверьте логин БАРС.');
    }
    if (!this.hasSessionCookie()) {
      // Ни ошибки, ни cookie — неожиданный ответ; считаем отказом входа.
      throw new MailAuthError('OWA не выдал сессию после входа.');
    }

    this.sessionReady = true;
    debug('login: ok', { canary: Boolean(this.owaCanary()) });
  }

  /** Число писем в INBOX. */
  async getInboxStatus(): Promise<OwaInboxStatus> {
    await this.ensureSession();
    const json = await this.serviceRequest('GetFolder', {
      __type: 'GetFolderJsonRequest',
      Header: OWA_HEADER,
      FolderShape: {
        __type: 'FolderResponseShape',
        BaseShape: 'Default',
        AdditionalProperties: [
          { __type: 'PropertyUri', FieldURI: 'folder:UnreadCount' },
          { __type: 'PropertyUri', FieldURI: 'folder:TotalCount' },
        ],
      },
      FolderIds: [{ __type: 'DistinguishedFolderId', Id: 'inbox' }],
    });

    const folders = firstArray(json, 'Folders');
    const inbox = folders[0] ?? {};
    return {
      total: num(inbox.TotalCount) ?? 0,
      unread: num(inbox.UnreadCount) ?? 0,
    };
  }

  /**
   * Краткие карточки писем (без тел). `onlyUnread` — фильтр на клиенте: OWA
   * FindItem умеет Restriction, но для превью и нотификатора достаточно взять
   * последние `limit` и отфильтровать прочитанные на месте.
   */
  async fetchMessageBriefs(options: { limit: number; onlyUnread?: boolean }): Promise<OsepMessageBrief[]> {
    await this.ensureSession();

    const json = await this.serviceRequest('FindItem', {
      __type: 'FindItemJsonRequest',
      Header: OWA_HEADER,
      ItemShape: {
        __type: 'ItemResponseShape',
        BaseShape: 'IdOnly',
        AdditionalProperties: [
          { __type: 'PropertyUri', FieldURI: 'item:Subject' },
          { __type: 'PropertyUri', FieldURI: 'item:DateTimeReceived' },
          { __type: 'PropertyUri', FieldURI: 'item:From' },
          { __type: 'PropertyUri', FieldURI: 'item:HasAttachments' },
          { __type: 'PropertyUri', FieldURI: 'item:IsRead' },
        ],
      },
      ParentFolderIds: [{ __type: 'DistinguishedFolderId', Id: 'inbox' }],
      Traversal: 'Shallow',
      Paging: {
        __type: 'IndexedPageView',
        BasePoint: 'Beginning',
        Offset: 0,
        MaxEntriesReturned: options.limit,
      },
      SortOrder: [
        {
          __type: 'FieldOrder',
          Order: 'Descending',
          FieldURI: { __type: 'FieldURI', FieldURI: 'item:DateTimeReceived' },
        },
      ],
    });

    const items = firstArray(json, 'Items');
    const briefs: OsepMessageBrief[] = items.map((item) => mapItem(item));

    if (options.onlyUnread) return briefs.filter((b) => !b.isSeen);
    return briefs;
  }

  // ── низкоуровневое ────────────────────────────────────────────────────────

  /** POST к service.svc с обязательным X-OWA-CANARY. */
  private async serviceRequest(action: string, payload: unknown): Promise<unknown> {
    const url = `${OWA_BASE}/service.svc?action=${action}&AC=1`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json; charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: LOGIN_PAGE,
    };

    // Обязательный заголовок после входа: без X-OWA-CANARY OWA отвечает 401.
    const canary = this.owaCanary();
    if (canary) headers['X-OWA-CANARY'] = canary;

    let res = await this.rawPost(url, JSON.stringify(payload), headers);

    // 401 — сессия истекла: один прозрачный перелогин и повтор.
    if (res.status === 401) {
      debug('service: 401, re-login', { action });
      this.sessionReady = false;
      this.jar = new CookieJar();
      await this.login();
      res = await this.rawPost(url, JSON.stringify(payload), headers);
    }

    if (res.status === 403) throw new MailUnreachableError();
    if (res.status === 401) throw new MailAuthError('Сессия OWA истекла.');

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // Вместо JSON вернулась HTML-страница входа.
      throw new MailAuthError('OWA вернул страницу входа вместо данных.');
    }

    return parsed;
  }

  private async rawGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    debug('GET', { url });
    const res = await this.send(() => this.client.get(url, { headers }));
    debug('GET <-', { url, status: res.status, len: res.body.length });
    return res;
  }

  private async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const res = await this.send(() => this.client.post(url, body, { headers }));
    return res;
  }

  private async send(
    run: () => Promise<{ status: number; data: unknown }>,
  ): Promise<{ status: number; body: string }> {
    try {
      const res = await run();
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // Forefront TMG отдаёт свою страницу вместо OWA: 403 либо 401 с Basic и
      // текстом «The page cannot be displayed»/`/Wbo-`. Это «нет сети МЭИ», а не
      // неверный пароль — иначе пользователь получил бы неверный совет.
      if (
        res.status === 403 ||
        /network access message|the page cannot be displayed|\/Wbo-|error code 403/i.test(body)
      ) {
        throw new MailUnreachableError();
      }

      return { status: res.status, body };
    } catch (err: unknown) {
      if (err instanceof MailUnreachableError) throw err;
      const code = (err as { code?: string }).code;
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') throw new MailTimeoutError();
      if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
        throw new MailUnreachableError();
      }
      // Самоподписанный/непроверяемый сертификат тоже означает «сеть МЭИ».
      if (/certificate|self.signed|unable to verify/i.test((err as Error)?.message ?? '')) {
        throw new MailUnreachableError('Сертификат почтового сервера не проверен. Нужен VPN МЭИ.');
      }
      throw err;
    }
  }

  /** Значение cookie X-OWA-CANARY — обязательный заголовок после входа. */
  private owaCanary(): string | undefined {
    for (const c of this.cookies()) {
      if (/canary/i.test(c.key)) return decodeURIComponent(c.value);
    }
    return undefined;
  }

  private hasSessionCookie(): boolean {
    return this.cookies().some((c) => /cadata|sessionid|canary|auth/i.test(c.key));
  }
}

/**
 * Достаёт первый массив из вложенного ответа OWA.
 *
 * Ответ FindItem/GetFolder: `{ Body: { ResponseMessages: { Items: [ { RootFolder | Folders: [...] } ] } } }`.
 * Идём по наиболее вероятным путям, не привязываясь к точной обёртке версии.
 */
function firstArray(root: unknown, key: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 8 || out.length > 0) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj[key])) {
      out.push(...(obj[key] as Array<Record<string, unknown>>));
      return;
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };

  visit(root, 0);
  return out;
}

/** Разбор одного OWA-элемента в brief. */
function mapItem(item: Record<string, unknown>): OsepMessageBrief {
  const date = parseOwaDate(item.DateTimeReceived);
  const from = extractFrom(item.From);
  const subject = typeof item.Subject === 'string' ? item.Subject.trim() : '';

  return {
    // OWA ItemId сессионный (меняется при перелогине), поэтому как стабильный
    // ключ для диффа «новых писем» берём время получения в миллисекундах.
    uid: date.getTime(),
    date,
    from: from || 'Неизвестный отправитель',
    subject: subject || '(Без темы)',
    hasAttachments: item.HasAttachments === true,
    isSeen: item.IsRead === true,
  };
}

function extractFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const mailbox = (value as Record<string, unknown>).Mailbox;
  if (!mailbox || typeof mailbox !== 'object') return '';
  const m = mailbox as Record<string, unknown>;
  const name = typeof m.Name === 'string' ? m.Name.trim() : '';
  const address = typeof m.EmailAddress === 'string' ? m.EmailAddress.trim() : '';
  return name || address;
}

function parseOwaDate(value: unknown): Date {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Восстанавливает CookieJar из строки, сохранённой `serializeCookies()`. */
function loadJar(cookiesJson: string): CookieJar {
  try {
    return CookieJar.fromJSON(JSON.parse(cookiesJson));
  } catch {
    return new CookieJar();
  }
}
