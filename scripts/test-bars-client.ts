/**
 * Проверочный CLI-скрипт для тестирования BarsClient с сохраненной сессией.
 * Запуск: npx tsx scripts/test-bars-client.ts
 */

import { BarsClient, SessionExpiredError } from '../src/services/bars/barsClient.js';

async function main(): Promise<void> {
  console.log('=== Тестирование BarsClient с сохраненной сессией ===\n');

  const client = new BarsClient();

  // 1. Загрузка сессии
  console.log('[1/3] Загрузка сохраненной сессии из .bars-session-debug.json...');
  let sessionData;
  try {
    sessionData = await client.loadSavedSession();
    console.log(`✓ Сессия успешно загружена (сохранена: ${sessionData.savedAt || 'н/д'})`);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  // 2. Выполнение запроса к кабинету студента
  // Если в сессии был зафиксирован прямой URL студента (/bars_web/ST_Study/Main/Main?studentID=...), используем его, иначе /bars_web/
  const targetRoute = sessionData.finalUrl || '/bars_web/ST_Study/Main/Main';
  console.log(`\n[2/3] Запрос HTML страницы: ${targetRoute}...`);

  let $;
  try {
    $ = await client.getHtml(targetRoute);
    console.log(`✓ Страница успешно получена и распарсена Cheerio!`);
    console.log(`  Заголовок документа: "${$('title').text().trim()}"`);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`\n❌ Ошибка: ${err.message}`);
      console.error('   Запустите скрипт авторизации: npm run test:auth');
    } else {
      console.error(`\n❌ Сетевая или HTTP ошибка: ${(err as Error).message}`);
    }
    process.exit(1);
  }

  // 3. Извлечение данных студента
  console.log(`\n[3/3] Извлечение данных студента и навигации...`);
  const student = client.extractStudentInfo($);
  console.log('\n--- Данные студента ---');
  console.log(`👤 ФИО: ${student.studentName}`);
  console.log(`📚 Группа: ${student.groupName}`);
  if (student.studyCard) {
    console.log(`📋 Зачетная книжка (№ЗК): ${student.studyCard}`);
  }
  if (student.email) {
    console.log(`✉️ Корпоративная почта: ${student.email}`);
  }

  // 4. Извлечение ссылок меню/сайдбара
  const menuLinks = client.extractMenuLinks($);
  console.log(`\n--- Меню / Сайдбар БАРС (${menuLinks.length} ссылок) ---`);
  
  // Группируем по секциям для читаемого вывода
  const bySection = new Map<string, Array<{ text: string; href: string }>>();
  for (const item of menuLinks) {
    const sec = item.section || 'Основное';
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push({ text: item.text, href: item.href });
  }

  for (const [section, links] of bySection.entries()) {
    console.log(`\n[📁 Раздел: ${section}]`);
    for (const link of links) {
      console.log(`  • ${link.text.padEnd(25)} -> ${link.href}`);
    }
  }

  console.log('\n✅ Тест успешно завершен! BarsClient готов к интеграции в модули бота.');
}

main().catch((err) => {
  console.error('Непредвиденная ошибка при выполнении скрипта:', err);
  process.exit(1);
});
