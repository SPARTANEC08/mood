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

    const axiosInst: AxiosInstance = client.getAxiosInstance();
    const startUrl = `${client.baseUrl}/bars_web/`;

    // 1. Стартовая страница
    step(`[1/5] Подключение к стартовой странице ${startUrl}...`);
    const getRes = await axiosInst.get(startUrl);
    const getFinalUrl = resolveFinalUrl(getRes, startUrl);
    const $get = cheerio.load(responseText(getRes));

    // Проверяем, возможно уже авторизованы
    if (isDashboardPage(getFinalUrl, $get)) {
      const studentInfo = client.extractStudentInfo($get);
      const sessionData: SavedSessionData = {
        savedAt: new Date().toISOString(),
        fio: studentInfo.studentName,
        group: studentInfo.groupName,
        studyCard: studentInfo.studyCard,
        finalUrl: getFinalUrl,
        cookies: client.getJar().toJSON(),
      };
      await fs.writeFile(savePath, JSON.stringify(sessionData, null, 2), 'utf-8');
      client.setSavedSession(sessionData);
      return { success: true, studentInfo, finalUrl: getFinalUrl, sessionData };
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
      const studentInfo = client.extractStudentInfo($post);
      const sessionData: SavedSessionData = {
        savedAt: new Date().toISOString(),
        fio: studentInfo.studentName,
        group: studentInfo.groupName,
        studyCard: studentInfo.studyCard,
        finalUrl: postFinalUrl,
        cookies: client.getJar().toJSON(),
      };
      await fs.writeFile(savePath, JSON.stringify(sessionData, null, 2), 'utf-8');
      client.setSavedSession(sessionData);
      return { success: true, studentInfo, finalUrl: postFinalUrl, sessionData };
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

    const studentInfo = client.extractStudentInfo($verify);
    const sessionData: SavedSessionData = {
      savedAt: new Date().toISOString(),
      fio: studentInfo.studentName,
      group: studentInfo.groupName,
      studyCard: studentInfo.studyCard,
      finalUrl: verifyFinalUrl,
      cookies: client.getJar().toJSON(),
    };

    await fs.writeFile(savePath, JSON.stringify(sessionData, null, 2), 'utf-8');
    client.setSavedSession(sessionData);

    return {
      success: true,
      studentInfo,
      finalUrl: verifyFinalUrl,
      sessionData,
    };
  }
}
