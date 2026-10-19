/**
 * Сводный тестовый скрипт скрапинга полной карточки студента из БАРС МЭИ с поддержкой авторизации.
 * 
 * Использование:
 *   npx tsx backend/scripts/test-bars-scraper.ts          — использует сохраненную сессию (при истечении запросит логин/пароль/2FA)
 *   npx tsx backend/scripts/test-bars-scraper.ts --login  — принудительный полный вход через логин, пароль и 2FA
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { BarsService } from '../services/bars/index.js';

const DIVIDER = '═'.repeat(78);
const SUB_DIVIDER = '─'.repeat(78);

async function main(): Promise<void> {
  console.log(`\n${DIVIDER}`);
  console.log('             🎓 ПОЛНАЯ КАРТОЧКА СТУДЕНТА БАРС МЭИ');
  console.log(`${DIVIDER}\n`);

  const barsService = new BarsService();
  const forceLogin = process.argv.includes('--login') || process.argv.includes('-l');

  // Проверка сессии
  let needLogin = forceLogin;
  if (!forceLogin) {
    process.stdout.write('🔍 Проверка актуальности сессии БАРС... ');
    const isAlive = await barsService.isSessionValid();
    if (isAlive) {
      const session = barsService.getClient().getSavedSession();
      console.log('✅ Актуальна');
      console.log(`   Пользователь: ${session?.fio || 'Неизвестно'} (${session?.group || '—'})`);
      console.log('   (Для принудительного повторного входа запустите: npx tsx backend/scripts/test-bars-scraper.ts --login)\n');
    } else {
      console.log('⚠️ Сессия отсутствует или устарела.');
      needLogin = true;
    }
  }

  // Процесс авторизации при необходимости
  if (needLogin) {
    console.log(`${SUB_DIVIDER}`);
    console.log('🔐 АВТОРИЗАЦИЯ В БАРС МЭИ (Логин + Пароль + 2FA)');
    console.log(`${SUB_DIVIDER}\n`);

    const rl = readline.createInterface({ input, output });

    try {
      const defaultUser = process.env.BARS_USERNAME || '';
      const usernamePrompt = defaultUser
        ? `Логин (без @mpei.ru) [${defaultUser}]: `
        : 'Логин (без @mpei.ru): ';
      const inputUsername = (await rl.question(usernamePrompt)).trim();
      const username = inputUsername || defaultUser;

      if (!username) {
        console.error('❌ Логин обязателен.');
        rl.close();
        process.exit(1);
      }

      const defaultPass = process.env.BARS_PASSWORD || '';
      const passwordPrompt = defaultPass ? 'Пароль [из .env]: ' : 'Пароль: ';
      const inputPassword = (await rl.question(passwordPrompt)).trim();
      const password = inputPassword || defaultPass;

      if (!password) {
        console.error('❌ Пароль обязателен.');
        rl.close();
        process.exit(1);
      }

      console.log('\n⏳ Выполняется вход в систему...');
      await barsService.login({
        username,
        password,
        onStep: (msg) => console.log(`   ${msg}`),
        on2FACodeNeeded: async ({ codeLength, channelHint }) => {
          console.log(`\n📲 Запрос отправки 2FA-кода выполнен (${channelHint || 'МАКС/SMS/почта'}).`);
          const code = (await rl.question(`👉 Введите код подтверждения (${codeLength} цифры): `)).trim();
          return code;
        },
      });

      console.log('\n✅ Авторизация успешно пройдена, сессия обновлена!\n');
    } finally {
      rl.close();
    }
  }

  // Сбор данных профиля
  console.log('⏳ Загрузка и сбор данных из БАРС МЭИ...');
  const startTime = Date.now();
  const profile = await barsService.getFullStudentProfile();
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Данные успешно собраны за ${duration} сек.\n`);

  // 1. Профиль студента
  console.log(`${SUB_DIVIDER}`);
  console.log('🎓 ПРОФИЛЬ СТУДЕНТА:');
  console.log(`   • ФИО:        ${profile.student.fio}`);
  console.log(`   • Группа:     ${profile.student.group}`);
  if (profile.student.studyCard) {
    console.log(`   • Зачётка:    № ${profile.student.studyCard}`);
  }
  if (profile.student.email) {
    console.log(`   • Email:      ${profile.student.email}`);
  }

  // 2. Стипендия
  console.log(`\n${SUB_DIVIDER}`);
  console.log('💰 СТИПЕНДИЯ:');
  console.log(`   • Статус:     ${profile.scholarship.isAppointed ? '✅ Назначена' : '❌ Не назначена'}`);
  if (profile.scholarship.type) {
    console.log(`   • Вид:        ${profile.scholarship.type}`);
  }
  if (profile.scholarship.period) {
    console.log(`   • Период:     ${profile.scholarship.period}`);
  }
  if (profile.scholarship.amount) {
    console.log(`   • Размер:     ${profile.scholarship.amount}`);
  }

  // 3. Сводка оценок
  console.log(`\n${SUB_DIVIDER}`);
  console.log(`📊 СВОДКА ОЦЕНОК (${profile.grades.semesterName}):`);
  if (profile.grades.subjects.length > 0) {
    console.table(
      profile.grades.subjects.map((s) => ({
        Предмет: s.discipline,
        'КТ 1': s.controlPoints[0]?.score ?? '—',
        'КТ 2': s.controlPoints[1]?.score ?? '—',
        'КТ 3': s.controlPoints[2]?.score ?? '—',
        Итог: s.totalScore ?? '—',
        Оценка: s.finalGrade ?? '—',
      })),
    );
  } else {
    console.log('   (Данные об оценках отсутствуют)');
  }

  // 4. Пропуски занятий
  console.log(`\n${SUB_DIVIDER}`);
  console.log('📉 ПРОПУСКИ ЗАНЯТИЙ:');
  console.log(`   • Всего пропущено:            ${profile.attendance.totalMissed} ч. (зан.)`);
  console.log(`   • По уважительной причине:    ${profile.attendance.totalExcused} ч.`);
  console.log(`   • По неуважительной причине:  ${profile.attendance.totalUnexcused} ч.`);

  const missedSubjects = profile.attendance.bySubject.filter((s) => s.totalMissedHours > 0);
  if (missedSubjects.length > 0) {
    console.log('   ⚠️  Предметы с пропусками:');
    missedSubjects.forEach((s) => {
      console.log(
        `      - ${s.discipline}: ${s.totalMissedHours} ч. (неув: ${s.unexcusedHours}, уваж: ${s.excusedHours})`,
      );
    });
  } else {
    console.log('   🎉 Пропусков по дисциплинам нет!');
  }

  // 5. Книги из библиотеки НТБ МЭИ
  console.log(`\n${SUB_DIVIDER}`);
  console.log(`📚 КНИГИ ИЗ БИБЛИОТЕКИ НТБ МЭИ (${profile.libraryBooks.length}):`);
  if (profile.libraryBooks.length > 0) {
    console.table(
      profile.libraryBooks.map((b) => ({
        Наименование: b.title,
        Автор: b.author ?? '—',
        'Срок возврата': b.dueDate,
        Статус: b.isOverdue ? '⚠️ Просрочена' : '✅ В срок',
      })),
    );
    const overdueCount = profile.libraryBooks.filter((b) => b.isOverdue).length;
    if (overdueCount > 0) {
      console.log(`   ⚠️ Внимание: ${overdueCount} книг(и) просрочено!`);
    }
  } else {
    console.log('   (Задолженностей по книгам нет)');
  }

  // 6. Последние приказы
  console.log(`\n${SUB_DIVIDER}`);
  const recentOrders = profile.orders.slice(0, 3);
  console.log(`📜 ПОСЛЕДНИЕ ${recentOrders.length} ПРИКАЗА:`);
  if (recentOrders.length > 0) {
    recentOrders.forEach((o, idx) => {
      console.log(`   ${idx + 1}. [${o.number}] ${o.date} — ${o.title}`);
    });
  } else {
    console.log('   (Приказов не найдено)');
  }

  // Предупреждения
  if (profile.warnings.length > 0) {
    console.log(`\n${SUB_DIVIDER}`);
    console.log('⚠️  ПРЕДУПРЕЖДЕНИЯ:');
    profile.warnings.forEach((w) => console.log(`   • ${w}`));
  }

  console.log(`\n${DIVIDER}`);
  console.log('🏁 Формирование карточки студента успешно завершено!');
  console.log(`${DIVIDER}\n`);
}

main().catch((err) => {
  console.error('\n❌ Критическая ошибка:', err);
  process.exit(1);
});
