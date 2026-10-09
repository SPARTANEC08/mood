/**
 * CLI-скрипт проверки авторизации БАРС МЭИ (https://bars.mpei.ru/bars_web/).
 *
 * Запуск: npx tsx scripts/test-bars-auth.ts
 *
 * Реальный флоу БАРС (ASP.NET MVC, подтверждено по HTML):
 *   1. GET /bars_web/                       -> форма Account + Password + __RequestVerificationToken
 *   2. POST /bars_web/                       -> при верных кредах возвращает страницу /bars_web/Auth/LoginCode
 *   3. GET /bars_web/Auth/JSON_SendAF2_Code?tid=N  -> !!! ТРИГГЕРИТ ОТПРАВКУ КОДА !!!
 *      (в браузере вызывается автоматически из $(document).ready -> af2_code_send(...);
 *       axios/jsdom JS не исполняют, поэтому скрипт ОБЯЗАН вызвать этот URL вручную,
 *       иначе код 2FA никогда не придет — это и был баг предыдущей версии)
 *   4. POST /bars_web/Auth/LoginCode         -> поля __RequestVerificationToken, Account,
 *      RememberMe, StopOpenDefault, AF2_Code (4 цифры)
 *   5. Редирект в дашборд БАРС.
 */

import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

interface StudentInfo {
  studentName: string;
  groupName: string;
  studyCard?: string;
}

interface SessionFile {
  savedAt: string;
  fio: string;
  group: string;
  studyCard?: string;
  finalUrl: string;
  cookies: ReturnType<CookieJar['toJSON']>;
}

/** Параметры JS-вызова af2_code_send('btnId', '/url', 'tid', 'len') на странице LoginCode. */
interface Af2SendInfo {
  buttonId: string;
  sendUrl: string; // абсолютный URL
  tid: string;
  codeLength: number;
  channelHint: string; // текст кнопки btnSend, напр. "Отправить повторно через МАКС"
}

interface JsonSendAf2Response {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

const START_URL = 'https://bars.mpei.ru/bars_web/';
const SESSION_FILE = path.join(process.cwd(), '.bars-session-debug.json');
const DEBUG_LOGIN_CODE_HTML = path.join(process.cwd(), '.bars-debug-logincode.html');
const DEBUG_2FA_RESPONSE_HTML = path.join(process.cwd(), '.bars-debug-2fa-response.html');

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
};

// ---------------------------------------------------------------------------
// Логирование
// ---------------------------------------------------------------------------

function logStep(title: string): void {
  console.log(`\n${title}`);
}

function logResponse(tag: string, res: AxiosResponse, finalUrl: string): void {
  console.log(`  [${tag}] ${res.config.method?.toUpperCase()} ${res.config.url}`);
  console.log(`  [${tag}] -> HTTP ${res.status} ${res.statusText}`);
  console.log(`  [${tag}] -> финальный URL: ${finalUrl}`);
  const setCookie = res.headers['set-cookie'];
  if (Array.isArray(setCookie) && setCookie.length > 0) {
    console.log(`  [${tag}] Set-Cookie (${setCookie.length}):`);
    for (const c of setCookie) {
      console.log(`    - ${String(c).slice(0, 160)}`);
    }
  } else {
    console.log(`  [${tag}] Set-Cookie: (нет новых)`);
  }
}

