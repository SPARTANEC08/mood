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
 *     Успех: редирект на /owa/ и куки сессии (cadb/data/sessionid).
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
 * Cookie-сессия держится на axios + http-cookie-agent + tough-cookie (в
 * `barsClient.ts` — axios-cookiejar-support; здесь нужен доступ к настройкам
 * TLS для `OWA_TLS_INSECURE`). Сессия OWA хранится ОТДЕЛЬНО от сессии БАРС
 * (`StoredUser.owaAuth`). Для тестов origin подменяется `OWA_BASE_URL`.
 */

import axios, { type AxiosInstance } from 'axios';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

import { MailAuthError, MailTimeoutError, MailUnreachableError } from './mailErrors.ts';
import type { OsepMessageBrief } from './types.js';

const OWA_ORIGIN = 'https://mail.mpei.ru';
const OWA_TIMEOUT_MS = 20_000;
const SNIPPET_LIMIT = 300;

/** Заголовки «как браузер»: OWA отдаёт разные представления отрезанному клиенту. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Ключи, чьи ЗНАЧЕНИЯ нельзя писать в журнал. Имена cookies логировать можно и
 * нужно (по ним видно, выдал ли OWA сессию), поэтому проверка точная, а не по
 * подстроке «cookie».
 */
function isSensitiveKey(key: string): boolean {
  return /^(password|pass|passwd|cookie|cookiesjson|canary|x-owa-canary|authorization|token)$/i.test(key)
    || /password$/i.test(key);
}

/** Диагностический лог OWA. Включается `OWA_DEBUG=1`; секреты редактируются. */
function debug(stage: string, data?: Record<string, unknown>): void {
  if (process.env.OWA_DEBUG !== '1') return;
  const safe = data
    ? Object.fromEntries(
        Object.entries(data).map(([k, v]) => {
          if (isSensitiveKey(k)) return [k, '<redacted>'];
          if (typeof v === 'string' && v.length > SNIPPET_LIMIT) {
            return [k, `${v.slice(0, SNIPPET_LIMIT)}…(${v.length})`];
          }
          return [k, v];
        }),
      )
    : undefined;
  console.log(`[OWA] ${stage}`, safe ? JSON.stringify(safe) : '');
}

/** Логин в журнале: первые два символа, остальное — звёздочки. */
function maskLogin(login: string): string {
  const trimmed = login.trim();
  return trimmed.length <= 2 ? '***' : `${trimmed.slice(0, 2)}***`;
}

/**
 * Сниппет тела для журнала: HTML-теги схлопываются, скрипты вырезаются.
 * Пароль и cookies в тело ответа не попадают, но лишний шум не нужен.
 */
function bodySnippet(body: string): string {
  const text = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…(${body.length})` : text;
}

/** Видимый текст страницы — для эвристик «страница входа/2FA/ошибка». */
function visibleText(body: string): string {
  const $ = cheerio.load(body);
  const text = $('body').text() || $.root().text();
  return text.replace(/\s+/g, ' ').trim();
}

/** Снова отдалась форма входа (пароль + действие CookieAuth/auth.owa). */
function looksLikeLoginPage(body: string): boolean {
  const $ = cheerio.load(body);
  const hasPassword = $('input[type="password"], input[name="password"]').length > 0;
  if (!hasPassword) return false;
  const action = $('form').first().attr('action') ?? '';
  return /logon|auth\.owa|cooki?auth/i.test(action) || action === '';
}

/** На странице входа видно сообщение об ошибке — значит, креды не подошли. */
function looksLikeLoginError(body: string): boolean {
  return /неверн|неправильн|ошибк|не удалось|invalid|incorrect|failed|denied|bad password/i.test(
    visibleText(body),
  );
}

/**
 * Признаки промежуточной страницы 2FA/SSO. Интерактивного входа у нас нет,
 * поэтому такую страницу нужно честно назвать, а не выдавать за неверный пароль.
 */
function looksLikeTwoFactor(body: string, finalUrl?: string): boolean {
  const $ = cheerio.load(body);
  const text = visibleText(body).toLowerCase();

  const hasCodeInput = $('input')
    .toArray()
    .some((el) => {
      const input = $(el);
      const type = (input.attr('type') ?? '').toLowerCase();
      if (type === 'password') return false;
      const marker = [
        input.attr('name'),
        input.attr('id'),
        input.attr('autocomplete'),
        input.attr('placeholder'),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return /(^|[^a-z])(otp|code|passcode|mfa|2fa|verification|security|token)([^a-z]|$)/.test(marker);
    });

  const urlMarker = /adfs|saml|sso|oauth|openid|microsoftonline|login\.live|mfa|2fa/i.test(finalUrl ?? '');
  const textMarker =
    /двухфактор|дополнительн\w*\s+подтвержд|код\s+подтвержд|введите\s+код|two-factor|two-step|verification code|security code|authenticator|one-time/i.test(
      text,
    );

  if (urlMarker) return true;
  if (textMarker && hasCodeInput) return true;
  return textMarker && !looksLikeLoginPage(body);
}

/** Имена cookies из `Set-Cookie` — без значений. */
function setCookieNames(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  return list
    .map((value) => value.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

/** Строковый заголовок ответа (Location и т. п.). */
function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value.map(String).join(', ');
  return typeof value === 'string' ? value : undefined;
}

/** Финальный URL после редиректов — по нему видно уход на SSO/ADFS. */
function finalUrlOf(response: { request?: unknown }): string | undefined {
  const request = response.request as { res?: { responseUrl?: string } } | undefined;
  return request?.res?.responseUrl;
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
  /**
   * Переопределить origin OWA. Нужен мок-серверу в тестах и локальной отладке:
   * `OWA_BASE_URL=http://127.0.0.1:PORT`.
   */
  baseUrl?: string;
}

