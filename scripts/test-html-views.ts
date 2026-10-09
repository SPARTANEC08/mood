/**
 * Проверка HTML-разметки всех экранов.
 *
 * Telegram отклоняет сообщение целиком, если в HTML непарный или неизвестный тег.
 * Поэтому здесь ловим ошибки ДО отправки: считаем баланс тегов и ищем сырые спецсимволы.
 *
 * Запуск: npx tsx scripts/test-html-views.ts
 */

import 'dotenv/config';

import * as cheerio from 'cheerio';

import {
  buildAuthErrorView,
  buildBarsConnectingView,
  buildLoginPromptView,
  buildLogoutView,
  buildPasswordPromptView,
  buildTwoFactorPromptView,
} from '../src/bot/authView.js';
import {
  buildAttendanceView,
  buildGradesView,
  buildLibraryView,
  buildMoreHubView,
  buildOrdersView,
  buildOsepView,
  buildServiceErrorView,
} from '../src/bot/moreView.js';
import {
  buildConfirmDeleteView,
  buildHomeworkListView,
  buildImportantAddPromptView,
  buildImportantDetailView,
  buildImportantListView,
  buildSingleHomeworkDetailView,
} from '../src/bot/importantView.js';
import { buildMainScheduleView, buildSubjectDetailView } from '../src/bot/scheduleView.js';
import { RULE, RULE_CELL_WIDTH } from '../src/bot/format.js';
import { diffSnapshots, renderNotification } from '../src/services/notifications/barsNotifier.js';
import { renderNotification as _unused } from '../src/services/notifications/barsNotifier.js';
import type { ParsedSchedule } from '../src/parser/types.js';
import type { TelegramUser } from '../src/storage/userStore.js';
import type { UserSnapshot } from '../src/storage/snapshotStore.js';

void _unused;

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

/** Теги, которые Telegram понимает в HTML-режиме. */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'tg-emoji', 'code', 'pre',
  'blockquote',
]);

/**
 * Проверяет баланс тегов и допустимость имён.
 */
function validateHtml(text: string): { ok: boolean; error?: string } {
  const $ = cheerio.load(text, null, false);
  const stack: string[] = [];
  let error: string | undefined;

  $('*').each((_, el) => {
    const node = el as { tagName?: string; attribs?: Record<string, string> };
    const tag = (node.tagName ?? '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      error ??= `неизвестный тег <${tag}>`;
    }

    const attribs = node.attribs ?? {};
    if (tag === 'blockquote' && attribs.expandable === undefined && Object.keys(attribs).length > 0) {
      error ??= 'у blockquote неизвестный атрибут';
    }
  });

  // Ручной подсчёт парности: cheerio чинит разметку молча
  const tokens = text.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
  for (const token of tokens) {
    const isClosing = token.startsWith('</');
    const name = token.replace(/^<\/?/, '').split(/[\s>/]/)[0].toLowerCase();

    if (!ALLOWED_TAGS.has(name)) {
      error ??= `неизвестный тег <${name}>`;
      continue;
    }

    if (token.endsWith('/>')) continue;

    if (isClosing) {
      const last = stack.pop();
      if (last !== name) {
        error ??= `непарный тег: ожидался </${last ?? '—'}>, встречен </${name}>`;
      }
    } else {
      stack.push(name);
    }
  }

  if (stack.length > 0) {
    error ??= `незакрытые теги: ${stack.join(', ')}`;
  }

  return error ? { ok: false, error } : { ok: true };
}

/**
 * Ищет «сырые» спецсимволы вне тегов.
 *
 * Telegram сломает разметку на неэкранированном «<», а незакрытая «&»
 * превратит соседний текст в невидимую сущность. Оба случая — ошибка вёрстки.
 */
function findRawEntities(text: string): string[] {
  const withoutTags = text.replace(/<[^>]*>/g, '');

  const problems: string[] = [];

  // Неэкранированные угловые скобки
  const angles = withoutTags.match(/[<>]/g) ?? [];
  if (angles.length > 0) {
    problems.push(`неэкранированные < >: ${angles.length}`);
  }

  // «&», за которым не начинается корректная сущность
  const rawAmp = withoutTags.match(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-fA-F]+;)/g) ?? [];
  if (rawAmp.length > 0) {
    problems.push(`неэкранированные &: ${rawAmp.length}`);
  }

  return problems;
}

function auditAll(name: string, text: string): void {
  const result = validateHtml(text);
  check(`${name}: валидный HTML`, result.ok, result.error);

  const raw = findRawEntities(text);
  check(`${name}: спецсимволы экранированы`, raw.length === 0, raw.join('; '));
}

