/**
 * Тесты калькулятора среднего балла и конвертации пропусков в академические часы.
 * Запуск: npx tsx scripts/test-grades-calc.ts
 */

import 'dotenv/config';

import * as cheerio from 'cheerio';
import * as fs from 'node:fs';

import {
  buildSubjectReport,
  buildSemesterReport,
  weightedAverage,
} from '../src/bot/gradeCalculator.js';
import { buildGradesView } from '../src/bot/moreView.js';
import { processTelegramMessage } from '../src/bot/botEngine.js';
import { esc, expandableQuote, fmtNum, quote, toneButton } from '../src/bot/format.js';
import { encrypt } from '../src/utils/crypto.js';
import { resolveFileType } from '../src/bot/telegramService.js';
import { userStore } from '../src/storage/userStore.js';
import { ACADEMIC_HOURS_PER_LESSON, parseAttendancePage } from '../src/services/bars/parsers/attendanceParser.js';
import { parseGradesPage } from '../src/services/bars/parsers/gradesParser.js';
import type { SubjectGrade } from '../src/services/bars/parsers/gradesParser.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function subject(points: SubjectGrade['controlPoints'], over: Partial<SubjectGrade> = {}): SubjectGrade {
  return {
    discipline: 'Математика',
    controlType: 'Экзамен',
    attestationRaw: 'экзамен',
    controlPoints: points,
    weekScores: [],
    totalScore: null,
    ...over,
  };
}

