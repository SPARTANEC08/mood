/**
 * Тестовый раннер выгрузки приказов, стипендии и библиотеки из БАРС МЭИ.
 * Запуск: npx tsx scripts/test-info.ts
 */

import { BarsScraper } from '../src/services/bars/barsScraper.js';

async function main(): Promise<void> {
  console.log('=== Выгрузка приказов, стипендии и библиотеки БАРС МЭИ ===\n');

  const scraper = new BarsScraper();

  // 1. Приказы
  console.log('📜 1. Приказы по студенту:');
  const orders = await scraper.getOrders();
  if (orders.length > 0) {
    console.table(
      orders.map((o) => ({
        '№ приказа': o.number,
        'Дата': o.date,
        'Содержание': o.title,
        ...(o.status ? { 'Статус': o.status } : {}),
      })),
    );
  } else {
    console.log('   (Приказов не найдено)\n');
  }

  // 2. Стипендия
  console.log('\n💰 2. Данные о стипендии:');
  const scholarship = await scraper.getScholarship();
  console.log(`   • Назначена:  ${scholarship.isAppointed ? '✅ Да' : '❌ Нет'}`);
  if (scholarship.type) {
    console.log(`   • Вид:        ${scholarship.type}`);
  }
  if (scholarship.period) {
    console.log(`   • Период:     ${scholarship.period}`);
  }
  if (scholarship.amount) {
    console.log(`   • Размер:     ${scholarship.amount}`);
  }

  // 3. Библиотека НТБ МЭИ
  console.log('\n📚 3. Книги в библиотеке НТБ МЭИ:');
  const books = await scraper.getLibraryBooks();
  if (books.length > 0) {
    console.table(
      books.map((b) => ({
        'Наименование': b.title,
        'Автор': b.author ?? '—',
        'Срок возврата': b.dueDate,
        'Статус': b.isOverdue ? '⚠️ Просрочена' : '✅ В срок',
      })),
    );
  } else {
    console.log('   (Задолженностей по книгам нет)');
  }

  console.log('\n=== Проверка успешно завершена ===');
}

main().catch((err) => {
  console.error('\n❌ Ошибка при выгрузке информации:', err);
  process.exit(1);
});