/**
 * Заголовок JSON-запроса OWA.
 *
 * Суффикс `:#Exchange` обязателен: без него десериализатор OWA не находит тип
 * и отвечает `SerializationException` («deserializer has no knowledge of any
 * type that maps to this name»). Версия — Exchange2010: mail.mpei.ru отдаёт
 * сборку OWA 2010.
 */
const OWA_REQUEST_VERSION = 'Exchange2013';
const OWA_HEADER = {
  __type: 'JsonRequestHeaders:#Exchange',
  RequestServerVersion: OWA_REQUEST_VERSION,
} as const;

export class OwaMailClient {
  private readonly credentials: OwaCredentials;
  private readonly origin: string;
  private readonly base: string;
  private readonly loginPage: string;
  private readonly authUrl: string;
  private jar: CookieJar;
  private client: AxiosInstance;
  /** Флаг «сессию уже проверили/подняли» — чтобы не логиниться на каждый вызов. */
  private sessionReady = false;

  constructor(credentials: OwaCredentials, options: OwaOptions = {}) {
    this.credentials = {
      user: credentials.user.trim().replace(/@mpei\.ru$/i, ''),
      pass: credentials.pass,
    };

    // Origin вынесен в поля, а не в константы модуля: тестам нужен локальный
    // мок-сервер, а модульные константы прочитались бы до подмены окружения.
    this.origin = (options.baseUrl ?? process.env.OWA_BASE_URL ?? OWA_ORIGIN).replace(/\/+$/, '');
    this.base = `${this.origin}/owa`;
    this.loginPage = `${this.base}/`;
    this.authUrl = `${this.base}/auth.owa`;

    this.jar = options.cookiesJson ? loadJar(options.cookiesJson) : new CookieJar();
    this.client = this.createAxiosInstance(
      this.jar,
      options.tlsInsecure ?? process.env.OWA_TLS_INSECURE === '1',
    );
  }