function logJar(tag: string, cookies: string[]): void {
  if (cookies.length === 0) {
    console.log(`  [${tag}] CookieJar пуст`);
    return;
  }
  console.log(`  [${tag}] CookieJar (${cookies.length}):`);
  for (const c of cookies) {
    console.log(`    - ${c.slice(0, 160)}`);
  }
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

// ---------------------------------------------------------------------------
// HTTP-клиент
// ---------------------------------------------------------------------------

function createClient(jar: CookieJar): AxiosInstance {
  return wrapper(
    axios.create({
      jar,
      proxy: false, // не даем HTTP(S)_PROXY подменять cookie-агента
      maxRedirects: 10,
      timeout: 30_000,
      headers: BROWSER_HEADERS,
      // Не кидаем исключение на 4xx, чтобы самим разобрать ошибку формы.
      validateStatus: (s) => s >= 200 && s < 500,
    }),
  );
}

// ---------------------------------------------------------------------------
// Парсинг страниц
// ---------------------------------------------------------------------------

function extractStudentInfo($: cheerio.CheerioAPI): StudentInfo {
  // 1. ФИО студента
  // В хлебных крошках: <li class="breadcrumb-item active">Лысенко Николай Романович</li>
  let studentName = $('ol.breadcrumb li.breadcrumb-item.active').text().replace(/\s+/g, ' ').trim();

  let studyCard = '';
  // В заголовке блока студента: <span class="fw-bold">Лысенко Николай Романович (№ЗК - 1020260185)</span>
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

  // Из <title>: "ЛКС Лысенко Н.Р."
  if (!studentName) {
    const title = $('title').text().trim();
    if (/^ЛКС\s+/i.test(title)) {
      studentName = title.replace(/^ЛКС\s+/i, '').trim();
    }
  }

  // Резервный поиск
  if (!studentName) {
    const pick = (...selectors: string[]): string => {
      for (const sel of selectors) {
        const t = $(sel).first().text().replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
      return '';
    };
    studentName =
      pick('.hidden-xs', '.user-name', '.profile-name', '.navbar .username', '#userName') ||
      'Не удалось извлечь ФИО';
  }

  // 2. Группа студента
  let groupName = '';
  // Из ссылки на расписание: /bars_web/Open/RUZ/Timetable?rt=3&name=ИЭ-11-26
  const ruzLink = $('a[href*="/Open/RUZ/Timetable"]').attr('href') || '';
  const ruzMatch = ruzLink.match(/name=([^&]+)/);
  if (ruzMatch) {
    try {
      groupName = decodeURIComponent(ruzMatch[1]).trim();
    } catch {
      groupName = ruzMatch[1].trim();
    }
  }

  // Из элементов <span class="fw-bold">
  if (!groupName) {
    $('span.fw-bold').each((_, el) => {
      const text = $(el).text().trim();
      // Паттерн академической группы МЭИ: буквы, дефис, две цифры, дефис, две цифры (напр. ИЭ-11-26)
      if (/^[А-ЯЁa-zA-Z]{1,5}-\d{2}-\d{2}$/i.test(text)) {
        groupName = text;
        return false;
      }
    });
  }

  // Поиск по регулярке группы по всей странице
  if (!groupName) {
    const pageHtml = $.html();
    const groupMatch = pageHtml.match(/\b([А-ЯЁ]{1,5}-\d{2}-\d{2})\b/);
    if (groupMatch) {
      groupName = groupMatch[1];
    }
  }

  if (!groupName) {
    const pick = (...selectors: string[]): string => {
      for (const sel of selectors) {
        const t = $(sel).first().text().replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
      return '';
    };
    groupName =
      pick('.student-group', 'td:contains("Группа") + td', 'span:contains("Группа:") + span') ||
      'Не удалось извлечь номер группы';
  }

  return { studentName, groupName, studyCard: studyCard || undefined };
}

function isDashboardPage(finalUrl: string, $: cheerio.CheerioAPI): boolean {
  // Если на странице есть поля ввода пароля или 2FA-кода — это форма входа, а не дашборд!
  if ($('input[name="Password"], input[name="AF2_Code"], input#AF2_Code').length > 0) return false;

  // Наличие кнопки/ссылки выхода из системы (в БАРС это /bars_web/Auth/Exit)
  if ($('a[href*="/Auth/Exit" i], a[href*="LogOff" i], a[href*="logout" i]').length > 0) return true;

  const u = finalUrl.toLowerCase();
  // Реальный дашборд студента БАРС: /bars_web/ST_Study/...
  if (u.includes('/st_study/') || u.includes('studentid=')) return true;

  // Заголовок ЛКС: "ЛКС Лысенко Н.Р."
  const title = $('title').text().toLowerCase();
  if (title.startsWith('лкс') || title.includes('личный кабинет')) return true;

  // Характерные элементы дашборда БАРС
  if ($('ol.breadcrumb, #div-FormHeader, h4:contains("Оценки в БАРС")').length > 0) return true;

  return false;
}

function getFormError($: cheerio.CheerioAPI): string {
  return $('.alert-danger, .validation-summary-errors, .field-validation-error')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Вытаскивает параметры отправки кода из inline-скрипта страницы LoginCode:
 *   af2_code_send('btnSend', '/bars_web/Auth/JSON_SendAF2_Code', '3', '4');
 */
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

// ---------------------------------------------------------------------------
// Сессия
// ---------------------------------------------------------------------------

async function saveSession(
  jar: CookieJar,
  info: StudentInfo,
  finalUrl: string,
): Promise<void> {
  const payload: SessionFile = {
    savedAt: new Date().toISOString(),
    fio: info.studentName,
    group: info.groupName,
    studyCard: info.studyCard,
    finalUrl,
    cookies: jar.toJSON(),
  };
  await fs.writeFile(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`\n💾 Сессия сохранена в ${SESSION_FILE}`);
}

async function describeJar(jar: CookieJar, url: string): Promise<string[]> {
  const cookies = await jar.getCookies(url);
  return cookies.map((c) => `${c.key}=${c.value} [Domain:${c.domain} Path:${c.path}]`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Проверка авторизации БАРС МЭИ ===');

  let jar = new CookieJar();
  let client = createClient(jar);

  // ---- Шаг 0: переиспользование сохраненной сессии ----
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf-8');
    const saved = JSON.parse(raw) as SessionFile;
    if (saved.cookies) {
      jar = CookieJar.fromJSON(saved.cookies as never);
      client = createClient(jar);
      console.log('✓ Найден файл сессии, проверяем актуальность...');
      try {
        const res = await client.get(START_URL);
        const finalUrl = resolveFinalUrl(res, START_URL);
        const $check = cheerio.load(responseText(res));
        if (res.status === 200 && isDashboardPage(finalUrl, $check)) {
          const info = extractStudentInfo($check);
          console.log('\n✅ Сохраненная сессия актуальна, вход не требуется!');
          console.log(`👤 ФИО: ${info.studentName}`);
          console.log(`📚 Группа: ${info.groupName}`);
          if (info.studyCard || saved.studyCard) {
            console.log(`📋 Зачетка (№ЗК): ${info.studyCard || saved.studyCard}`);
          }
          return;
        }
        console.log('⚠️ Сохраненная сессия устарела, выполняем полный вход.');
        jar = new CookieJar();
        client = createClient(jar);
      } catch (err) {
        console.log(`⚠️ Не удалось проверить сессию (${String(err)}), выполняем полный вход.`);
        jar = new CookieJar();
        client = createClient(jar);
      }
    }
  } catch {
    // файла нет — штатный путь
  }

  // ---- Шаг 1: GET стартовой страницы ----
  logStep(`[Шаг 1] GET ${START_URL} — получаем форму входа и цепочку редиректов`);
  let getRes: AxiosResponse;
  try {
    getRes = await client.get(START_URL);
  } catch (err) {
    console.error(`❌ Сетевая ошибка при GET ${START_URL}.`);
    console.error(`   Причина: ${(err as Error).message}`);
    console.error('   Проверьте доступность bars.mpei.ru и таймаут сети.');
    process.exit(1);
  }
  const getFinalUrl = resolveFinalUrl(getRes, START_URL);
  logResponse('GET /bars_web/', getRes, getFinalUrl);
  logJar('GET /bars_web/', await describeJar(jar, getFinalUrl));

  if (getRes.status !== 200) {
    console.error(`❌ Неожиданный HTTP-статус стартовой страницы: ${getRes.status}`);
    process.exit(1);
  }

  const getHtml = responseText(getRes);
  const $get = cheerio.load(getHtml);
  const loginForm = $get('form').first();

  if (!loginForm.length) {
    if (isDashboardPage(getFinalUrl, $get)) {
      console.log('✅ Уже авторизованы (форма входа отсутствует, открыт дашборд).');
      await saveSession(jar, extractStudentInfo($get), getFinalUrl);
      return;
    }
    console.error('❌ Форма входа не найдена на стартовой странице. Верстка БАРС изменилась?');
    process.exit(1);
  }

  const hasAccount = $get('input[name="Account"]').length > 0;
  const hasPassword = $get('input[name="Password"]').length > 0;
  if (!hasAccount || !hasPassword) {
    console.error('❌ Форма входа не содержит полей Account/Password. Верстка изменилась?');
    process.exit(1);
  }

  const rawAction = loginForm.attr('action') ?? '';
  const loginPostUrl = rawAction ? new URL(rawAction, getFinalUrl).href : getFinalUrl;
  console.log(`  Форма входа: action="${rawAction}" -> POST ${loginPostUrl}`);

  const loginHidden: Record<string, string> = {};
  loginForm.find('input[type="hidden"]').each((_, el) => {
    const name = $get(el).attr('name');
    if (name) loginHidden[name] = $get(el).attr('value') ?? '';
  });
  console.log(`  Скрытые поля формы [${Object.keys(loginHidden).length}]: ${Object.keys(loginHidden).join(', ')}`);
  if (!('__RequestVerificationToken' in loginHidden)) {
    console.error('❌ В форме входа нет __RequestVerificationToken — CSRF-флоу БАРС изменился.');
    process.exit(1);
  }

  // ---- Шаг 2: ввод учетных данных ----
  logStep('[Шаг 2] Ввод учетных данных');
  const rl = readline.createInterface({ input, output });
  const username = (await rl.question('Логин (без @mpei.ru): ')).trim();
  const password = (await rl.question('Пароль: ')).trim();
  if (!username || !password) {
    console.error('❌ Логин и пароль обязательны.');
    rl.close();
    process.exit(1);
  }

  // ---- Шаг 3: POST логин/пароль ----
  logStep(`[Шаг 3] POST ${loginPostUrl} — отправляем креды + скрытые токены`);
  const loginBody = new URLSearchParams();
  for (const [k, v] of Object.entries(loginHidden)) loginBody.append(k, v);
  loginBody.set('Account', username);
  loginBody.set('Password', password);
  // RememberMe в форме — пара checkbox(true)+hidden(false); при ручной сборке шлем false.
  if (!loginBody.has('RememberMe')) loginBody.set('RememberMe', 'false');

  let postRes: AxiosResponse;
  try {
    postRes = await client.post(loginPostUrl, loginBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: getFinalUrl,
        Origin: new URL(getFinalUrl).origin,
      },
    });
  } catch (err) {
    console.error(`❌ Сетевая ошибка при POST логина: ${(err as Error).message}`);
    rl.close();
    process.exit(1);
  }
  const postFinalUrl = resolveFinalUrl(postRes, loginPostUrl);
  logResponse('POST login', postRes, postFinalUrl);
  logJar('POST login', await describeJar(jar, postFinalUrl));

  const postHtml = responseText(postRes);
  const $post = cheerio.load(postHtml);

  // Неверный логин/пароль: БАРС возвращает ту же форму + .validation-summary-errors
  const loginError = getFormError($post);
  const backOnLoginForm = $post('input[name="Password"]').length > 0;
  if (loginError || backOnLoginForm) {
    console.error(`\n❌ Неверный логин или пароль.${loginError ? ` БАРС сообщает: "${loginError}"` : ''}`);
    rl.close();
    process.exit(1);
  }

  // ---- Шаг 4: детект 2FA ----
  const is2fa = isLoginCodePage($post, postFinalUrl);
  if (!is2fa && isDashboardPage(postFinalUrl, $post)) {
    console.log('\n🎉 Успешная авторизация (2FA не потребовалась)!');
    const info = extractStudentInfo($post);
    console.log(`👤 ФИО: ${info.studentName}`);
    console.log(`📚 Группа: ${info.groupName}`);
    if (info.studyCard) console.log(`📋 Зачетка (№ЗК): ${info.studyCard}`);
    await saveSession(jar, info, postFinalUrl);
    rl.close();
    return;
  }

  if (!is2fa) {
    console.error('\n❌ Страница после логина не распознана: ни дашборд, ни форма LoginCode.');
    console.error(`   Финальный URL: ${postFinalUrl}`);
    console.error(`   Заголовок: "${$post('title').text().trim()}"`);
    rl.close();
    process.exit(1);
  }
  console.log('\n✅ Обнаружен этап 2FA: форма /bars_web/Auth/LoginCode (поле AF2_Code)');

  await fs.writeFile(DEBUG_LOGIN_CODE_HTML, postHtml, 'utf-8').catch(() => undefined);
  console.log(`  HTML страницы 2FA сохранен в ${DEBUG_LOGIN_CODE_HTML} (для отладки)`);

  const af2 = parseAf2SendInfo(postHtml, postFinalUrl, $post);
  if (!af2) {
    console.error('❌ Не найден вызов af2_code_send(...) — не знаем tid для отправки кода.');
    rl.close();
    process.exit(1);
  }
  console.log(`  Канал доставки кода: "${af2.channelHint || 'не указан'}"`);
  console.log(`  Длина кода: ${af2.codeLength} цифры, tid=${af2.tid}`);

  // ---- Шаг 4a: ЯВНЫЙ запрос отправки кода (ключевой фикс!) ----
  // Браузер делает это сам через JS при загрузке страницы; скрипт должен повторить вручную.
  const sendUrl = `${af2.sendUrl}?tid=${encodeURIComponent(af2.tid)}&_=${Date.now()}`;
  logStep(`[Шаг 4a] GET ${sendUrl} — запрашиваем отправку кода 2FA`);
  let sendRes: AxiosResponse;
  try {
    sendRes = await client.get(sendUrl, {
      headers: {
        Referer: postFinalUrl,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
  } catch (err) {
    console.error(`❌ Сетевая ошибка при запросе отправки кода: ${(err as Error).message}`);
    rl.close();
    process.exit(1);
  }
  logResponse('GET JSON_SendAF2', sendRes, resolveFinalUrl(sendRes, sendUrl));

  let sendJson: JsonSendAf2Response | null = null;
  try {
    sendJson = typeof sendRes.data === 'string' ? JSON.parse(sendRes.data) : (sendRes.data as JsonSendAf2Response);
  } catch {
    sendJson = null;
  }
  console.log(`  Ответ сервера отправки кода: ${JSON.stringify(sendJson)?.slice(0, 300)}`);

  if (!sendJson || sendJson.success !== true) {
    const reason =
      (sendJson?.error as string | undefined) ??
      (sendJson?.message as string | undefined) ??
      'сервер не подтвердил отправку (success != true)';
    console.error(`\n❌ Код 2FA НЕ отправлен. Причина: "${reason}"`);
    console.error('   Типичные причины: rate-limit (код уже запрашивали <60 сек назад), привязка tid к сессии истекла,');
    console.error('   либо канал доставки (МАКС/SMS/почта) недоступен. Подождите минуту и попробуйте снова.');
    rl.close();
    process.exit(1);
  }
  console.log(`  ✓ Сервер принял запрос: "${String(sendJson.message ?? 'код отправлен').slice(0, 200)}"`);
  console.log('  ⏳ Код должен прийти в течение минуты — проверьте МАКС / SMS / почту.');

  // ---- Шаг 4b: ввод и проверка кода ----
  const verifyForm = $post('form').first();
  const verifyRawAction = verifyForm.attr('action') ?? '';
  const verifyUrl = verifyRawAction ? new URL(verifyRawAction, postFinalUrl).href : postFinalUrl;
  console.log(`\n  Форма проверки: action="${verifyRawAction}" -> POST ${verifyUrl}`);

  const codeField = verifyForm.find('input[name="AF2_Code"]');
  if (!codeField.length) {
    console.error('❌ В форме проверки нет поля AF2_Code. Верстка LoginCode изменилась?');
    rl.close();
    process.exit(1);
  }

  const code = (await rl.question(`\nВведите полученный код подтверждения (${af2.codeLength} цифры): `)).trim();
  rl.close();

  if (!code) {
    console.error('❌ Код подтверждения обязателен.');
    process.exit(1);
  }
  if (!new RegExp(`^\\d{${af2.codeLength}}$`).test(code)) {
    console.error(`❌ Код должен состоять ровно из ${af2.codeLength} цифр. Вы ввели: "${code}"`);
    process.exit(1);
  }

  logStep(`[Шаг 5] POST ${verifyUrl} — проверяем код 2FA`);
  const verifyBody = new URLSearchParams();
  verifyForm.find('input').each((_, el) => {
    const name = $post(el).attr('name');
    if (!name || name === 'AF2_Code') return;
    verifyBody.set(name, $post(el).attr('value') ?? '');
  });
  // Account в форме LoginCode — hidden с подставленным логином; не даем ему потеряться.
  if (!verifyBody.get('Account')) verifyBody.set('Account', username);
  verifyBody.set('AF2_Code', code);

  let verifyRes: AxiosResponse;
  try {
    verifyRes = await client.post(verifyUrl, verifyBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: postFinalUrl,
        Origin: new URL(postFinalUrl).origin,
      },
    });
  } catch (err) {
    console.error(`❌ Сетевая ошибка при проверке кода: ${(err as Error).message}`);
    process.exit(1);
  }
  const verifyFinalUrl = resolveFinalUrl(verifyRes, verifyUrl);
  logResponse('POST LoginCode', verifyRes, verifyFinalUrl);
  logJar('POST LoginCode', await describeJar(jar, verifyFinalUrl));

  const verifyHtml = responseText(verifyRes);
  await fs.writeFile(DEBUG_2FA_RESPONSE_HTML, verifyHtml, 'utf-8').catch(() => undefined);
  const $verify = cheerio.load(verifyHtml);

  const verifyError = getFormError($verify);
  if (verifyError) {
    console.error(`\n❌ Неверный код 2FA. БАРС сообщает: "${verifyError}"`);
    process.exit(1);
  }
  if (isLoginCodePage($verify, verifyFinalUrl)) {
    console.error('\n❌ Неверный код 2FA (БАРС вернул форму ввода кода без пояснения ошибки).');
    console.error('   Запросите код заново и проверьте, что вводите последний полученный код.');
    process.exit(1);
  }

  // ---- Шаг 6: дашборд + сохранение сессии ----
  if (!isDashboardPage(verifyFinalUrl, $verify)) {
    console.error('\n❌ Авторизация не удалась: маркеры личного кабинета не найдены.');
    console.error(`   Финальный URL: ${verifyFinalUrl}`);
    console.error(`   Заголовок: "${$verify('title').text().trim()}"`);
    console.error(`   Полный ответ сохранен в ${DEBUG_2FA_RESPONSE_HTML}`);
    process.exit(1);
  }

  logStep('[Шаг 6] Дашборд БАРС открыт — фиксируем сессию');
  const info = extractStudentInfo($verify);
  console.log('\n🎉 Авторизация успешна!');
  console.log(`👤 ФИО: ${info.studentName}`);
  console.log(`📚 Группа: ${info.groupName}`);
  if (info.studyCard) {
    console.log(`📋 Зачетка (№ЗК): ${info.studyCard}`);
  }
  await saveSession(jar, info, verifyFinalUrl);
}

main().catch((err) => {
  console.error('Непредвиденная ошибка:', err);
  process.exit(1);
});
