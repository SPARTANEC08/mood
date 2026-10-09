/**
 * Визуальный рендер новых экранов в терминале (для проверки вёрстки).
 * Запуск: npx tsx scripts/preview-views.ts
 */

import 'dotenv/config';

import { buildMainScheduleView } from '../src/bot/scheduleView.ts';
import {
  buildAttendanceView,
  buildGradesView,
  buildLibraryView,
  buildMoreHubView,
  buildOrdersView,
  buildOsepView,
} from '../src/bot/moreView.ts';
import { buildLoginPromptView, buildPasswordPromptView, buildTwoFactorPromptView } from '../src/bot/authView.ts';
import type { TelegramUser } from '../src/storage/userStore.ts';
import type { ParsedSchedule, ParsedLessonVariant } from '../src/parser/types.ts';

function variant(
  discipline: string,
  kindOfWork: string,
  auditorium: string,
  lecturerShort: string
): ParsedLessonVariant {
  return {
    discipline,
    kindOfWork,
    auditorium,
    building: '',
    lecturerShort,
    lecturerFullName: lecturerShort,
    allLecturers: [],
    jointGroups: [],
    onlineUrls: [],
  };
}

const schedule: ParsedSchedule = {
  groupName: 'ИЭ-11-26',
  groupId: 21985,
  facultyName: 'ИЭИ',
  parentScheduleName: '',
  totalLessons: 24,
  dateRange: { start: '2026.09.01', finish: '2027.01.15' },
  days: [
    {
      date: '08.10.2026',
      rawDate: '2026.10.08',
      dayOfWeek: 4,
      dayName: 'Четверг',
      dayShort: 'Чт',
      slots: [
        {
          lessonNumber: 1,
          lessonNumberEnd: 1,
          timeStart: '08:30',
          timeEnd: '10:05',
          variants: [variant('Математический анализ', 'Лекция', 'Б-201', 'доц. Иванов И.И.')],
        },
        {
          lessonNumber: 2,
          lessonNumberEnd: 2,
          timeStart: '10:15',
          timeEnd: '11:50',
          variants: [variant('Линейная алгебра', 'Практическое занятие', 'Б-305', 'пр. Петров П.П.')],
        },
        {
          lessonNumber: 3,
          lessonNumberEnd: 3,
          timeStart: '12:45',
          timeEnd: '14:20',
          variants: [variant('Информационные технологии', 'Лабораторная работа', 'Д-412', 'доц. Сидоров С.С.')],
        },
        {
          lessonNumber: 4,
          lessonNumberEnd: 4,
          timeStart: '14:30',
          timeEnd: '16:05',
          variants: [variant('Физическая культура', 'Практическое занятие', 'Спортзал', 'Смирнов С.С.')],
        },
      ],
    },
  ],
};

const user: TelegramUser = {
  telegramId: 1,
  firstName: 'Николай',
  registeredAt: new Date().toISOString(),
  groupName: 'ИЭ-11-26',
  groupId: 21985,
  studentProfile: {
    fullName: 'Лысенко Николай Романович',
    recordBookNumber: '1020260185',
  },
  barsAuth: {
    encryptedLogin: 'x',
    encryptedPass: 'y',
    iv: 'z',
    tag: 't',
    cookiesJson: '{}',
  },
};

const STYLE_COLOR: Record<string, string> = {
  danger: '\x1b[41m\x1b[97m',
  success: '\x1b[42m\x1b[30m',
  primary: '\x1b[44m\x1b[97m',
};

function paint(text: string, style?: string): string {
  const color = style ? STYLE_COLOR[style] : undefined;
  if (!color) return `\x1b[90m${text}\x1b[0m`;
  return `${color} ${text} \x1b[0m`;
}

function render(title: string, view: { text: string; keyboard?: { text: string; callback_data: string; style?: string }[][] }): void {
  console.log('\n' + '='.repeat(58));
  console.log(`  ${title}`);
  console.log('='.repeat(58));
  console.log(view.text);
  console.log('-'.repeat(58));
  for (const row of view.keyboard ?? []) {
    console.log(`  ${row.map((b) => paint(b.text, b.style)).join('  ')}`);
  }
  console.log('  \x1b[90m[зелёный=success, синий=primary, красный=danger, серый=без цвета]\x1b[0m');
}

render('ВОРОНКА ВХОДА — шаг 1: логин', buildLoginPromptView('Николай'));
render('ВОРОНКА ВХОДА — шаг 2: пароль', buildPasswordPromptView('st123456'));
render('ВОРОНКА ВХОДА — шаг 3: код 2FA', buildTwoFactorPromptView('на номер +7***-45'));
render('ГЛАВНЫЙ ЭКРАН', buildMainScheduleView(schedule, '2026.10.08', user));
render('ХАБ «ОСТАЛЬНОЕ»', buildMoreHubView(user));

// Оценки: берём реальный разбор сохранённой страницы БАРС
import * as cheerio from 'cheerio';
import * as fs from 'node:fs';
import { parseGradesPage } from '../src/services/bars/parsers/gradesParser.ts';

if (fs.existsSync('scratch/page_grades.html')) {
  const realGrades = parseGradesPage(cheerio.load(fs.readFileSync('scratch/page_grades.html', 'utf-8')));
  render('ОЦЕНКИ (реальные данные БАРС)', buildGradesView(realGrades));
}

render(
  'ПРОПУСКИ (2 пары = 4 часа)',
  buildAttendanceView({
    totalMissedLessons: 2,
    totalExcusedLessons: 0,
    totalUnexcusedLessons: 2,
    totalMissed: 4,
    totalExcused: 0,
    totalUnexcused: 4,
    lastUpdated: '09.10.2026 12:00',
    bySubject: [
      {
        discipline: 'Основы российской государственности',
        missedLessons: 2,
        excusedLessons: 0,
        unexcusedLessons: 2,
        totalMissedHours: 4,
        excusedHours: 0,
        unexcusedHours: 4,
      },
    ],
  }),
);

render(
  'КНИГИ (НТБ)',
  buildLibraryView([
    { title: 'Высшая математика для экономистов', author: 'Кремер Н.', issueDate: '01.09.2026', dueDate: '01.10.2026', isOverdue: true },
    { title: 'Физика. Задачник', author: 'Иродов И.И.', issueDate: '05.09.2026', dueDate: '15.12.2026', isOverdue: false },
    { title: 'Экономика предприятия', author: 'Громов В.', issueDate: '01.09.2026', dueDate: '20.11.2026', isOverdue: false },
  ]),
);

render('ПРИКАЗЫ И СТИПЕНДИЯ', buildOrdersView(
  [
    { number: '123', date: '01.09.2026', title: 'О зачислении на 1 курс' },
    { number: '124', date: '05.09.2026', title: 'О назначении государственной академической стипендии' },
  ],
  { isAppointed: true, type: 'академическая', period: '01.09.2026 — 31.01.2027', amount: '5 000 руб.' },
));

render(
  'ОСЭП — ПИСЬМА',
  buildOsepView(
    [
      {
        uid: 41,
        date: new Date('2026-10-07T09:12:00'),
        from: 'Учебное управление',
        fromAddress: 'ucheb@mpei.ru',
        subject: 'О пересдаче промежуточной аттестации',
        snippet: 'Уважаемый студент...',
        hasAttachments: true,
        attachmentNames: ['raspisanie.pdf'],
        isSeen: false,
      },
    ],
    3,
  ),
);

console.log();