  private createAxiosInstance(jar: CookieJar, insecureTls: boolean): AxiosInstance {
    // Cookie-агенты из http-cookie-agent — тот же механизм, что и внутри
    // axios-cookiejar-support, но с доступом к настройкам TLS. Обёртка
    // (`wrapper`) не подходит: она принудительно подменяет агенты своими и
    // падает, если передан любой другой http(s).Agent.
    const cookies = { jar };

    return axios.create({
      // Без cookie-агента Set-Cookie не сохранялся: сессия OWA не поднималась
      // вовсе, и каждый запрос выглядел как «снова страница входа».
      httpAgent: new HttpCookieAgent({ cookies }),
      // Строгая проверка TLS по умолчанию; внутри сети МЭИ/при самоподписанном
      // сертификате TMG включается OWA_TLS_INSECURE=1 (см. README.md).
      httpsAgent: new HttpsCookieAgent({ cookies, rejectUnauthorized: !insecureTls, keepAlive: true }),
      proxy: false,
      maxRedirects: 10,
      timeout: OWA_TIMEOUT_MS,
      headers: BROWSER_HEADERS,
      // Любой HTTP-статус — это ответ сервера, а не сетевая ошибка. Разбирает
      // статусы наш код: иначе 5xx приходил как AxiosError без тела, и понять,
      // что именно ответил МЭИ, было нельзя.
      validateStatus: (s) => s >= 200 && s < 600,
    });
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

    // Живой сессией считаем только наличие session-cookie (cadata/sessionid/auth).
    // Раньше подходили ЛЮБЫЕ cookies: мусорная пара в jar (например, от прерванной
    // попытки) заставляла пропустить вход, первый же запрос получал 401 и уходил
    // на перелогин — лишний круг и лог «отказ входа» при живом пароле.
    if (this.sessionCookieName()) {
      this.sessionReady = true;
      return;
    }

    await this.login();
  }

  /** Полный вход по форме (FBA). */
  async login(): Promise<void> {
    debug('login: GET', { url: this.loginPage, user: maskLogin(this.credentials.user) });
    const page = await this.rawGet(this.loginPage, { Accept: 'text/html,application/xhtml+xml' });

    const $ = cheerio.load(page.body);
    const form = $('form').first();
    const action = form.attr('action') ?? '';

    const hidden: Record<string, string> = {};
    form.find('input').each((_, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      hidden[name] = $(el).attr('value') ?? '';
    });

    const hiddenNames = Object.keys(hidden);
    const hasForm = form.length > 0;
    const hasPasswordField = form.find('input[type="password"], input[name="password"]').length > 0;
    debug('login: form', {
      hasForm,
      action,
      hasPasswordField,
      hiddenCount: hiddenNames.length,
      hiddenNames,
    });

    // Форма без hidden-полей — это уже не форма OWA: контракт сменился, и
    // отправлять логин/пароль «в пустоту» нельзя. Честно называем причину.
    if (!hasForm || hiddenNames.length === 0) {
      throw new MailAuthError(
        'Форма входа OWA не найдена или изменилась.',
        'broken_form',
      );
    }

    // Тело FBA: сохраняем ВСЕ скрытые поля формы (curl, flags, forcedownlevel,
    // formdir, isUtf8, chpwd, chkBsc) и подставляем логин/пароль. `trusted=4` —
    // выбор «частный компьютер» (в форме это radio 0/4).
    const body = new URLSearchParams(hidden);
    body.set('username', this.credentials.user);
    body.set('password', this.credentials.pass);
    body.set('trusted', '4');

    // action в этой сборке OWA — абсолютный путь от корня хоста
    // (`/CookieAuth.dll?Logon`), а не относительно /owa/.
    const authUrl = !action
      ? this.authUrl
      : /^https?:/i.test(action)
        ? action
        : `${this.origin}${action.startsWith('/') ? action : `/${action}`}`;
    debug('login: POST', { url: authUrl, fields: hiddenNames });

    const res = await this.rawPost(authUrl, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
      Referer: this.loginPage,
    });

    const lower = res.body.toLowerCase();
    const sessionCookie = this.sessionCookieName();
    const loginPage = looksLikeLoginPage(res.body);
    const loginError = loginPage && looksLikeLoginError(res.body);
    const twoFactor = !sessionCookie && looksLikeTwoFactor(res.body, res.finalUrl);

    debug('login: POST result', {
      status: res.status,
      location: headerString(res.headers, 'location'),
      setCookies: setCookieNames(res.headers),
      sessionCookie,
      loginPage,
      loginError,
      twoFactor,
    });

    if (res.status === 403 || lower.includes('network access message') || lower.includes('error code 403')) {
      throw new MailUnreachableError();
    }
    if (res.status === 401) {
      throw new MailAuthError('OWA отклонил вход (401).', 'invalid_credentials');
    }
    if (sessionCookie) {
      this.sessionReady = true;
      debug('login: ok', { canary: Boolean(this.owaCanary()), sessionCookie });
      return;
    }

