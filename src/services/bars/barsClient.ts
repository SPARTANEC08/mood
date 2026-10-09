import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Ошибка устаревшей или недействительной сессии БАРС.
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Сессия БАРС истекла или недействительна. Требуется повторная авторизация.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Данные профиля студента, извлеченные из разметки.
 */
export interface StudentInfo {
  studentName: string;
  groupName: string;
  studyCard?: string;
  email?: string;
}

/**
 * Элемент навигационного меню / сайдбара БАРС.
 */
export interface MenuLink {
  section?: string;
  text: string;
  href: string;
}

/**
 * Формат файла сохраненной сессии .bars-session-debug.json.
 */
export interface SavedSessionData {
  savedAt?: string;
  fio?: string;
  group?: string;
  studyCard?: string;
  finalUrl?: string;
  cookies?: unknown;
}

const DEFAULT_BASE_URL = 'https://bars.mpei.ru';

const DEFAULT_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Базовый HTTP-клиент для работы с личным кабинетом БАРС МЭИ.
 */
export class BarsClient {
  private client: AxiosInstance;
  private jar: CookieJar;
  private savedSession: SavedSessionData | null = null;
  public readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.jar = new CookieJar();
    this.client = this.createAxiosInstance(this.jar);
  }

  private createAxiosInstance(jar: CookieJar): AxiosInstance {
    return wrapper(
      axios.create({
        jar,
        proxy: false,
        maxRedirects: 10,
        timeout: 30_000,
        headers: DEFAULT_BROWSER_HEADERS,
        validateStatus: (s) => s >= 200 && s < 400,
      }),
    );
  }

  /**
   * Считывает JSON-файл сессии и восстанавливает куки в jar.
   * Выбрасывает читаемую ошибку, если файл не найден.
   */
  public async loadSavedSession(filePath: string = '.bars-session-debug.json'): Promise<SavedSessionData> {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

    let rawData: string;
    try {
      rawData = await fs.readFile(fullPath, 'utf-8');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        throw new Error('Сессия не найдена. Сначала запустите авторизацию');
      }
      throw new Error(`Ошибка чтения файла сессии ${fullPath}: ${(err as Error).message}`);
    }

    let parsed: SavedSessionData;
    try {
      parsed = JSON.parse(rawData) as SavedSessionData;
    } catch (err) {
      throw new Error(`Файл сессии поврежден (невалидный JSON): ${(err as Error).message}`);
    }

    if (!parsed.cookies) {
      throw new Error('В файле сессии отсутствуют cookies. Требуется повторная авторизация.');
    }

    // Восстанавливаем CookieJar
    const rawCookies = parsed.cookies as Record<string, unknown>;
    if (typeof rawCookies === 'object' && rawCookies !== null && ('cookies' in rawCookies || 'storeType' in rawCookies)) {
      // Формат tough-cookie toJSON()
      this.jar = CookieJar.fromJSON(rawCookies as never);
    } else if (Array.isArray(parsed.cookies)) {
      // Формат массива объектов кук
      this.jar = new CookieJar();
      for (const c of parsed.cookies as Array<{ key?: string; name?: string; value?: string; domain?: string; path?: string }>) {
        const k = c.key || c.name;
        if (k && c.value !== undefined) {
          const cookieStr = `${k}=${c.value}; Domain=${c.domain || 'bars.mpei.ru'}; Path=${c.path || '/'}`;
          await this.jar.setCookie(cookieStr, this.baseUrl);
        }
      }
    } else {
      throw new Error('Неизвестный формат cookies в файле сессии.');
    }

    this.client = this.createAxiosInstance(this.jar);
    this.savedSession = parsed;
    return parsed;
  }

  /**
   * Возвращает внутренний инстанс AxiosInstance для выполнения низкоуровневых HTTP-запросов.
   */
  public getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  /**
   * Устанавливает сохраненную сессию в памяти клиента.
   */
  public setSavedSession(session: SavedSessionData): void {
    this.savedSession = session;
  }

  /**
   * Проверяет, валидна ли текущая сессия (делает тестовый запрос к дашборду).
   */
  public async isSessionValid(): Promise<boolean> {
    if (!this.savedSession) {
      try {
        await this.loadSavedSession();
      } catch {
        return false;
      }
    }
    try {
      const targetUrl = this.savedSession?.finalUrl || '/bars_web/ST_Study/Main/Main';
      await this.getHtml(targetUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Выполняет полный вход в систему БАРС МЭИ через BarsAuth.
   */
  public async login(options: import('./barsAuth.js').LoginOptions): Promise<import('./barsAuth.js').LoginResult> {
    const { BarsAuth } = await import('./barsAuth.js');
    return BarsAuth.login(this, options);
  }

  /**
   * Возвращает кэшированные метаданные сохраненной сессии (ФИО, группа и т.д.).
   */
  public getSavedSession(): SavedSessionData | null {
    return this.savedSession;
  }

  /**
   * Возвращает текущий экземпляр CookieJar.
   */
  public getJar(): CookieJar {
    return this.jar;
  }

  /**
   * Преобразует относительный или абсолютный путь в полный URL.
   */
  private resolveUrl(urlPath: string): string {
    if (/^https?:\/\//i.test(urlPath)) {
      return urlPath;
    }
    const cleanPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  /**
   * Выполняет GET-запрос по указанному пути и возвращает CheerioAPI.
   * Автоматически проверяет, не выбило ли сессию (редирект на страницу входа/SSO).
   */
  public async getHtml(urlPath: string, config?: AxiosRequestConfig): Promise<cheerio.CheerioAPI> {
    const targetUrl = this.resolveUrl(urlPath);

    const res = await this.client.get(targetUrl, {
      ...config,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        Referer: this.baseUrl,
        ...config?.headers,
      },
    });

    const finalUrl = (res.request?.res?.responseUrl as string | undefined) || res.config.url || targetUrl;
    const html = typeof res.data === 'string' ? res.data : String(res.data);
    const $ = cheerio.load(html);

    this.assertSessionAlive(finalUrl, $);

    return $;
  }

  /**
   * Выполняет GET-запрос с заголовком X-Requested-With: XMLHttpRequest для внутренних AJAX-эндпоинтов.
   */
  public async getJson<T>(urlPath: string, config?: AxiosRequestConfig): Promise<T> {
    const targetUrl = this.resolveUrl(urlPath);

    const res = await this.client.get(targetUrl, {
      ...config,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: this.baseUrl,
        ...config?.headers,
      },
    });

    // Если сервер вместо JSON отдал HTML страницы авторизации (стандартное поведение ASP.NET при 302 на логин)
    if (typeof res.data === 'string' && (res.data.includes('<html') || res.data.includes('__RequestVerificationToken'))) {
      const finalUrl = (res.request?.res?.responseUrl as string | undefined) || targetUrl;
      const $ = cheerio.load(res.data);
      this.assertSessionAlive(finalUrl, $);
    }

    return res.data as T;
  }

  /**
   * Проверяет, что полученная страница не является экраном логина или повторной аутентификации.
   */
  private assertSessionAlive(finalUrl: string, $: cheerio.CheerioAPI): void {
    const u = finalUrl.toLowerCase();
    const title = $('title').text().toLowerCase().trim();

    // 1. Признаки страницы входа по URL
    const isLoginUrl =
      u.includes('/auth/login') ||
      u.includes('/account/login') ||
      u.includes('returnurl=') ||
      u.includes('/auth/logincode');

    // 2. Признаки по разметке и полям ввода
    const hasLoginForm = $('input[name="Password"], input#Password').length > 0;
    const has2faForm = $('input[name="AF2_Code"], input#AF2_Code').length > 0;

    // 3. Заголовки страниц авторизации
    const isLoginTitle =
      title.includes('авторизация') ||
      title.includes('вход в систему') ||
      title === 'вход' ||
      (title === 'барс' && hasLoginForm);

    if (isLoginUrl || hasLoginForm || has2faForm || isLoginTitle) {
      throw new SessionExpiredError(
        `Сессия БАРС истекла или недействительна (произошел возврат на страницу авторизации: ${finalUrl}).`,
      );
    }
  }

  /**
   * Извлекает информацию о студенте из страницы дашборда БАРС.
   */
  public extractStudentInfo($: cheerio.CheerioAPI): StudentInfo {
    // 1. ФИО из активного элемента хлебных крошек
    let studentName = $('ol.breadcrumb li.breadcrumb-item.active').text().replace(/\s+/g, ' ').trim();

    let studyCard = '';
    // Из блока: Лысенко Николай Романович (№ЗК - 1020260185)
    const boldHeader = $('span.fw-bold').first().text().trim();
    const zkMatch = boldHeader.match(/^([^(]+?)(?:\s*\(№ЗК\s*-\s*([^)]+)\))?$/);
    if (zkMatch) {
      if (!studentName && zkMatch[1]?.trim()) {
        studentName = zkMatch[1].trim();
      }
      if (zkMatch[2]?.trim()) {
        studyCard = zkMatch[2].trim();
      }
    }

    // Резервный поиск из заголовка ЛКС
    if (!studentName) {
      const title = $('title').text().trim();
      if (/^ЛКС\s+/i.test(title)) {
        studentName = title.replace(/^ЛКС\s+/i, '').trim();
      }
    }

    if (!studentName) {
      studentName = 'Не удалось извлечь ФИО';
    }

    // 2. Номер академической группы
    let groupName = '';
    const ruzLink = $('a[href*="/Open/RUZ/Timetable"]').attr('href') || '';
    const ruzMatch = ruzLink.match(/name=([^&]+)/);
    if (ruzMatch) {
      try {
        groupName = decodeURIComponent(ruzMatch[1]).trim();
      } catch {
        groupName = ruzMatch[1].trim();
      }
    }

    if (!groupName) {
      $('span.fw-bold').each((_, el) => {
        const text = $(el).text().trim();
        if (/^[А-ЯЁa-zA-Z]{1,5}-\d{2}-\d{2}$/i.test(text)) {
          groupName = text;
          return false;
        }
      });
    }

    if (!groupName) {
      const match = $.html().match(/\b([А-ЯЁ]{1,5}-\d{2}-\d{2})\b/);
      if (match) groupName = match[1];
    }

    if (!groupName) {
      groupName = 'Не удалось извлечь номер группы';
    }

    // 3. Корпоративная почта
    const emailLink = $('a[href^="mailto:"]').first().text().trim();

    return {
      studentName,
      groupName,
      studyCard: studyCard || undefined,
      email: emailLink || undefined,
    };
  }

  /**
   * Извлекает ссылки бокового меню/сайдбара БАРС.
   */
  public extractMenuLinks($: cheerio.CheerioAPI): MenuLink[] {
    const links: MenuLink[] = [];
    const seenHrefs = new Set<string>();

    $('#sidebar-wrapper, .sidebar-nav, .icc-menu').find('a').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      const text = $(el).text().replace(/\s+/g, ' ').trim();

      if (!href || href === '#' || href.startsWith('javascript:')) return;
      if (seenHrefs.has(href)) return;
      seenHrefs.add(href);

      // Проверяем секцию меню (Учёба, Рейтинг, События и т.д.)
      const parentCollapse = $(el).closest('.collapse');
      let section: string | undefined;
      if (parentCollapse.length > 0) {
        const collapseId = parentCollapse.attr('id');
        if (collapseId) {
          const header = $(`a[data-bs-target="#${collapseId}"]`).text().trim();
          if (header) section = header;
        }
      }

      links.push({
        section,
        text,
        href: this.resolveUrl(href),
      });
    });

    return links;
  }
}
