import { type AxiosInstance, type AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BarsClient, type SavedSessionData, type StudentInfo } from './barsClient.js';

export interface Af2SendInfo {
  buttonId: string;
  sendUrl: string;
  tid: string;
  codeLength: number;
  channelHint: string;
}

export interface JsonSendAf2Response {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export interface LoginOptions {
  username: string;
  password: string;
  on2FACodeNeeded: (info: { codeLength: number; channelHint?: string }) => Promise<string>;
  saveSessionPath?: string;
  onStep?: (message: string) => void;
}

export interface LoginResult {
  success: boolean;
  studentInfo: StudentInfo;
  finalUrl: string;
  sessionData: SavedSessionData;
}

function resolveFinalUrl(res: AxiosResponse, fallback: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viaNode = (res.request as any)?.res?.responseUrl as string | undefined;
  return viaNode ?? res.config.url ?? fallback;
}

function responseText(res: AxiosResponse): string {
  if (typeof res.data === 'string') return res.data;
  return String(res.data ?? '');
}

function getFormError($: cheerio.CheerioAPI): string {
  return $('.alert-danger, .validation-summary-errors, .field-validation-error')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAf2SendInfo(html: string, pageUrl: string, $: cheerio.CheerioAPI): Af2SendInfo | null {
  const re =
    /af2_code_send\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/;
  const m = re.exec(html);
  if (!m) return null;

  const [, buttonId, relUrl, tid, lenRaw] = m;
  const channelHint =
    $(`#${buttonId}`).text().replace(/\s+/g, ' ').trim() ||
    $('#btnSend').text().replace(/\s+/g, ' ').trim();

  return {
    buttonId,
    sendUrl: new URL(relUrl, pageUrl).href,
    tid,
    codeLength: Number.parseInt(lenRaw, 10) || 4,
    channelHint,
  };
}

function isLoginCodePage($: cheerio.CheerioAPI, finalUrl: string): boolean {
  if ($('input[name="AF2_Code"], input#AF2_Code').length > 0) return true;
  const action = ($('form').first().attr('action') ?? '').toLowerCase();
  if (action.includes('logincode')) return true;
  if (finalUrl.toLowerCase().includes('logincode')) return true;
  return false;
}

function isDashboardPage(finalUrl: string, $: cheerio.CheerioAPI): boolean {
  if ($('input[name="Password"], input[name="AF2_Code"], input#AF2_Code').length > 0) return false;
  if ($('a[href*="/Auth/Exit" i], a[href*="LogOff" i], a[href*="logout" i]').length > 0) return true;

  const u = finalUrl.toLowerCase();
  if (u.includes('/st_study/') || u.includes('studentid=')) return true;

  const title = $('title').text().toLowerCase();
  if (title.startsWith('лкс') || title.includes('личный кабинет')) return true;
  if ($('ol.breadcrumb, #div-FormHeader, h4:contains("Оценки в БАРС")').length > 0) return true;

  return false;
}

const MENU_TITLES = new Set([
  'главная',
  'учёба',
  'учеба',
  'рейтинг',
  'события',
  'стипендия',
  'пропуски',
  'приказы',
  'почта',
  'библиотека',
  'нтб',
  'профиль',
]);

/**
 * Похож ли профиль на студенческий.
 *
 * БАРС пускает и аккаунты без студенческого профиля (например, сотрудника или
 * общего пользователя): после входа такой аккаунт оказывается на `/Auth/Menu`,
 * где вместо ФИО в хлебных крошках стоит «Главная», а группы нет вовсе. Раньше
 * из этого создавалась запись «Главная» с группой «Не удалось извлечь номер
 * группы».
 *
 * Проверка применяется только при СОЗДАНИИ записи: существующего студента
 * внезапно неудачный разбор страницы не должен выкидывать из аккаунта. И она
 * намеренно не бросает исключение внутри BarsAuth — иначе ошибка проверки
 * выглядела бы для человека как «код 2FA не подошёл».
 */
export function looksLikeStudentProfile(info: StudentInfo): boolean {
  if (info.studyCard?.trim()) return true;
  if (/^[А-ЯЁa-zA-Z]{1,5}-\d{2}-\d{2}$/i.test(info.groupName.trim())) return true;

  const name = info.studentName.trim();
  if (!name) return false;
  if (/^не удалось извлечь/i.test(name)) return false;
  // «Главная», «Учёба», «Рейтинг» — это разделы меню, а не имя человека.
  if (MENU_TITLES.has(name.toLowerCase())) return false;
  // У ФИО в БАРС всегда есть фамилия и имя, а у пункта меню — одно слово.
  return name.split(/\s+/).length >= 2;
}

/** Студенческий дашборд: известный адрес, не зависит от того, куда редиректнуло. */
const STUDENT_DASHBOARD_URL = '/bars_web/ST_Study/Main/Main';

/** Где ещё БАРС может показать studentID, если стартовая страница — меню. */
const STUDENT_ID_LOOKUP_PATHS = [
  // «Актуализировать права» из меню: обновляет права сессии и у студента
  // редиректит сразу на дашборд с studentID. Помогает новым аккаунтам, у
  // которых права ещё не подхватились и `/bars_web/` показывает только меню.
  '/bars_web/Service/RefreshPermissions',
  '/bars_web/',
  '/',
  // «Студенты → Список студентов»: ссылка есть в меню даже когда `/bars_web/`
  // открывает «Выбор действия». В таблице — ссылка на карточку с studentID.
  '/bars_web/ST/Student/ListStudent',
  // Прямой раздел «Учёба»: у части аккаунтов редиректит сразу на дашборд.
  '/bars_web/ST_Study',
];

export interface StudentCandidate {
  studentId: string;
  name: string;
  recordBook: string;
  status: string;
  group: string;
}

interface StudentIdProbe {
  path: string;
  studentId: string | null;
  candidates: number;
  choice?: string;
  details?: StudentCandidate[];
  title: string;
  error?: string;
}

interface StudentIdSearch {
  studentId: string | null;
  probes: StudentIdProbe[];
}

export interface StudentSelection {
  studentId: string | null;
  count: number;
  choice: string;
  details: StudentCandidate[];
}

/** Текст без неразрывных пробелов и лишних отступов. */
function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбирает таблицу «Студенты → Список студентов».
 *
 * Таблица содержит все записи, доступные учётной записи: у обычного студента
 * это он сам, у человека с перепоступлением — две строки (например, активная
 * и отчисленная), у сотрудника — список чужих студентов.
 */
export function parseStudentCandidates($: cheerio.CheerioAPI): StudentCandidate[] {
  let table = $('#tbl__PartialListStudent').first();
  if (!table.length) {
    table = $('table')
      .filter((_, el) => /зачётная книжка|зачетная книжка|статус \(на сегодня\)/i.test($(el).find('thead').text()))
      .first();
  }
  if (!table.length) return [];

  // Колонки ищем по заголовкам: порядок в разных версиях БАРС может отличаться.
  const columns = new Map<'name' | 'recordBook' | 'status' | 'group', number>();
  table
    .find('thead tr')
    .first()
    .find('th')
    .each((index, el) => {
      const header = cleanText($(el).text()).toLowerCase();
      if (header.includes('фио')) columns.set('name', index);
      else if (header.includes('зачёт') || header.includes('зачет')) columns.set('recordBook', index);
      else if (header.includes('статус')) columns.set('status', index);
      else if (header.includes('группа')) columns.set('group', index);
    });

  const candidates: StudentCandidate[] = [];
  const seen = new Set<string>();

  table.find('tbody tr').each((_, row) => {
    const $row = $(row);
    const link = $row.find('a[href*="studentID="]').first();
    const href = link.attr('href') ?? '';
    const idMatch = href.match(/studentID=([a-f0-9-]+)/i);
    if (!idMatch?.[1] || seen.has(idMatch[1])) return;
    seen.add(idMatch[1]);

    const cells = $row.find('td');
    const cellAt = (key: 'name' | 'recordBook' | 'status' | 'group', fallback: number): string => {
      const index = columns.get(key);
      return cleanText(cells.eq(index ?? fallback).text());
    };

    candidates.push({
      studentId: idMatch[1],
      name: cleanText(link.text()) || cellAt('name', 0),
      recordBook: cellAt('recordBook', 1),
      status: cellAt('status', 2),
      group: cellAt('group', 3),
    });
  });

  return candidates;
}

/**
 * Выбирает запись студента из списка.
 *
 * Разные ФИО — это чужой список (сотрудник/деканат), его нельзя превращать
 * в первого попавшегося студента. Одинаковые ФИО — записи одного человека
 * (например, активная и отчисленная): берём активную.
 */
export function chooseStudent(candidates: StudentCandidate[]): StudentSelection {
  const details = candidates;
  if (candidates.length === 0) return { studentId: null, count: 0, choice: 'none', details };
  if (candidates.length === 1) {
    return { studentId: candidates[0].studentId, count: 1, choice: 'single', details };
  }

  const names = new Set(
    candidates
      .map((candidate) =>
        candidate.name
          .toLowerCase()
          .replace(/ё/g, 'е')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean),
  );
  if (names.size > 1) {
    return { studentId: null, count: candidates.length, choice: 'multiple_names', details };
  }

  const active = candidates.filter((candidate) => /обучается/i.test(candidate.status));
  if (active.length > 0) {
    return {
      studentId: active[0].studentId,
      count: candidates.length,
      choice: active.length === 1 ? 'active' : 'first_active',
      details,
    };
  }

  return {
    studentId: candidates[0].studentId,
    count: candidates.length,
    choice: 'no_active',
    details,
  };
}

/** Достаёт ровно один studentID из страницы. */
function extractSingleStudentId(html: string): { studentId: string | null; candidates: number } {
  const ids = [
    ...new Set([...html.matchAll(/studentID=([a-f0-9-]+)/gi)].map((m) => m[1])),
  ];
  return { studentId: ids.length === 1 ? ids[0] : null, candidates: ids.length };
}

/** Ищет студента на странице: сначала таблицу записей, потом одну ссылку. */
function selectStudentFromPage($: cheerio.CheerioAPI): StudentSelection {
  const fromList = chooseStudent(parseStudentCandidates($));
  if (fromList.count > 0) return fromList;

  const single = extractSingleStudentId($.html());
  return {
    studentId: single.studentId,
    count: single.candidates,
    choice: single.studentId ? 'single_id' : 'none',
    details: [],
  };
}

/**
 * Ищет studentID в разметке.
 *
 * БАРС не отдаёт дашборд без `?studentID=`: на `/ST_Study/Main/Main` без
 * параметра приходит заглушка 591 байт «Отсутствует обязательный параметр».
 * ID обычно есть в ссылках страницы, на которую редиректит вход.
 *
 * Однако у аккаунта с несколькими ролями или с сохранённой «страницей входа»
 * `/bars_web/` и `/` открывают `/Auth/Menu`, где studentID нет вовсе. Поэтому
 * дополнительно проверяем список студентов и раздел «Учёба».
 */
async function findStudentId(client: BarsClient, html: string): Promise<StudentIdSearch> {
  const probes: StudentIdProbe[] = [];

  const direct = selectStudentFromPage(cheerio.load(html));
  if (direct.studentId) return { studentId: direct.studentId, probes };

  for (const path of STUDENT_ID_LOOKUP_PATHS) {
    try {
      const $ = await client.getHtml(path);
      const found = selectStudentFromPage($);
      probes.push({
        path,
        studentId: found.studentId,
        candidates: found.count,
        choice: found.choice,
        details: found.details.slice(0, 10),
        title: $('title').text().trim(),
      });
      if (found.studentId) return { studentId: found.studentId, probes };
    } catch (err: unknown) {
      // Страница недоступна — пробуем следующую.
      probes.push({
        path,
        studentId: null,
        candidates: 0,
        title: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { studentId: null, probes };
}

/**
 * Профиль со страницы входа, а при неудаче — с явно открытого дашборда.
 *
 * Почему это нужно. После 2FA часть аккаунтов попадает не на дашборд, а на
 * главную портала `/Auth/Menu`: в крошках «Главная», группы и ФИО нет. Раньше
 * вход такого студента падал с «аккаунт не похож на студенческий», хотя
 * студенческий раздел открывается тем же cookie.
 *
 * Важно: дашборд открывается только с `?studentID=`. Без него БАРС отдаёт
 * заглушку «Отсутствует обязательный параметр», и профиль снова не находится.
 *
 * Если аккаунт действительно нестуденческий, studentID не найдётся — решение
 * не меняется, и login.ts по-прежнему отклонит создание записи.
 */
async function extractStudentInfoWithFallback(
  client: BarsClient,
  $: cheerio.CheerioAPI,
  finalUrl: string,
): Promise<{ studentInfo: StudentInfo; finalUrl: string }> {
  const studentInfo = client.extractStudentInfo($);
  if (looksLikeStudentProfile(studentInfo)) return { studentInfo, finalUrl };

  const search = await findStudentId(client, $.html());

  if (search.studentId) {
    const dashboardUrl = `${STUDENT_DASHBOARD_URL}?studentID=${search.studentId}`;
    try {
      const $dashboard = await client.getHtml(dashboardUrl);
      const fromDashboard = client.extractStudentInfo($dashboard);

      if (looksLikeStudentProfile(fromDashboard)) {
        return { studentInfo: fromDashboard, finalUrl: dashboardUrl };
      }
    } catch {
      // Дашборд не открылся — оставляем исходный результат.
    }
  }

  console.warn(
    '[Auth] профиль не распознан и на дашборде:',
    JSON.stringify({
      finalUrl,
      studentId: search.studentId ?? null,
      title: $('title').text().trim(),
      probes: search.probes,
    }),
  );

  return { studentInfo, finalUrl };
}

/**
 * Сервис полной авторизации в БАРС МЭИ (логин + пароль + 2FA).
 */
export class BarsAuth {
  /**
   * Выполняет полный цикл авторизации в БАРС МЭИ.
   */
  public static async login(client: BarsClient, options: LoginOptions): Promise<LoginResult> {
    const { username, password, on2FACodeNeeded, onStep } = options;
    const savePath = options.saveSessionPath || path.join(process.cwd(), '.bars-session-debug.json');
    const step = (msg: string) => onStep?.(msg);

    /**
     * Файл сессии содержит валидные cookie, поэтому права закрываются явно (0600),
     * а для временных файлов ещё и O_EXCL — без этого сессию читает любой
     * локальный пользователь из общего /tmp.
     */
    const saveSession = async (data: SavedSessionData): Promise<void> => {
      await fs.writeFile(savePath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      }).catch(async (err: unknown) => {
        // 'wx' падает, если файл уже есть — перезаписываем с теми же правами.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') throw err;
        await fs.writeFile(savePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      });
    };

    const axiosInst: AxiosInstance = client.getAxiosInstance();
    const startUrl = `${client.baseUrl}/bars_web/`;

    // 1. Стартовая страница
    step(`[1/5] Подключение к стартовой странице ${startUrl}...`);
    const getRes = await axiosInst.get(startUrl);
    const getFinalUrl = resolveFinalUrl(getRes, startUrl);
    const $get = cheerio.load(responseText(getRes));

    // Проверяем, возможно уже авторизованы
    if (isDashboardPage(getFinalUrl, $get)) {
      const extracted = await extractStudentInfoWithFallback(client, $get, getFinalUrl);
      const studentInfo = extracted.studentInfo;
      const sessionData: SavedSessionData = {
        savedAt: new Date().toISOString(),
        fio: studentInfo.studentName,
        group: studentInfo.groupName,
        studyCard: studentInfo.studyCard,
        finalUrl: extracted.finalUrl,
        cookies: client.getJar().toJSON(),
      };
      await saveSession(sessionData);
      client.setSavedSession(sessionData);
      return { success: true, studentInfo, finalUrl: extracted.finalUrl, sessionData };
    }

    const loginForm = $get('form').first();
    if (!loginForm.length) {
      throw new Error('Форма входа не найдена на стартовой странице БАРС.');
    }

    const rawAction = loginForm.attr('action') ?? '';
    const loginPostUrl = rawAction ? new URL(rawAction, getFinalUrl).href : getFinalUrl;

    const loginHidden: Record<string, string> = {};
    loginForm.find('input[type="hidden"]').each((_, el) => {
      const name = $get(el).attr('name');
      if (name) loginHidden[name] = $get(el).attr('value') ?? '';
    });

    if (!('__RequestVerificationToken' in loginHidden)) {
      throw new Error('В форме входа отсутствует CSRF-токен (__RequestVerificationToken).');
    }

    // 2. Отправка логина и пароля
    step('[2/5] Отправка логина и пароля...');
    const loginBody = new URLSearchParams();
    for (const [k, v] of Object.entries(loginHidden)) loginBody.append(k, v);
    loginBody.set('Account', username);
    loginBody.set('Password', password);
    if (!loginBody.has('RememberMe')) loginBody.set('RememberMe', 'false');

    const postRes = await axiosInst.post(loginPostUrl, loginBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: getFinalUrl,
        Origin: new URL(getFinalUrl).origin,
      },
    });

    const postFinalUrl = resolveFinalUrl(postRes, loginPostUrl);
    const postHtml = responseText(postRes);
    const $post = cheerio.load(postHtml);

    const loginError = getFormError($post);
    const backOnLoginForm = $post('input[name="Password"]').length > 0;
    if (loginError || backOnLoginForm) {
      throw new Error(`Неверный логин или пароль.${loginError ? ` БАРС: ${loginError}` : ''}`);
    }

    // Если авторизовались без 2FA
    const is2fa = isLoginCodePage($post, postFinalUrl);
    if (!is2fa && isDashboardPage(postFinalUrl, $post)) {
      step('Авторизация выполнена успешно (без 2FA).');
      const extracted = await extractStudentInfoWithFallback(client, $post, postFinalUrl);
      const studentInfo = extracted.studentInfo;
      const sessionData: SavedSessionData = {
        savedAt: new Date().toISOString(),
        fio: studentInfo.studentName,
        group: studentInfo.groupName,
        studyCard: studentInfo.studyCard,
        finalUrl: extracted.finalUrl,
        cookies: client.getJar().toJSON(),
      };
      await saveSession(sessionData);
      client.setSavedSession(sessionData);
      return { success: true, studentInfo, finalUrl: extracted.finalUrl, sessionData };
    }

    if (!is2fa) {
      throw new Error(`Неожиданный ответ после входа: "${$post('title').text().trim()}". URL: ${postFinalUrl}`);
    }

    // 3. 2FA: парсинг и запрос отправки кода
    step('[3/5] Обнаружена двухфакторная аутентификация (2FA)...');
    const af2 = parseAf2SendInfo(postHtml, postFinalUrl, $post);
    if (!af2) {
      throw new Error('Не удалось извлечь параметры отправки кода 2FA (af2_code_send).');
    }

    step(`[3a/5] Запрос генерации кода (канал: "${af2.channelHint || 'по умолчанию'}")...`);
    const sendUrl = `${af2.sendUrl}?tid=${encodeURIComponent(af2.tid)}&_=${Date.now()}`;
    const sendRes = await axiosInst.get(sendUrl, {
      headers: {
        Referer: postFinalUrl,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });

    let sendJson: JsonSendAf2Response | null = null;
    try {
      sendJson = typeof sendRes.data === 'string' ? JSON.parse(sendRes.data) : (sendRes.data as JsonSendAf2Response);
    } catch {
      sendJson = null;
    }

    if (!sendJson || sendJson.success !== true) {
      const reason =
        (sendJson?.error as string | undefined) ??
        (sendJson?.message as string | undefined) ??
        'сервер не подтвердил отправку кода';
      throw new Error(`Ошибка отправки кода 2FA: "${reason}". Возможно, действует ограничение по частоте запросов.`);
    }

    // 4. Ожидание ввода кода от пользователя
    step(`[4/5] Ожидание ввода кода подтверждения (${af2.codeLength} цифр)...`);
    const code = (await on2FACodeNeeded({ codeLength: af2.codeLength, channelHint: af2.channelHint })).trim();
    if (!code) {
      throw new Error('Код подтверждения не был введен.');
    }

    // 5. Отправка кода подтверждения
    step('[5/5] Проверка кода подтверждения...');
    const verifyForm = $post('form').first();
    const verifyRawAction = verifyForm.attr('action') ?? '';
    const verifyUrl = verifyRawAction ? new URL(verifyRawAction, postFinalUrl).href : postFinalUrl;

    const verifyBody = new URLSearchParams();
    verifyForm.find('input').each((_, el) => {
      const name = $post(el).attr('name');
      if (!name || name === 'AF2_Code') return;
      verifyBody.set(name, $post(el).attr('value') ?? '');
    });
    if (!verifyBody.get('Account')) verifyBody.set('Account', username);
    verifyBody.set('AF2_Code', code);

    const verifyRes = await axiosInst.post(verifyUrl, verifyBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: postFinalUrl,
        Origin: new URL(postFinalUrl).origin,
      },
    });

    const verifyFinalUrl = resolveFinalUrl(verifyRes, verifyUrl);
    const verifyHtml = responseText(verifyRes);
    const $verify = cheerio.load(verifyHtml);

    const verifyError = getFormError($verify);
    if (verifyError || isLoginCodePage($verify, verifyFinalUrl)) {
      throw new Error(`Неверный код 2FA.${verifyError ? ` БАРС: ${verifyError}` : ''}`);
    }

    if (!isDashboardPage(verifyFinalUrl, $verify)) {
      throw new Error(`Вход не удался: маркеры личного кабинета не найдены на странице ${verifyFinalUrl}`);
    }

    const extracted = await extractStudentInfoWithFallback(client, $verify, verifyFinalUrl);
    const studentInfo = extracted.studentInfo;
    const sessionData: SavedSessionData = {
      savedAt: new Date().toISOString(),
      fio: studentInfo.studentName,
      group: studentInfo.groupName,
      studyCard: studentInfo.studyCard,
      finalUrl: extracted.finalUrl,
      cookies: client.getJar().toJSON(),
    };

    await saveSession(sessionData);
    client.setSavedSession(sessionData);

    return {
      success: true,
      studentInfo,
      finalUrl: extracted.finalUrl,
      sessionData,
    };
  }
}
