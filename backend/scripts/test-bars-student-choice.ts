/**
 * Тесты выбора студента из таблицы БАРС «Студенты → Список студентов».
 *
 * Зачем: у человека может быть несколько записей (активная и отчисленная),
 * а у сотрудника в том же списке — чужие студенты. Выбирать первого попавшегося
 * нельзя, но и отклонять студента с двумя своими записями нельзя.
 *
 * Запуск: npm run test:bars-student-choice
 */

import * as cheerio from 'cheerio';
import { chooseStudent, parseStudentCandidates } from '../services/bars/barsAuth.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function tableHtml(rows: Array<{ id: string; name: string; recordBook: string; status: string; group: string }>): string {
  return `
    <table id="tbl__PartialListStudent">
      <thead>
        <tr>
          <th>ФИО</th>
          <th>Зачётная книжка</th>
          <th>Статус (на сегодня)</th>
          <th>Группа</th>
          <th>Кафедра</th>
        </tr>
        <tr>
          <th><input id="tb_FilterFIO" /></th>
          <th><input id="tb_FilterNumberOfCreditBook" /></th>
          <th><input id="tb_FilterTrainingStatus" /></th>
          <th><input id="tb_FilterStudyGroupName" /></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
          <tr>
            <td><a href="/bars_web/ST/Student/Main?studentID=${row.id}">${row.name}</a></td>
            <td>${row.recordBook}</td>
            <td>${row.status}</td>
            <td>${row.group}</td>
            <td>МЭП</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

const ACTIVE_ID = 'cfbb232a-9aa5-f111-a289-005056be7b29';
const EXPELLED_ID = '9dc8232a-9aa5-f111-a289-005056be7b29';

console.log('====================================================');
console.log('   ТЕСТЫ ВЫБОРА СТУДЕНТА ИЗ СПИСКА БАРС');
console.log('====================================================');

section('Две записи одного человека: активная и отчисленная');
{
  const $ = cheerio.load(
    tableHtml([
      {
        id: ACTIVE_ID,
        name: 'Соктуев Артём Дмитриевич',
        recordBook: '1020263961',
        status: 'обучается',
        group: 'ИЭ-01-26',
      },
      {
        id: EXPELLED_ID,
        name: 'Соктуев Артем Дмитриевич',
        recordBook: '1020264059',
        status: 'отчислен',
        group: 'ИЭ-22-26',
      },
    ]),
  );

  const candidates = parseStudentCandidates($);
  check('разобраны обе записи', candidates.length === 2, JSON.stringify(candidates));
  check('у активной записи верная группа', candidates[0]?.group === 'ИЭ-01-26');

  const choice = chooseStudent(candidates);
  check('выбрана активная запись', choice.studentId === ACTIVE_ID, JSON.stringify(choice));
  check('причина выбора active', choice.choice === 'active', choice.choice);
}

section('Список чужих студентов');
{
  const choice = chooseStudent([
    {
      studentId: ACTIVE_ID,
      name: 'Иванов Иван Иванович',
      recordBook: '1',
      status: 'обучается',
      group: 'ИЭ-01-26',
    },
    {
      studentId: EXPELLED_ID,
      name: 'Петров Пётр Петрович',
      recordBook: '2',
      status: 'обучается',
      group: 'ИЭ-02-26',
    },
  ]);

  check('чужой список не превращается в студента', choice.studentId === null, JSON.stringify(choice));
  check('причина multiple_names', choice.choice === 'multiple_names', choice.choice);
}

section('Одна запись');
{
  const choice = chooseStudent([
    {
      studentId: ACTIVE_ID,
      name: 'Тюкина Лилия Олеговна',
      recordBook: '1020261826',
      status: 'обучается',
      group: 'ФП-15-26',
    },
  ]);

  check('единственная запись выбирается', choice.studentId === ACTIVE_ID);
  check('причина single', choice.choice === 'single');
}

section('Порядок колонок не совпадает с ожидаемым');
{
  const $ = cheerio.load(`
    <table id="tbl__PartialListStudent">
      <thead>
        <tr>
          <th>Группа</th>
          <th>Статус (на сегодня)</th>
          <th>ФИО</th>
          <th>Зачётная книжка</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>ИЭ-01-26</td>
          <td>обучается</td>
          <td><a href="/bars_web/ST/Student/Main?studentID=${ACTIVE_ID}">Соктуев Артём Дмитриевич</a></td>
          <td>1020263961</td>
        </tr>
      </tbody>
    </table>`);

  const [candidate] = parseStudentCandidates($);
  check('ФИО из нужной колонки', candidate?.name === 'Соктуев Артём Дмитриевич', JSON.stringify(candidate));
  check('статус из нужной колонки', candidate?.status === 'обучается', JSON.stringify(candidate));
  check('группа из нужной колонки', candidate?.group === 'ИЭ-01-26', JSON.stringify(candidate));
}

section('Таблицы студентов нет');
{
  const $ = cheerio.load('<html><body><a href="/bars_web/ST_Study/Main/Main?studentID=' + ACTIVE_ID + '">Учёба</a></body></html>');
  check('кандидатов нет', parseStudentCandidates($).length === 0);
  check('выбор пустой', chooseStudent([]).studentId === null);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`Пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exit(1);
