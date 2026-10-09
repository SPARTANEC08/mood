import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function main(): Promise<void> {
  // 1. Входные данные
  // Предполагается, что сессионные куки и URL 2FA передаются из предыдущего шага
  // Для тестирования загружаем их из файла (или можно заменить на хардкод)
  let twoFaActionUrl = 'https://bars.mpei.ru/Account/VerifyCode'; // Значение по умолчанию
  let hiddenFields: Record<string, string> = {
    'RememberMe': 'false',
    'Provider': 'Email' // Пример
  };
  const jar = new CookieJar();

  const statePath = path.join(process.cwd(), 'data', 'step2-state.json');
  try {
    const stateContent = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(stateContent);
    
    if (state.twoFaActionUrl) twoFaActionUrl = state.twoFaActionUrl;
    if (state.hiddenFields) hiddenFields = state.hiddenFields;
    
    if (state.cookies && Array.isArray(state.cookies)) {
      for (const cookieStr of state.cookies) {
        await jar.setCookie(cookieStr, twoFaActionUrl);
      }
      console.log('✓ Состояние сессии загружено.');
    }
  } catch (err) {
    console.log('ℹ️ Файл состояния сессии (data/step2-state.json) не найден. Используются моковые данные для демонстрации.');
  }

  const client = wrapper(
    axios.create({
      jar,
      proxy: false,
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

  console.log(`[Шаг 3] Подтверждение 2FA на ${twoFaActionUrl}`);

  // 1. Запрос одноразового кода
  const rl = readline.createInterface({ input, output });
  const code = (await rl.question('\nВведите код подтверждения: ')).trim();
  rl.close();

  if (!code) {
    console.error('❌ Ошибка: код подтверждения обязателен!');
    process.exit(1);
  }

  // 2. Сборка payload для 2FA
  const postData = new URLSearchParams();
  for (const [key, value] of Object.entries(hiddenFields)) {
    postData.append(key, value);
  }
  // Имя поля для кода может быть 'Code', 'SecurityCode', и т.д. (определяется на шаге 2)
  // Мы используем 'Code' как стандартное, если в скрытых полях нет другого
  postData.set('Code', code);

  console.log(`\nОтправка POST-запроса на ${twoFaActionUrl}...`);

  try {
    // 3. Отправка POST-запроса с кодом подтверждения
    const postResponse = await client.post(twoFaActionUrl, postData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: twoFaActionUrl,
        Origin: new URL(twoFaActionUrl).origin,
      },
    });

    const finalUrl = postResponse.request?.res?.responseUrl || postResponse.config.url || twoFaActionUrl;
    const $ = cheerio.load(postResponse.data);

    // 4. Обработка финального редиректа на дашборд
    const errorElements = $('.alert-danger, .validation-summary-errors, .field-validation-error');
    const errorMessage = errorElements.text().replace(/\s+/g, ' ').trim();

    // Если код неверный — выводим понятную ошибку
    if (errorMessage) {
      console.error(`\n❌ Ошибка проверки кода 2FA: ${errorMessage}`);
      process.exit(1);
    }

    // Проверка маркеров авторизованного студента
    const isDashboard = 
      $('a[href*="LogOff"], a[href*="logout"]').length > 0 ||
      finalUrl.includes('/Student') ||
      finalUrl.includes('/Home');

    if (isDashboard) {
      // 5. Вывод в консоль статуса и данных студента
      console.log('\n🎉 Авторизация успешна!');
      
      // Поиск ФИО и группы (маркеры могут зависеть от верстки БАРС МЭИ)
      let studentName = $('.hidden-xs').first().text().trim() || 
                        $('.user-name').text().trim() || 
                        $('.profile-name').text().trim();
                        
      let groupName = $('span:contains("Группа:")').next().text().trim() ||
                      $('.student-group').text().trim() ||
                      $('td:contains("Группа")').next().text().trim();

      if (!studentName) studentName = 'Не удалось извлечь ФИО';
      if (!groupName) groupName = 'Не удалось извлечь номер группы';

      console.log(`👤 ФИО: ${studentName}`);
      console.log(`📚 Группа: ${groupName}`);

    } else {
      console.error('\n❌ Авторизация не удалась: маркеры личного кабинета не найдены.');
      console.log(`Финальный URL: ${finalUrl}`);
      process.exit(1);
    }

  } catch (err: any) {
    console.error(`\n❌ Сетевая ошибка при отправке 2FA кода: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Непредвиденная ошибка:', err);
  process.exit(1);
});