    // 2FA проверяем раньше формы входа: SSO-страница тоже может содержать
    // поле пароля, и её нельзя выдавать за «неверный пароль».
    if (twoFactor) {
      throw new MailAuthError('OWA требует дополнительное подтверждение (2FA/SSO).', 'two_factor_required');
    }
    if (loginError) {
      throw new MailAuthError('OWA отклонил логин или пароль.', 'invalid_credentials');
    }
    if (loginPage) {
      throw new MailAuthError('OWA снова вернул страницу входа.', 'returned_login_page');
    }

    // Ни ошибки, ни формы, ни cookie — неожиданный ответ сервера.
    throw new MailAuthError('OWA не выдал сессию после входа.', 'no_session_cookie');
  }

  /** Число писем в INBOX. */
  async getInboxStatus(): Promise<OwaInboxStatus> {
    await this.ensureSession();
    // Тело обёрнуто в `Body` с типом запроса — плоско OWA 2010 не разбирает
    // (см. OWA_HEADER про суффикс `:#Exchange`).
    const json = await this.serviceRequest('GetFolder', {
      __type: 'GetFolderJsonRequest:#Exchange',
      Header: OWA_HEADER,
      Body: {
        __type: 'GetFolderRequest:#Exchange',
        FolderShape: {
          __type: 'FolderResponseShape:#Exchange',
          BaseShape: 'Default',
          AdditionalProperties: [
            { __type: 'PropertyUri:#Exchange', FieldURI: 'folder:UnreadCount' },
            { __type: 'PropertyUri:#Exchange', FieldURI: 'folder:TotalCount' },
          ],
        },
        FolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: 'inbox' }],
      },
    });

    const messages = owaResponseMessages(json);
    const folders = messages.length > 0 ? foldersOfMessage(messages[0]) : firstArray(json, 'Folders');
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
      __type: 'FindItemJsonRequest:#Exchange',
      Header: OWA_HEADER,
      Body: {
        __type: 'FindItemRequest:#Exchange',
        ItemShape: {
          __type: 'ItemResponseShape:#Exchange',
          BaseShape: 'IdOnly',
          // Точные FieldURI: `item:From` и `item:IsRead` сервер отвергает
          // («Invalid value … for enum PropertyUriEnum») — у From и IsRead
          // пространство имён `message:`, а не `item:`.
          AdditionalProperties: [
            { __type: 'PropertyUri:#Exchange', FieldURI: 'item:Subject' },
            { __type: 'PropertyUri:#Exchange', FieldURI: 'item:DateTimeReceived' },
            { __type: 'PropertyUri:#Exchange', FieldURI: 'message:From' },
            { __type: 'PropertyUri:#Exchange', FieldURI: 'item:HasAttachments' },
            { __type: 'PropertyUri:#Exchange', FieldURI: 'message:IsRead' },
          ],
        },
        ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: 'inbox' }],
        Traversal: 'Shallow',
        Paging: {
          __type: 'IndexedPageView:#Exchange',
          BasePoint: 'Beginning',
          Offset: 0,
          MaxEntriesReturned: options.limit,
        },
        SortOrder: [
          {
            __type: 'SortResults:#Exchange',
            Order: 'Descending',
            Path: { __type: 'PropertyUri:#Exchange', FieldURI: 'item:DateTimeReceived' },
          },
        ],
      },
    });

    /*
     * Письма лежат в `Body.ResponseMessages.Items[0].RootFolder.Items`.
     *
     * Старый `firstArray(json, 'Items')` брал первый массив с именем `Items` —
     * а это и есть `ResponseMessages.Items`, то есть обёртки ответа, а не
     * письма. В результате превью состояло из одной «пустой» карточки
     * («Неизвестный отправитель», «Без темы»). Разбираем путь явно, с откатом на
     * прежний поиск, если сервер вернул другую форму.
     */
    const messages = owaResponseMessages(json);
    const items: Array<Record<string, unknown>> = [];

    if (messages.length > 0) {
      for (const message of messages) {
        const root = message.RootFolder;
        if (root && typeof root === 'object') {
          items.push(...nestedArray(root as Record<string, unknown>, 'Items'));
        } else {
          items.push(...nestedArray(message, 'Items'));
        }
      }
    } else {
      items.push(...firstArray(json, 'Items'));
    }

    const briefs: OsepMessageBrief[] = items.map((item) => mapItem(item));

    if (options.onlyUnread) return briefs.filter((b) => !b.isSeen);
    return briefs;
  }

  // ── низкоуровневое ────────────────────────────────────────────────────────

  /**
   * Заголовки служебного запроса. Собираются заново на каждую попытку: после
   * перелогина cookie jar другой, и старый canary недействителен.
   */
  private serviceHeaders(action: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json; charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: this.loginPage,
      // OWA 2010 (mail.mpei.ru) требует имя операции в заголовке Action —
      // иначе service.svc отвечает 500 «В запросе отсутствует заголовок Action».
      Action: action,
    };

    // Обязательный заголовок после входа: без X-OWA-CANARY сервер отвечает 449.
    const canary = this.owaCanary();
    if (canary) headers['X-OWA-CANARY'] = canary;
    return headers;
  }

  /** POST к service.svc с обязательным X-OWA-CANARY. */
  private async serviceRequest(action: string, payload: unknown): Promise<unknown> {
    const url = `${this.base}/service.svc?action=${action}&AC=1`;
    const body = JSON.stringify(payload);

    let headers = this.serviceHeaders(action);
    debug('service: request', {
      action,
      attempt: 1,
      canary: headers['X-OWA-CANARY'] !== undefined,
    });
    let res = await this.rawPost(url, body, headers);
    debug('service: response', {
      action,
      attempt: 1,
      status: res.status,
      ...(res.status >= 400 ? { snippet: bodySnippet(res.body) } : {}),
    });

    /*
     * Повтор ровно один. Что за статусы:
     *
     * - 401 — сессия истекла: чистим jar, логинимся заново, повторяем с новым
     *   canary;
     * - 449 (Retry With) — специфика OWA 2010: не хватает `X-OWA-CANARY`, и
     *   сервер присылает его в ответе (Set-Cookie). Если canary мы ещё не
     *   отправляли — просто пересобираем заголовки и повторяем. Если отправляли,
     *   а сервер всё равно недоволен — перелогиниваемся.
     * - 440 (Login Timeout) — то же, что 401 по смыслу.
     *
     * Без этого обработчика 449 приводил к разбору HTML как JSON и ложному
     * «OWA вернул страницу входа» — при полностью успешном входе.
     */
    const authChallenge =
      res.status === 401 || res.status === 440 || res.status === 449;
    if (authChallenge) {
      const sentCanary = headers['X-OWA-CANARY'] !== undefined;
      const mustRelogin = res.status === 401 || res.status === 440 || (res.status === 449 && sentCanary);
      debug('service: auth challenge', {
        action,
        status: res.status,
        sentCanary,
        mustRelogin,
        jarCookies: (this.jar.serializeSync()?.cookies ?? []).map((c) => ({
          key: c.key,
          path: c.path,
          domain: c.domain,
          len: String(c.value ?? '').length,
        })),
      });

      if (mustRelogin) {
        this.sessionReady = false;
        // Чистим ТУ ЖЕ корзину, а не подменяем объект: cookie-агенты держат
        // ссылку на исходный jar, и новый объект они бы не увидели.
        await this.jar.removeAllCookies();
        await this.login();
      } else {
        // 449 без отправленного canary: он уже пришёл в Set-Cookie — повторим.
        this.sessionReady = false;
      }

      // Ключевая деталь: заголовки пересобираются после ответа/входа. Повтор со
      // старым canary гарантированно давал вторую ошибку и ложный «неверный пароль».
      headers = this.serviceHeaders(action);
      debug('service: request', {
        action,
        attempt: 2,
        canary: headers['X-OWA-CANARY'] !== undefined,
      });
      res = await this.rawPost(url, body, headers);
      debug('service: response', {
        action,
        attempt: 2,
        status: res.status,
        ...(res.status >= 400 ? { snippet: bodySnippet(res.body) } : {}),
      });

      if (res.status === 401 || res.status === 440 || res.status === 449) {
        throw new MailAuthError(
          `OWA отклонил служебный запрос (HTTP ${res.status}) после повтора.`,
          'session_expired_after_relogin',
        );
      }
    }

    if (res.status === 403) throw new MailUnreachableError();
    if (res.status >= 500) {
      // Честная серверная ошибка OWA: тело — JSON с FaultMessage.
      throw new Error(`OWA service.svc: HTTP ${res.status}: ${bodySnippet(res.body)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // Вместо JSON вернулась HTML-страница входа.
      throw new MailAuthError(
        'OWA вернул страницу входа вместо данных.',
        'returned_login_page',
      );
    }

    /*
     * JSON с ошибкой — это НЕ данные.
     *
     * Раньше тело `{Body:{ErrorCode:500,...}}` успешно парсилось и уходило
     * наверх как ответ: `getInboxStatus` находил ноль папок и возвращал
     * «0 писем» при полностью нерабочей почте. Теперь такое падение видно и не
     * маскирует отказ.
     */
    const fault = owaFaultMessage(parsed);
    if (fault) {
      throw new Error(`OWA service.svc (${action}): ${fault}`);
    }

    return parsed;
  }

  private async rawGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    debug('GET', { url });
    const res = await this.send(() => this.client.get(url, { headers }));
    debug('GET <-', {
      url,
      status: res.status,
      len: res.body.length,
      location: headerString(res.headers, 'location'),
      setCookies: setCookieNames(res.headers),
    });
    return res;
  }

  private async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    const res = await this.send(() => this.client.post(url, body, { headers }));
    // Тело запроса не логируем: в форме логина там пароль.
    debug('POST <-', {
      url,
      status: res.status,
      location: headerString(res.headers, 'location'),
      setCookies: setCookieNames(res.headers),
      finalUrl: res.finalUrl,
      snippet: bodySnippet(res.body),
    });
    return res;
  }

  private async send(
    run: () => Promise<{ status: number; data: unknown; headers?: unknown; request?: unknown }>,
  ): Promise<RawResponse> {
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

      return {
        status: res.status,
        body,
        headers: (res.headers ?? {}) as Record<string, unknown>,
        finalUrl: finalUrlOf(res),
      };
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

  /**
   * Имя cookie, доказывающей вход. Сам `canary` сюда не входит: он может
   * выдаваться до аутентификации, и тогда страница 2FA выглядела бы успехом.
   */
  private sessionCookieName(): string | undefined {
    return this.cookies().find((c) => /cadata|sessionid|auth/i.test(c.key))?.key;
  }
}

/** Ответ низкоуровневого запроса: тело, статус и заголовки для журнала. */
interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  finalUrl?: string;
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

/**
 * Сообщения ответа `Body.ResponseMessages.Items` — обёртки операций
 * (`GetFolder`/`FindItem`), внутри которых лежат уже сами данные.
 */
function owaResponseMessages(root: unknown): Array<Record<string, unknown>> {
  if (!root || typeof root !== 'object') return [];

  const body = (root as Record<string, unknown>).Body;
  if (!body || typeof body !== 'object') return [];

  const responseMessages = (body as Record<string, unknown>).ResponseMessages;
  if (!responseMessages || typeof responseMessages !== 'object') return [];

  return nestedArray(responseMessages as Record<string, unknown>, 'Items');
}

/** Массив из поля объекта (если оно действительно массив). */
function nestedArray(obj: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = obj[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * Папки из ответа GetFolder. Сервер МЭИ кладёт `Folders` прямо в сообщение
 * ответа; на всякий случай поддерживаем и вложенный `RootFolder.Folders`.
 */
function foldersOfMessage(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = nestedArray(message, 'Folders');
  if (direct.length > 0) return direct;

  const root = message.RootFolder;
  if (root && typeof root === 'object') {
    return nestedArray(root as Record<string, unknown>, 'Folders');
  }
  return [];
}

/**
 * Ищет ошибку внутри JSON-ответа OWA.
 *
 * У service.svc два вида отказа: Body-фолт (`ErrorCode`/`FaultMessage`) и
 * ошибки в `ResponseMessages.Items` (`ResponseClass: 'Error'`). Оба обязаны
 * всплывать наверх — иначе нулевые счётчики выглядели бы как пустой ящик.
 */
function owaFaultMessage(root: unknown): string | null {
  if (!root || typeof root !== 'object') return null;

  const body = (root as Record<string, unknown>).Body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const code = typeof b.ErrorCode === 'number' ? b.ErrorCode : 0;
    if (code >= 400) {
      const fault = typeof b.FaultMessage === 'string' ? b.FaultMessage : 'FaultException';
      return `HTTP ${code}: ${fault}`;
    }
  }

  for (const item of firstArray(root, 'Items')) {
    if (item.ResponseClass === 'Error') {
      const text = typeof item.MessageText === 'string' ? item.MessageText : 'Error';
      return text;
    }
  }

  return null;
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
