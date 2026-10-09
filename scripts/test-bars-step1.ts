import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

interface FormField {
  name: string;
  type: string;
  value: string;
  id?: string;
}

async function main(): Promise<void> {
  const START_URL = 'https://bars.mpei.ru';
  console.log(`[1/3] Отправка GET-запроса на ${START_URL}...`);

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

  const response = await client.get(START_URL);
  const finalUrl = response.request?.res?.responseUrl || response.config.url || START_URL;

  console.log('\n--- Результаты HTTP-запроса ---');
  console.log(`HTTP Статус: ${response.status} ${response.statusText}`);
  console.log(`Финальный URL: ${finalUrl}`);

  console.log('\n[2/3] Парсинг HTML формы авторизации...');
  const $ = cheerio.load(response.data);

  // Ищем первую форму на странице (форма входа)
  const form = $('form').first();
  if (!form.length) {
    console.warn('⚠️ Форма на странице не найдена!');
  } else {
    const rawAction = form.attr('action') || '';
    const method = (form.attr('method') || 'GET').toUpperCase();
    const actionUrl = rawAction ? new URL(rawAction, finalUrl).href : finalUrl;

    console.log(`Метод формы: ${method}`);
    console.log(`Action формы (исходный): ${rawAction}`);
    console.log(`Target URL (абсолютный action): ${actionUrl}`);

    // Извлечение всех скрытых полей
    const hiddenFields: FormField[] = [];
    form.find('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name') || '';
      const value = $(el).attr('value') || '';
      const id = $(el).attr('id');
      if (name) {
        hiddenFields.push({ name, type: 'hidden', value, ...(id ? { id } : {}) });
      }
    });

    console.log(`\nНайденные скрытые поля (<input type="hidden">) [${hiddenFields.length}]:`);
    for (const field of hiddenFields) {
      console.log(`  - [hidden] ${field.name} = "${field.value}"${field.id ? ` (id: ${field.id})` : ''}`);
    }

    // Извлечение всех остальных полей формы для полноты картины
    const otherFields: FormField[] = [];
    form.find('input:not([type="hidden"]), select, textarea').each((_, el) => {
      const name = $(el).attr('name') || '';
      const type = $(el).attr('type') || el.tagName.toLowerCase();
      const value = $(el).attr('value') || '';
      const id = $(el).attr('id');
      if (name) {
        otherFields.push({ name, type, value, ...(id ? { id } : {}) });
      }
    });

    if (otherFields.length > 0) {
      console.log(`\nОстальные поля формы [${otherFields.length}]:`);
      for (const field of otherFields) {
        console.log(`  - [${field.type}] ${field.name}${field.id ? ` (#${field.id})` : ''} = "${field.value}"`);
      }
    }
  }

  console.log('\n[3/3] Cookies в CookieJar:');
  const cookies = await jar.getCookies(finalUrl);
  if (cookies.length === 0) {
    console.log('  (cookies отсутствуют)');
  } else {
    for (const cookie of cookies) {
      console.log(`  - ${cookie.key} = ${cookie.value}`);
      console.log(`    [Domain: ${cookie.domain}, Path: ${cookie.path}, HttpOnly: ${cookie.httpOnly}, Secure: ${cookie.secure}]`);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка выполнения скрипта:', err);
  process.exit(1);
});
