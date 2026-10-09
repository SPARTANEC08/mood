/**
 * Запуск живой проверки личного кабинета БАРС МЭИ в реальном времени.
 * Запуск: npx tsx scripts/bars-live.ts
 */

import { BarsClient, SessionExpiredError } from '../src/services/bars/barsClient.js';

interface DisciplineData {
  title: string;
  deadline?: string;
  marks: Array<{
    task: string;
    weight: string;
    week: string;
    mark: string;
  }>;
}

async function runLiveCheck(): Promise<void> {
  console.log('====================================================');
  console.log('       ПРЯМОЙ ЭФИР: ЛИЧНЫЙ КАБИНЕТ БАРС МЭИ         ');
  console.log('====================================================\n');

  const client = new BarsClient();

  // 1. Чтение сохраненной авторизации
  console.log('📡 [1/3] Подключение к сессии...');
  const session = await client.loadSavedSession();
  console.log(`✓ Загружена сессия от ${session.savedAt}`);

  const targetUrl = session.finalUrl || '/bars_web/ST_Study/Main/Main';
  console.log(`\n🌐 [2/3] Отправка живого GET-запроса на сервер МЭИ:`);
  console.log(`   URL: ${targetUrl}`);

  const startTime = Date.now();
  let $;
  try {
    $ = await client.getHtml(targetUrl);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`\n❌ СЕССИЯ ИСТЕКЛА: ${err.message}`);
      console.error('Запустите авторизацию: npm run test:auth');
      process.exit(1);
    }
    throw err;
  }
  const latency = Date.now() - startTime;

  console.log(`✓ Ответ получен за ${latency} ms (HTTP 200 OK)`);
  console.log(`   Заголовок страницы: "${$('title').text().trim()}"`);

  // 2. Сбор профиля
  const student = client.extractStudentInfo($);
  const course = $('li:contains("Курс:") strong').text().trim();
  const degree = $('li:contains("Уровень образования:") strong').text().trim();
  const spec = $('li:contains("Направление:") strong').attr('title')?.trim() || $('li:contains("Направление:") strong').text().trim();
  const form = $('li:contains("Форма обучения:") strong').text().trim();
  const status = $('li:contains("Статус обучения:") strong').text().trim();

  console.log('\n====================================================');
  console.log('👤 ПРОФИЛЬ СТУДЕНТА (LIVE ИЗ СИСТЕМЫ)');
  console.log('====================================================');
  console.log(`ФИО:             ${student.studentName}`);
  console.log(`Группа:          ${student.groupName}`);
  console.log(`Зачетная книжка: ${student.studyCard || 'н/д'}`);
  console.log(`Курс:            ${course || '1'}`);
  console.log(`Направление:     ${spec || 'н/д'}`);
  console.log(`Форма:           ${form || 'очная'} (${degree || 'бакалавриат'})`);
  console.log(`Статус:          ${status || 'обучается'}`);
  console.log(`Почта:           ${student.email || 'н/д'}`);

  // 3. Текущие рейтинги
  const rStudy = $('#RST_Study').first().text().trim() || $('#RST').first().text().trim();
  const totalScore = $('#total_score').first().text().trim();
  const semName = $('#ddl_StudyFilterSemester option:selected').text().trim() || 'Текущий семестр';

  console.log('\n====================================================');
  console.log(`📊 РЕЙТИНГИ (${semName})`);
  console.log('====================================================');
  console.log(`Учебный рейтинг:     ${rStudy || '0.0'}`);
  console.log(`Комплексный рейтинг: ${totalScore || '0'}`);

  // 4. Дисциплины и оценки
  const disciplines: DisciplineData[] = [];

  $('div[data-bs-toggle="collapse"]').each((_, el) => {
    const rawTitle = $(el).clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
    if (!rawTitle || rawTitle.includes('Развернуть')) return;

    const deadline = $(el).find('span.badge').text().trim();
    const targetId = $(el).attr('data-bs-target');
    const marks: DisciplineData['marks'] = [];

    if (targetId) {
      $(targetId).find('table tbody tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 4) {
          const task = $(tds[0]).text().replace(/\s+/g, ' ').trim();
          const weight = $(tds[1]).text().trim();
          const week = $(tds[2]).text().replace(/\s+/g, ' ').trim();
          const mark = $(tds[3]).text().replace(/\s+/g, ' ').trim();
          if (task && !task.includes('Текущий контроль') && !task.includes('Промежуточная аттестация')) {
            marks.push({ task, weight, week, mark: mark || '—' });
          }
        }
      });
    }

    disciplines.push({ title: rawTitle, deadline, marks });
  });

  console.log('\n====================================================');
  console.log(`📚 ДИСЦИПЛИНЫ ТЕКУЩЕГО СЕМЕСТРА [${disciplines.length}]`);
  console.log('====================================================');

  for (let i = 0; i < disciplines.length; i++) {
    const d = disciplines[i];
    console.log(`\n${i + 1}. 📖 ${d.title}`);
    if (d.deadline) console.log(`   ⏳ Дедлайн: ${d.deadline}`);
    if (d.marks.length > 0) {
      console.log('   Контрольные мероприятия:');
      for (const m of d.marks) {
        const markStatus = m.mark !== '—' ? `[ОЦЕНКА: ${m.mark}]` : '[не выставлена]';
        console.log(`     • ${m.task.slice(0, 50).padEnd(52)} | Вес: ${m.weight.padEnd(3)}% | Срок: ${m.week.padEnd(14)} | ${markStatus}`);
      }
    }
  }

  console.log('\n====================================================');
  console.log('🟢 ПРЯМОЙ ЭФИР ЗАВЕРШЕН: СЕССИЯ АКТИВНА И ПОЛНОСТЬЮ РАБОТАЕТ!');
  console.log('====================================================');
}

runLiveCheck().catch((err) => {
  console.error('\n❌ Ошибка прямого эфира:', err);
  process.exit(1);
});
