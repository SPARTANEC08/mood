import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

interface FormField {
  name: string;
  type: string;
  value: string;
  id?: string;
}

async function main(): Promise<void> {
  const START_URL = 'https://bars.mpei.ru';
  console.log(`[Шаг 1] Отправка GET-запроса на ${START_URL}...`);

  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      proxy: false, // Исключает подмену cookie-агента прокси-агентом при наличии HTTP(S)_PROXY
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      maxRedirects: 10,
    })
  );

  const getResponse = await client.get(START_URL);
  const getFinalUrl = getResponse.request?.res?.responseUrl || getResponse.config.url || START_URL;

  const $get = cheerio.load(getResponse.data);
  const loginForm = $get('form').first();

  if (!loginForm.length) {
    throw new Error('Форма авторизации не найдена на начальной странице!');
  }

  const rawAction = loginForm.attr('action') || '';
  const postActionUrl = rawAction ? new URL(rawAction, getFinalUrl).href : getFinalUrl;

  // Извлекаем скрытые поля начальной формы
  const hiddenFields: Record<string, string> = {};
  loginForm.find('input[type="hidden"]').each((_, el) => {
    const name = $get(el).attr('name');
    const value = $get(el).attr('value') || '';
    if (name) {
      hiddenFields[name] = value;
    }
  });

  console.log(`✓ Начальная страница получена (HTTP ${getResponse.status})`);
  console.log(`  Target URL: ${postActionUrl}`);
  console.log(`  Скрытые поля: ${Object.keys(hiddenFields).join(', ')}`);

  // Запрос логина и пароля в консоли через node:readline/promises
  console.log('\n[Ввод учетных данных]');
  const rl = readline.createInterface({ input, output });
  const it = rl[Symbol.asyncIterator]();

  async function ask(query: string): Promise<string> {
    if (process.stdin.isTTY) {
      return await rl.question(query);
    }
    process.stdout.write(query);
    const res = await it.next();
    return res.value ?? '';
  }

  let username = '';
  let password = '';

  try {
    username = (await ask('Логин: ')).trim();
    password = (await ask('Пароль: ')).trim();
  } finally {
    rl.close();
  }

  if (!username || !password) {
    console.error('❌ Ошибка: логин и пароль обязательны для заполнения!');
    process.exit(1);
  }

  console.log(`\n[Шаг 2] Отправка POST-запроса на ${postActionUrl}...`);

  // Формируем application/x-www-form-urlencoded тело с hidden полями и кредами
  const postData = new URLSearchParams();
  for (const [key, value] of Object.entries(hiddenFields)) {
    postData.append(key, value);
  }
  postData.set('Account', username);
  postData.set('Password', password);

  const postResponse = await client.post(postActionUrl, postData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: getFinalUrl,
      Origin: new URL(getFinalUrl).origin,
    },
  });

  const postFinalUrl =
    postResponse.request?.res?.responseUrl || postResponse.config.url || postActionUrl;
  const $post = cheerio.load(postResponse.data);

  console.log('\n--- Результаты POST-запроса ---');
  console.log(`HTTP Статус: ${postResponse.status} ${postResponse.statusText}`);
  console.log(`Финальный URL: ${postFinalUrl}`);

  // 1. Проверяем ошибки авторизации (неверный пароль / пользователь не найден)
  const errorElements = $post('.alert-danger, .validation-summary-errors, .field-validation-error');
  let errorMessage = errorElements
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  // Если снова отрендерилась форма ввода логина и пароля
  const hasLoginFormAgain = $post('input#Password, input[name="Password"]').length > 0;

  if (errorMessage || (hasLoginFormAgain && postResponse.status === 200)) {
    if (!errorMessage) {
      errorMessage = 'Неверные учетные данные или повторный возврат на форму входа.';
    }
    console.error(`\n❌ Ошибка авторизации: ${errorMessage}`);
    console.error('Завершение процесса.');
    process.exit(1);
  }

  // 2. Проверяем переход на шаг 2FA (двухфакторная аутентификация)
  console.log('\n[Анализ ответа на 2FA]');

  const twoFaForm = $post('form').first();
  const twoFaRawAction = twoFaForm.attr('action') || '';
  const twoFaActionUrl = twoFaRawAction ? new URL(twoFaRawAction, postFinalUrl).href : postFinalUrl;

  // Поиск поля ввода одноразового кода 2FA
  const candidateSelectors = [
    'input#Code',
    'input[name="Code"]',
    'input[name="code"]',
    'input[name="SecurityCode"]',
    'input[name="VerificationCode"]',
    'input[name*="code" i]',
    'input[name*="otp" i]',
    'input[name*="token" i]',
    'input[autocomplete="one-time-code"]',
  ];

  let foundInputSelector: string | null = null;
  for (const selector of candidateSelectors) {
    if ($post(selector).length > 0) {
      foundInputSelector = selector;
      break;
    }
  }

  // Резервный поиск: текстовое поле ввода внутри формы 2FA
  if (!foundInputSelector && twoFaForm.length > 0) {
    const textInput = twoFaForm
      .find('input[type="text"], input[type="number"], input:not([type])')
      .first();
    if (textInput.length > 0) {
      const id = textInput.attr('id');
      const name = textInput.attr('name');
      if (id) {
        foundInputSelector = `#${id}`;
      } else if (name) {
        foundInputSelector = `input[name="${name}"]`;
      }
    }
  }

  const pageText = $post('body').text().toLowerCase();
  const is2FaPage =
    Boolean(foundInputSelector) ||
    pageText.includes('код') ||
    pageText.includes('аутентификац') ||
    pageText.includes('подтвержден') ||
    postFinalUrl.toLowerCase().includes('code') ||
    postFinalUrl.toLowerCase().includes('twofactor');

  if (is2FaPage) {
    console.log('✅ Обнаружен этап двухфакторной аутентификации (2FA)!');
    console.log(`Селектор поля ввода 2FA: ${foundInputSelector || 'не найден'}`);
    console.log(`Action URL для отправки 2FA кода: ${twoFaActionUrl}`);

    // Извлечение hidden-полей формы 2FA
    const twoFaHiddenFields: FormField[] = [];
    twoFaForm.find('input[type="hidden"]').each((_, el) => {
      const name = $post(el).attr('name') || '';
      const value = $post(el).attr('value') || '';
      if (name) {
        twoFaHiddenFields.push({ name, type: 'hidden', value });
      }
    });

    if (twoFaHiddenFields.length > 0) {
      console.log(`\nСопутствующие hidden-поля 2FA формы [${twoFaHiddenFields.length}]:`);
      for (const field of twoFaHiddenFields) {
        console.log(`  - [hidden] ${field.name} = "${field.value}"`);
      }
    }
  } else {
    const isDashboard =
      $post('a[href*="LogOff"], a[href*="logout"]').length > 0 ||
      postFinalUrl.includes('/Student') ||
      postFinalUrl.includes('/Home');

    if (isDashboard) {
      console.log('🎉 Успешная авторизация без 2FA (выполнен вход в личный кабинет)!');
    } else {
      console.log('ℹ️ Страница после отправки формы не распознана как 2FA или кабинет.');
      console.log('Заголовок страницы:', $post('title').text().trim());
    }
  }

  // Вывод кук в CookieJar
  console.log('\n[Cookies в CookieJar]:');
  const cookies = await jar.getCookies(postFinalUrl);
  if (cookies.length === 0) {
    console.log('  (cookies пусты)');
  } else {
    for (const cookie of cookies) {
      console.log(`  - ${cookie.key} = ${cookie.value}`);
      console.log(`    [Domain: ${cookie.domain}, Path: ${cookie.path}, HttpOnly: ${cookie.httpOnly}]`);
    }
  }
}

main().catch((err) => {
  console.error('Непредвиденная ошибка:', err);
  process.exit(1);
});