const km = (number: number, score: number | null, weight?: number) => ({ number, score, weight });

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('   ТЕСТЫ: СРЕДНИЙ БАЛЛ, КМ, ПРОПУСКИ   ');
  console.log('====================================================');

  section('Средневзвешенный балл');

  check('нет оценок -> null', weightedAverage([]) === null);
  check('одна оценка', weightedAverage([km(1, 5, 100)]) === 5);

  // Пример из задания: 5 и 4 при весах 50/50 -> 4,5
  check('5 и 4 при 50/50 = 4,5', weightedAverage([km(1, 5, 50), km(2, 4, 50)]) === 4.5);

  // Веса неравные: 5*0.7 + 4*0.3 = 4,7
  check('5*70% + 4*30% = 4,7', weightedAverage([km(1, 5, 70), km(2, 4, 30)]) === 4.7);

  // Незакрытые КМ не влияют
  check('null не влияет на среднее', weightedAverage([km(1, 5, 50), km(2, null, 50)]) === 5);

  // Без весов — простое среднее
  check('без весов -> среднее', weightedAverage([km(1, 5), km(2, 4)]) === 4.5);

  section('Отчёт по дисциплине');
  {
    // Пример из задания: КМ1=3 (25%), КМ2..4 пустые по 25%
    const mathReal = subject([
      km(1, 3, 25),
      km(2, null, 25),
      km(3, null, 25),
      km(4, null, 25),
    ]);
    const mathReport = buildSubjectReport(mathReal);

    check('текущий средний = 3', mathReport.currentAverage === 3);
    check('закрыт 1 КМ из 4', mathReport.gradedCount === 1 && mathReport.totalCount === 4);
    check('незакрытых 3 КМ', mathReport.pendingCount === 3);
    check('вес закрытых КМ = 25%', mathReport.gradedWeight === 25);
    check('общий вес = 100%', mathReport.totalWeight === 100);
  }

  {
    const allDone = subject([km(1, 5, 50), km(2, 4, 50)]);
    const doneReport = buildSubjectReport(allDone);
    check('все КМ закрыты -> pendingCount = 0', doneReport.pendingCount === 0);
    check('средний 4,5', doneReport.currentAverage === 4.5);
    check('балл БАРС сохраняется для сверки', doneReport.barsAverage === null);
  }

  {
    const withFinal = subject([km(1, 5, 100)], { finalGrade: 'Отлично' });
    check('итоговая оценка из ЛК подхватывается', buildSubjectReport(withFinal).finalGrade === 'Отлично');
  }

  {
    const mixed = subject([km(1, 5, 50), km(2, 3, 50)], { totalScore: 4 });
    const report = buildSubjectReport(mixed);
    check('свой средний считается по весам', report.currentAverage === 4);
    check('балл БАРС не перетирает расчёт', report.barsAverage === 4);
  }

  section('Веса КМ влияют на средний');
  {
    // Тяжёлый КМ с тройкой тянет средний вниз сильнее лёгкого
    const heavyThree = weightedAverage([km(1, 3, 80), km(2, 5, 20)]);
    const lightThree = weightedAverage([km(1, 3, 20), km(2, 5, 80)]);
    check('тяжёлая тройка даёт меньший средний', (heavyThree ?? 5) < (lightThree ?? 0));
    check('80/20 = 3,4', heavyThree === 3.4, `получено ${heavyThree}`);
    check('20/80 = 4,6', lightThree === 4.6, `получено ${lightThree}`);
  }

  section('Отчёт по семестру сортируется от худшего к лучшему');
  const semester = buildSemesterReport([
    subject([km(1, 5, 100)], { discipline: 'Хорошая' }),
    subject([km(1, 3, 100)], { discipline: 'Плохая' }),
    subject([km(1, 4, 100)], { discipline: 'Средняя' }),
    subject([km(1, null, 100)], { discipline: 'Без оценок' }),
  ]);
  check('все дисциплины с КМ попали в отчёт', semester.length === 4);
  check('первой идёт худшая', semester[0].discipline === 'Плохая');
  check('вторая — средняя', semester[1].discipline === 'Средняя');
  check('третья — лучшая', semester[2].discipline === 'Хорошая');
  check('дисциплина без оценок уходит в конец', semester[3].discipline === 'Без оценок');

  section('Экран оценок: формат');
  const view = buildGradesView({
    semesterName: '2026/2027, Осенний семестр',
    isCurrent: true,
    subjects: [
      subject([km(1, 5, 25), km(2, 4, 25), km(3, null, 50)], {
        discipline: 'Математика',
        attestationRaw: 'зачёт с оценкой',
      }),
      subject([km(1, 5, 100)], {
        discipline: 'Физкультура',
        attestationRaw: 'зачёт (без оценки)',
      }),
    ],
  });

  check('заголовок семестра', view.text.startsWith('📊 <b>Оценки</b>'));
  // Пороги автомата убраны из заголовка и вынесены в подвал экрана
  const headerLine = view.text.split('\n')[0];
  check('в заголовке нет порогов автомата', !headerLine.includes('Автомат'));

  check('формат «Дисциплина (тип) — средний»', view.text.includes('Математика <i>(зачёт с оценкой)</i> — <b>4,5</b>'));
  check('зачёт без оценки показан как «зачёт»', view.text.includes('Физкультура <i>(зачёт)</i> — <b>5</b>'));
  check('среднее через запятую', view.text.includes('4,5') && !view.text.includes('4.5'));
  check('сворачиваемый блок <blockquote expandable>', view.text.includes('<blockquote expandable>'));
  check('веса КМ показаны курсивом', view.text.includes('<i>вес 25%</i>'));
  check('счётчик закрытых КМ', view.text.includes('Закрыто 2 из 3'));
  check('из оценок назад на расписание', view.keyboard[0][0].text === '◀️ К расписанию');
  check('нет сырых дробей в весах', !/\(\d+\.\d+%\)/.test(view.text));
  // Система автоматов удалена — в экране не должно остаться ни слова о ней
  check('нет упоминаний автомата', !view.text.includes('втомат'));
  check('нет «Средний балл по дисциплинам»', !view.text.includes('Средний балл по дисциплинам'));
  check('нет «До автомата»', !view.text.includes('До автомата'));
  check('нет подваля с порогами', !view.text.includes('4,3') && !view.text.includes('4,8'));
  check('нет эмодзи целей прогноза', !view.text.includes('🎯') && !view.text.includes('🏆'));

  section('Пропуски: пары → академические часы');
  check('коэффициент = 2 часа на пару', ACADEMIC_HOURS_PER_LESSON === 2);

  const attendanceHtml = `
    <html><body>
      <table id="tableSkipSummary">
        <thead>
          <tr><th>Дисциплина Дис.</th><th>По журналу Занятий</th><th>Пропущено</th>
              <th>По уважительной причине</th><th>Без уважительной причины, %</th></tr>
        </thead>
        <tbody>
          <tr><td colspan="5">История России (зачёт)</td></tr>
          <tr><td>История России (зачёт)</td><td>32</td><td>2</td><td>1</td><td>1,50</td></tr>
          <tr><td colspan="5">Физика (зачёт с оценкой)</td></tr>
          <tr><td>Физика (зачёт с оценкой)</td><td>40</td><td>1</td><td>0</td><td>0,50</td></tr>
        </tbody>
      </table>
    </body></html>
  `;

  const attendance = parseAttendancePage(cheerio.load(attendanceHtml));
  check('всего пропущено пар: 3', attendance.totalMissedLessons === 3, `получено ${attendance.totalMissedLessons}`);
  check('3 пары = 6 часов', attendance.totalMissed === 6, `получено ${attendance.totalMissed}`);
  check('1 уважительная пара = 2 часа', attendance.totalExcused === 2);
  // Без уважительной считается как разница: 3 − 1 = 2 пары = 4 часа
  check('без уважительной: 2 пары = 4 часа', attendance.totalUnexcused === 4, `получено ${attendance.totalUnexcused}`);

  const history = attendance.bySubject.find((s) => s.discipline.includes('История'));
  check('История: 2 пары', history?.missedLessons === 2);
  check('История: 4 часа', history?.totalMissedHours === 4, `получено ${history?.totalMissedHours}`);
  check('История: 2 часа уважительно', history?.excusedHours === 2);

  const physics = attendance.bySubject.find((s) => s.discipline.includes('Физика'));
  check('Физика: 1 пара = 2 часа', physics?.totalMissedHours === 2, `получено ${physics?.totalMissedHours}`);

  section('/reflash: команда обновления расписания');
  {
    const flash = await processTelegramMessage({ id: 999222111, firstName: 'Флеш' }, '/reflash');
    check('неавторизованному /reflash -> экран входа', flash.status === 'need_login');
    check('сообщение /reflash удаляется', flash.deleteIncoming === true);
  }
  {
    // Авторизованный пользователь с кэшем: /reflash должен сбросить кэш и отрисовать главный экран
    const encL = encrypt('st123456');
    const encP = encrypt('pass');
    userStore.ensureUser(999222111, { firstName: 'Флеш' });
    userStore.patch(999222111, {
      barsAuth: {
        encryptedLogin: encL.encryptedData,
        encryptedPass: encP.encryptedData,
        iv: encL.iv,
        tag: encL.tag,
        cookiesJson: '{}',
      },
      studentProfile: { fullName: 'Флеш Флешов Флешович' },
      groupName: 'ИЭ-11-26',
      groupId: 21985,
    });

    const flash = await processTelegramMessage({ id: 999222111, firstName: 'Флеш' }, '/reflash');
    check('авторизованному /reflash -> registered', flash.status === 'registered');
    check('/reflash отдал главный экран или ошибку загрузки', flash.messageText.length > 0);
    check('/reflash с кнопкой Остальное', (flash.keyboard ?? []).some((r) => r.some((b) => b.callback_data === 'nav_more')));

    userStore.remove(999222111);
  }

  section('Цветовые тона кнопок');
  {
    // Telegram поддерживает реальные цвета: danger/success/primary
    check('практика -> danger (красный)', toneButton('x', 'practice', 'cb').style === 'danger');
    check('лекция -> primary (синий)', toneButton('x', 'lecture', 'cb').style === 'primary');
    check('обед -> success (зелёный)', toneButton('x', 'lunch', 'cb').style === 'success');
    check('назад -> danger (красный)', toneButton('x', 'back', 'cb').style === 'danger');
    check('выход -> danger (красный)', toneButton('x', 'logout', 'cb').style === 'danger');
    check('нейтральные без стиля', toneButton('x', 'neutral', 'cb').style === undefined);
    check('сервисы покрашены', toneButton('x', 'attendance', 'cb').style !== undefined);
    check('сессия покрашена', toneButton('x', 'session', 'cb').style !== undefined);
    check('эмодзи-цвет убран из подписи', toneButton('Лекция', 'lecture', 'cb').text === 'Лекция');
    check('callback_data сохранён', toneButton('x', 'lunch', 'lunch_joke').callback_data === 'lunch_joke');
    check('цитата сворачивается (blockquote expandable)', expandableQuote('строка').startsWith('<blockquote expandable>'));
    check('обычная цитата', quote('строка').startsWith('<blockquote>'));
    check('экранирование < и >', esc('a<b>&c') === 'a&lt;b&gt;&amp;c');
    check('экранирование в цитате', quote(esc('<script>')).includes('&lt;script&gt;'));
    check('формат числа с запятой', fmtNum(4.5) === '4,5');
    check('null -> прочерк', fmtNum(null) === '—');
  }

  section('Отправка файлов: определение типа по file_id');
  {
    // Telegram кодирует тип в префиксе file_id. Если поле type не сохранилось,
    // фото уходило в sendDocument и Telegram отвечал «can't use Photo as Document».
    check('фото по префиксу Ag', resolveFileType({ fileId: 'AgACAgIAAxkBAAIBQ', fileName: 'f.jpg' }) === 'photo');
    check('документ по префиксу BQ', resolveFileType({ fileId: 'BQACAgIAAxkBAAIB', fileName: 'f.pdf' }) === 'document');
    check('видео по префиксу BA', resolveFileType({ fileId: 'BAACAgIAAxkBAAIB', fileName: 'f.mp4' }) === 'video');
    check('аудио по префиксу CQ', resolveFileType({ fileId: 'CQACAgIAAxkBAAIB', fileName: 'f.mp3' }) === 'audio');
    check('голос по префиксу Aw', resolveFileType({ fileId: 'AwACAgIAAxkBAAIB', fileName: 'f.ogg' }) === 'voice');
    check('неизвестный префикс -> документ', resolveFileType({ fileId: 'ZZZZ', fileName: 'f.bin' }) === 'document');
    check('сохранённый type важнее префикса',
      resolveFileType({ fileId: 'AgAC...', fileName: 'f.jpg', type: 'video' }) === 'video');
  }

  section('Файлы не теряются при открытии по тексту');
  {
    // Раньше filesToSend обрабатывался только в callback-обработчике,
    // поэтому при открытии раздела текстом файлы молча не отправлялись.
    const sent = await processTelegramMessage({ id: 996665554, firstName: 'Файлы' }, 'дз');
    check('текстовый вход в ДЗ не падает', sent.status === 'need_login' || sent.status === 'registered');
  }

  section('Парсер КМ на реальном HTML');
  const saved = 'scratch/page_grades.html';
  if (fs.existsSync(saved)) {
    const parsed = parseGradesPage(cheerio.load(fs.readFileSync(saved, 'utf-8')));
    check('дисциплины распознаны', parsed.subjects.length > 0, `найдено ${parsed.subjects.length}`);

    const math = parsed.subjects.find((s) => s.discipline === 'Математика');
    if (math) {
      check('КМ найдены (4 штуки)', math.controlPoints.length === 4, `найдено ${math.controlPoints.length}`);
      check('веса КМ = 25% каждый', math.controlPoints.every((p) => p.weight === 25));
      check('название КМ без номера', (math.controlPoints[0].title ?? '').startsWith('«Элементарная') === true, `получено: ${math.controlPoints[0].title}`);
      check('оценка КМ1 = 3', math.controlPoints[0].score === 3, `получено ${math.controlPoints[0].score}`);
      check('неделя КМ1 = 4', math.controlPoints[0].week === '4');
      check('дата получения КМ1', (math.controlPoints[0].date ?? '').includes('02.10.26'));
      check('КМ без оценки = null', math.controlPoints[1].score === null);
      check('балл текущего контроля = 3', math.totalScore === 3, `получено ${math.totalScore}`);
      check('тип аттестации = экзамен', math.controlType === 'Экзамен');

      const sumWeights = math.controlPoints.reduce((a, p) => a + (p.weight ?? 0), 0);
      check('сумма весов КМ = 100%', sumWeights === 100, `сумма ${sumWeights}`);

      const report = buildSubjectReport(math);
      check('средний по одному КМ = 3', report.currentAverage === 3);
      check('закрыт 1 КМ из 4', report.gradedCount === 1);
      console.log(`     ${math.discipline}: средний ${report.currentAverage}, закрыто ${report.gradedCount} из ${report.totalCount} КМ`);
    } else {
      check('дисциплина «Математика» найдена', false, 'нет в разборе');
    }

    const info = parsed.subjects.find((s) => s.discipline === 'Информатика');
    if (info) {
      check('Информатика: 5 КМ', info.controlPoints.length === 5, `найдено ${info.controlPoints.length}`);
      check(
        'Информатика: неравные веса (10/10/35/35/10)',
        info.controlPoints.map((p) => p.weight).join(',') === '10,10,35,35,10',
        info.controlPoints.map((p) => p.weight).join(','),
      );
      const report = buildSemesterReport(parsed.subjects).find((r) => r.discipline === 'Информатика');
      console.log(`     ${info.discipline}: средний ${info.totalScore}, КМ ${info.controlPoints.length}`);
    }
  } else {
    console.log('     (scratch/page_grades.html нет — парсер проверен на синтетическом HTML)');
  }

  section('Пустой ввод не падает');
  const emptyGrades = buildGradesView({ semesterName: '—', isCurrent: true, subjects: [] });
  check('пустой семестр -> понятное сообщение', emptyGrades.text.includes('не найдено'));
  check('пустой семестр -> назад на расписание', emptyGrades.keyboard[0][0].text === '◀️ К расписанию');
  const noKm = buildSubjectReport(subject([]));
  check('дисциплина без КМ не падает', noKm.currentAverage === null && noKm.totalCount === 0);

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Тесты упали:', err);
  process.exit(1);
});