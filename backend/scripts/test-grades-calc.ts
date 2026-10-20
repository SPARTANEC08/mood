/**
 * Тесты калькулятора среднего балла и конвертации пропусков в академические часы.
 * Запуск: npx tsx backend/scripts/test-grades-calc.ts
 */

import 'dotenv/config';

import * as cheerio from 'cheerio';
import * as fs from 'node:fs';

import {
  buildSubjectReport,
  buildSemesterReport,
  weightedAverage,
} from '../gradeCalculator.js';
import { esc, expandableQuote, fmtNum, quote } from '../../tg/format.js';
import { encrypt } from '../utils/crypto.js';
import { userStore } from '../../db/storage/userStore.js';
import { sanitizeFileName } from '../../db/storage/fileStore.js';
import { ACADEMIC_HOURS_PER_LESSON, parseAttendancePage } from '../services/bars/parsers/attendanceParser.js';
import { parseGradesPage } from '../services/bars/parsers/gradesParser.js';
import type { SubjectGrade } from '../services/bars/parsers/gradesParser.js';

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

  section('Пересдача: несколько попыток в одной ячейке');
  {
    const retakeHtml = `
      <html><body>
        <div id="s_ss_1">
          <div data-bs-target="#s_ss_1">Математика, Иванов И.И., экзамен</div>
          <table>
            <tr><td>1. КМ №1</td><td>100</td><td>4</td><td>2 (10.10.26) 4 (15.10.26)</td></tr>
            <tr><td>Балл текущего контроля:</td><td>3</td></tr>
          </table>
        </div>
      </body></html>
    `;

    const parsed = parseGradesPage(cheerio.load(retakeHtml));
    const math = parsed.subjects[0];

    check('пересдача — это один КМ', math?.controlPoints.length === 1, String(math?.controlPoints.length));
    check(
      'сохранены обе попытки',
      JSON.stringify(math?.controlPoints[0]?.attempts) === '[2,4]',
      JSON.stringify(math?.controlPoints[0]?.attempts),
    );
    check(
      'оценка КМ = среднее попыток (3)',
      math?.controlPoints[0]?.score === 3,
      String(math?.controlPoints[0]?.score),
    );
    check(
      'средний балл дисциплины учитывает пересдачу',
      math ? buildSubjectReport(math).currentAverage === 3 : false,
      math ? String(buildSubjectReport(math).currentAverage) : 'нет дисциплины',
    );
    check('балл БАРС сохранён для сверки', math?.totalScore === 3, String(math?.totalScore));
  }

  section('Хранение файлов на сервере: имя и тип');
  {
    // Telegram больше не участвует в хранении файлов, и определять тип по
    // префиксу file_id не нужно: файл лежит на диске, а в записи лежит
    // ServerFileRef с настоящим именем и MIME. Проверяется то, что теперь
    // отвечает за этот слой — приведение имени к безопасному виду и то, что
    // имя из записей совпадает с тем, что лежит на диске.
    check('имя без путей', sanitizeFileName('../../etc/passwd') === 'passwd');
    check('имя Windows-пути без слеша', sanitizeFileName('C:\\temp\\photo.jpg') === 'photo.jpg');
    check('кавычки вырезаются', sanitizeFileName('отчёт"final".pdf') === 'отчётfinal.pdf');
    check('пустое имя заменяется', sanitizeFileName('') === 'file');
    check('имя обрезается до 120 символов', sanitizeFileName('я'.repeat(300)).length === 120);
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