/* ------------------------------------------------------------------ */
/* Тестовые данные                                                      */
/* ------------------------------------------------------------------ */

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
          variants: [
            {
              discipline: 'Математический анализ',
              kindOfWork: 'Лекция',
              auditorium: 'Б-201',
              building: '',
              lecturerShort: 'доц. Иванов И.И.',
              lecturerFullName: 'Иванов Иван Иванович',
              allLecturers: [],
              jointGroups: [],
              onlineUrls: [],
              note: 'Вход &lt;по QR&gt;',
            },
          ],
        },
        {
          lessonNumber: 2,
          lessonNumberEnd: 2,
          timeStart: '10:15',
          timeEnd: '11:50',
          variants: [
            {
              discipline: 'Физика <лаб>',
              kindOfWork: 'Лабораторная работа',
              auditorium: 'Д-412',
              building: '',
              lecturerShort: 'доц. Сидоров С.С.',
              lecturerFullName: 'Сидоров Сергей Сергеевич',
              allLecturers: [],
              jointGroups: [],
              onlineUrls: [],
            },
          ],
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

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('   ПРОВЕРКА HTML-РАЗМЕТКИ ВСЕХ ЭКРАНОВ   ');
  console.log('====================================================');

  section('Воронка входа');
  auditAll('логин', buildLoginPromptView('Николай', 'Ошибка &lt;тест&gt;').text);
  auditAll('логин (без имени)', buildLoginPromptView().text);
  auditAll('пароль', buildPasswordPromptView('st<123>').text);
  auditAll('2FA', buildTwoFactorPromptView('на +7***-45').text);
  auditAll('2FA (без канала)', buildTwoFactorPromptView().text);
  auditAll('подключение', buildBarsConnectingView('st123456').text);
  auditAll('ошибка входа', buildAuthErrorView('Неверный код', 'st123').text);
  auditAll('выход', buildLogoutView().text);

  section('Расписание');
  auditAll('главный экран', buildMainScheduleView(schedule, '2026.10.08', user).text);
  auditAll('главный экран (без юзера)', buildMainScheduleView(schedule, '2026.10.08').text);
  auditAll('главный экран (пусто)', buildMainScheduleView({ ...schedule, days: [] }, undefined, user).text);
  auditAll('карточка пары', buildSubjectDetailView(schedule, '2026.10.08', 0).text);
  auditAll('карточка пары (не найдена)', buildSubjectDetailView(schedule, '2026.10.08', 99).text);

  section('Сервисы БАРС');
  auditAll('хаб «Остальное»', buildMoreHubView(user).text);

  auditAll(
    'оценки',
    buildGradesView({
      semesterName: '2026/2027, <Осенний>',
      isCurrent: true,
      subjects: [
        {
          discipline: 'Математика & <анализ>',
          lecturer: 'доц. Иванов И.И.',
          controlType: 'Экзамен',
          attestationRaw: 'зачёт с оценкой',
          controlPoints: [
            { number: 1, title: 'Матрицы', score: 5, weight: 50, week: '4' },
            { number: 2, title: 'Определители', score: null, weight: 50, week: '7' },
          ],
          weekScores: [],
          totalScore: 5,
        },
        {
          discipline: 'Физкультура',
          controlType: 'Зачет',
          attestationRaw: 'зачёт (без оценки)',
          controlPoints: [{ number: 1, title: 'ТБ', score: 4, weight: 100, week: '4' }],
          weekScores: [],
          totalScore: 4,
        },
      ],
    }).text,
  );

  auditAll(
    'оценки (пусто)',
    buildGradesView({ semesterName: '—', isCurrent: true, subjects: [] }).text,
  );

  auditAll(
    'пропуски',
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
          discipline: 'ОРГ & смежные',
          missedLessons: 2,
          excusedLessons: 0,
          unexcusedLessons: 2,
          totalMissedHours: 4,
          excusedHours: 0,
          unexcusedHours: 4,
        },
      ],
    }).text,
  );

  auditAll(
    'пропуски (без пропусков)',
    buildAttendanceView({
      totalMissedLessons: 0,
      totalExcusedLessons: 0,
      totalUnexcusedLessons: 0,
      totalMissed: 0,
      totalExcused: 0,
      totalUnexcused: 0,
      bySubject: [],
    }).text,
  );

  auditAll(
    'книги',
    buildLibraryView([
      { title: 'Математика <для> экономистов', author: 'Кремер Н.', issueDate: '01.09.2026', dueDate: '01.10.2026', isOverdue: true },
      { title: 'Физика', author: 'Иродов', issueDate: '01.09.2026', dueDate: '01.12.2026', isOverdue: false },
    ]).text,
  );
  auditAll('книги (пусто)', buildLibraryView([]).text);

  auditAll(
    'приказы',
    buildOrdersView(
      [{ number: '123&124', date: '01.09.2026', title: 'О зачислении <на 1 курс>' }],
      { isAppointed: true, type: 'академическая', period: '01.09.2026 — 31.01.2027' },
    ).text,
  );
  auditAll('приказы (пусто)', buildOrdersView([], { isAppointed: false }).text);

  auditAll(
    'ОСЭП',
    buildOsepView(
      [
        {
          uid: 1,
          date: new Date('2026-10-07T09:12:00'),
          from: 'Учебное управление <МЭИ>',
          fromAddress: 'ucheb@mpei.ru',
          subject: 'О пересдаче & уведомление',
          snippet: 'Уважаемый <студент>, ...',
          hasAttachments: true,
          attachmentNames: ['a.pdf'],
          isSeen: false,
        },
      ],
      3,
    ).text,
  );
  auditAll('ОСЭП (пусто)', buildOsepView([], 0).text);

  auditAll('ошибка сервиса', buildServiceErrorView('Оценки', 'HTTP error 503: <Service Unavailable>').text);

  section('ДЗ и объявления');
  auditAll('список ДЗ (пусто)', buildHomeworkListView('ИЭ-11-26').text);
  auditAll('список важного (пусто)', buildImportantListView('ИЭ-11-26').text);
  auditAll('добавление объявления', buildImportantAddPromptView().text);
  auditAll('объявление (не найдено)', buildImportantDetailView('нет-такого').text);
  auditAll('ДЗ (не найдено)', buildSingleHomeworkDetailView('нет-такого').text);
  auditAll('подтверждение удаления', buildConfirmDeleteView('hw', 'hw_1', 'Матан <п> №1-5').text);

  section('Уведомления нотификатора');
  {
    const prev: UserSnapshot = {
      gradesHash: { 'Математика_КТ1': 4 },
      lastSeenMailUid: 5,
      ordersCount: 1,
      scholarshipStatus: 'нет',
      lastCheckedAt: new Date().toISOString(),
    };
    const next: UserSnapshot = {
      gradesHash: { 'Математика_КТ1': 5 },
      lastSeenMailUid: 9,
      ordersCount: 2,
      scholarshipStatus: 'академическая',
      lastCheckedAt: new Date().toISOString(),
    };

    const events = diffSnapshots(prev, next, {
      mails: [
        {
          uid: 9,
          date: new Date(),
          from: 'Учебное <МЭИ>',
          subject: 'Тема & тест',
          hasAttachments: true,
        },
      ],
      orders: [{ number: '9', date: '01.09.2026', title: 'Приказ <тест>' }],
    });

    check('события сформированы', events.length === 4, `получено ${events.length}`);
    auditAll('уведомление', renderNotification(events));
  }

  section('Разделительные полосы: перенос на узких экранах');
  {
    // Символ ━ (U+2501) занимает 2 ячейки, поэтому линия в 22 символа — это 44 ячейки,
    // что заведомо шире пузыря сообщения на телефоне (~28-34 ячейки).
    const WORD_JOINER = '\u2060';

    const visible = [...RULE].filter((c) => c === '\u2501');
    const joins = [...RULE].filter((c) => c === WORD_JOINER);

    check('разделитель нарисован чертами U+2501', visible.length > 0, `символов: ${visible.length}`);
    check('длина линии <= 14 черт (28 ячеек)', visible.length <= 14, `символов: ${visible.length}`);
    check('ширина линии влезает в пузырь телефона', RULE_CELL_WIDTH <= 28, `ячеек: ${RULE_CELL_WIDTH}`);
    check('есть запас по ширине', 28 - RULE_CELL_WIDTH >= 2, `запас: ${28 - RULE_CELL_WIDTH}`);

    // Между каждой парой черт — WORD JOINER: он запрещает разрыв строки
    check('между чертами вставлен WORD JOINER', joins.length === visible.length - 1,
      `черт: ${visible.length}, склеек: ${joins.length}`);
    check('линия не начинается и не кончается WORD JOINER',
      RULE[0] === '\u2501' && RULE[RULE.length - 1] === '\u2501');

    // Разделитель должен состоять только из черты и склейки — никакого мусора
    const onlyGlyphs = [...RULE].every((c) => c === '\u2501' || c === WORD_JOINER);
    check('в линии только черты и WORD JOINER', onlyGlyphs);

    const allViews: [string, string][] = [
      ['вход: логин', buildLoginPromptView('Николай').text],
      ['вход: пароль', buildPasswordPromptView('st123').text],
      ['вход: 2FA', buildTwoFactorPromptView().text],
      ['вход: выход', buildLogoutView().text],
      ['главный экран', buildMainScheduleView(schedule, '2026.10.08', user).text],
      ['карточка пары', buildSubjectDetailView(schedule, '2026.10.08', 0).text],
      ['хаб «Остальное»', buildMoreHubView(user).text],
      ['оценки', buildGradesView({ semesterName: '—', isCurrent: true, subjects: [] }).text],
      ['пропуски', buildAttendanceView({
        totalMissedLessons: 1, totalExcusedLessons: 0, totalUnexcusedLessons: 1,
        totalMissed: 2, totalExcused: 0, totalUnexcused: 2,
        bySubject: [{ discipline: 'X', missedLessons: 1, excusedLessons: 0, unexcusedLessons: 1, totalMissedHours: 2, excusedHours: 0, unexcusedHours: 2 }],
      }).text],
      ['книги', buildLibraryView([{ title: 'Книга', issueDate: '01.09.2026', dueDate: '01.10.2026', isOverdue: false }]).text],
      ['приказы', buildOrdersView([{ number: '1', date: '01.09.2026', title: 'Приказ' }], { isAppointed: false }).text],
      ['ОСЭП', buildOsepView([{
        uid: 1, date: new Date(), from: 'A', fromAddress: 'a@b.ru', subject: 'T',
        snippet: '', hasAttachments: false, attachmentNames: [], isSeen: false,
      }]).text],
      ['список ДЗ', buildHomeworkListView('ИЭ-11-26').text],
      ['объявление', buildImportantDetailView('нет').text],
    ];

    for (const [name, text] of allViews) {
      // Других видов линий быть не должно
      const others = (text.match(/[─═]/g) ?? []).length;
      check(`${name}: только RULE, без других линий`, others === 0, `найдено: ${others}`);

      // Разделитель вставляется целиком, а не «как получится»
      const standalone = [...text].filter((c) => c === '\u2501').length;
      const expected = text.split(RULE).length - 1;
      check(`${name}: черт ровно столько, сколько вставлено RULE`,
        standalone === expected * visible.length,
        `символов: ${standalone}, вставок: ${expected}`);

      // Ни одна черта не должна болтаться вне RULE: последняя черта в самой
      // константе склейки не имеет, поэтому проверяем остаток текста.
      const outside = text.split(RULE).join('');
      const loose = [...outside].filter((c) => c === '\u2501').length;
      check(`${name}: черты только внутри готового RULE`, loose === 0, `вне: ${loose}`);
    }
  }

  section('Проверка кнопок');
  {
    const views = [
      ['главный', buildMainScheduleView(schedule, '2026.10.08', user)],
      ['хаб', buildMoreHubView(user)],
      ['карточка пары', buildSubjectDetailView(schedule, '2026.10.08', 0)],
      ['список ДЗ', buildHomeworkListView('ИЭ-11-26')],
      ['список важного', buildImportantListView('ИЭ-11-26')],
      ['пропуски', buildAttendanceView({
        totalMissedLessons: 0, totalExcusedLessons: 0, totalUnexcusedLessons: 0,
        totalMissed: 0, totalExcused: 0, totalUnexcused: 0, bySubject: [],
      })],
    ] as const;

    for (const [name, view] of views) {
      const all = view.keyboard.flat();
      const badStyle = all.filter((b) => b.style && !['danger', 'success', 'primary'].includes(b.style));
      check(`${name}: стили кнопок валидны`, badStyle.length === 0);

      const empty = all.filter((b) => !b.text.trim() || !b.callback_data.trim());
      check(`${name}: нет пустых кнопок`, empty.length === 0);

      // Красный закреплён только за «выйти» и «назад»
      const red = all.filter((b) => b.style === 'danger');
      const redAllowed = red.every((b) =>
        /Выйти|Назад|остальное|К расписанию|К важным|К списку ДЗ|Удалить|Отмена/.test(b.text),
      );
      check(`${name}: красный только для выхода/назад`, redAllowed,
        red.length > 0 ? red.map((b) => b.text).join(' | ') : undefined);

      const longText = all.filter((b) => b.text.length > 64);
      check(`${name}: подписи кнопок не длиннее 64 символов`, longText.length === 0,
        longText.length > 0 ? `длиннее: ${longText[0].text}` : undefined);
    }
  }

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Проверка HTML упала:', err);
  process.exit(1);
});