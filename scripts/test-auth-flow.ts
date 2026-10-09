/**
 * Smoke-тесты новой воронки входа, главного экрана и хаба «Остальное».
 * Запуск: npx tsx scripts/test-auth-flow.ts
 */

import 'dotenv/config';

import { decrypt, encrypt, isEncryptionConfigured } from '../src/utils/crypto.ts';
import { buildLoginPromptView, buildPasswordPromptView, buildTwoFactorPromptView } from '../src/bot/authView.ts';
import { buildMainScheduleView, formatStudentShortName } from '../src/bot/scheduleView.ts';
import { buildMoreHubView } from '../src/bot/moreView.ts';
import { buildGradesView, buildAttendanceView } from '../src/bot/moreView.ts';
import { processTelegramCallback, processTelegramMessage } from '../src/bot/botEngine.ts';
import { homeworkStore } from '../src/storage/homeworkStore.ts';
import { RULE } from '../src/bot/format.ts';
import { userStore, isBarsAuthorized, type TelegramUser } from '../src/storage/userStore.ts';
import { readBarsCredentials } from '../src/bot/authFlow.ts';
import type { ParsedSchedule } from '../src/parser/types.ts';

const TEST_ID = 999_000_111;

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

const fakeSchedule: ParsedSchedule = {
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
              discipline: 'Линейная алгебра',
              kindOfWork: 'Практическое занятие',
              auditorium: 'Б-305',
              building: '',
              lecturerShort: 'пр. Петров П.П.',
              lecturerFullName: 'Петров Пётр Петрович',
              allLecturers: [],
              jointGroups: [],
              onlineUrls: [],
            },
          ],
        },
        {
          lessonNumber: 3,
          lessonNumberEnd: 3,
          timeStart: '12:45',
          timeEnd: '14:20',
          variants: [
            {
              discipline: 'Информационные технологии',
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
    {
      date: '09.10.2026',
      rawDate: '2026.10.09',
      dayOfWeek: 5,
      dayName: 'Пятница',
      dayShort: 'Пт',
      slots: [
        {
          lessonNumber: 1,
          lessonNumberEnd: 1,
          timeStart: '08:30',
          timeEnd: '10:05',
          variants: [
            {
              discipline: 'История России',
              kindOfWork: 'Лекция',
              auditorium: 'А-101',
              building: '',
              lecturerShort: 'доц. Кузнецов К.К.',
              lecturerFullName: 'Кузнецов Кирилл Кириллович',
              allLecturers: [],
              jointGroups: [],
              onlineUrls: [],
            },
          ],
        },
      ],
    },
    {
      date: '12.10.2026',
      rawDate: '2026.10.12',
      dayOfWeek: 1,
      dayName: 'Понедельник',
      dayShort: 'Пн',
      slots: [
        {
          lessonNumber: 1,
          lessonNumberEnd: 1,
          timeStart: '08:30',
          timeEnd: '10:05',
          variants: [
            {
              discipline: 'Физическая культура',
              kindOfWork: 'Практическое занятие',
              auditorium: 'Спортзал',
              building: '',
              lecturerShort: 'Смирнов С.С.',
              lecturerFullName: 'Смирнов Сергей Сергеевич',
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

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('   SMOKE-ТЕСТЫ: ВХОД ЧЕРЕЗ БАРС + НОВОЕ ГЛАВНОЕ МЕНЮ   ');
  console.log('====================================================');

  section('Крипто (AES-256-GCM)');
  check('ключ настроен', isEncryptionConfigured());
  const enc = encrypt('st123456');
  check('IV = 12 байт', Buffer.from(enc.iv, 'base64').length === 12);
  check('auth tag = 16 байт', Buffer.from(enc.tag, 'base64').length === 16);
  check('шифротекст != открытый текст', !enc.encryptedData.includes('st123456'));
  check('round-trip decrypt', decrypt(enc.encryptedData, enc.iv, enc.tag) === 'st123456');
  const enc2 = encrypt('st123456');
  check('IV уникален для каждого вызова', enc.iv !== enc2.iv);

  let tampered = false;
  try {
    const bad = Buffer.from(enc.encryptedData, 'base64');
    bad[0] ^= 0xff;
    decrypt(bad.toString('base64'), enc.iv, enc.tag);
  } catch {
    tampered = true;
  }
  check('подмена шифротекста обнаруживается (GCM tag)', tampered);

  section('Экраны воронки');
  const loginView = buildLoginPromptView('Николай');
  check('экран логина содержит приветствие', loginView.text.includes('👋 <b>Добро пожаловать в Zbot!</b>'));
  check('экран логина содержит подсказку', loginView.text.includes('Введите <b>логин</b>'));
  check('экран логина пример в курсиве', loginView.text.includes('<i>   например: st123456</i>'));

  const passView = buildPasswordPromptView('st123456');
  check('экран пароля показывает логин', passView.text.includes('🔒 Логин: <b>st123456</b>'));
  check('экран пароля предупреждает об удалении', passView.text.includes('удалено сразу после отправки'));
  check('экран пароля цитатой', passView.text.includes('<blockquote>'));

  const twoFaView = buildTwoFactorPromptView('на телефон');
  check('экран 2FA содержит заголовок', twoFaView.text.includes('📲 <b>Двухфакторная аутентификация</b>'));
  check('экран 2FA содержит канал', twoFaView.text.includes('на телефон'));
  check('экран 2FA запрашивает код', twoFaView.text.includes('Введите <b>код</b>'));

  section('Главный экран расписания');
  const fakeUser = {
    telegramId: TEST_ID,
    firstName: 'Николай',
    registeredAt: new Date().toISOString(),
    groupName: 'ИЭ-11-26',
    groupId: 21985,
    studentProfile: { fullName: 'Лысенко Николай Романович' },
    barsAuth: {
      encryptedLogin: 'x',
      encryptedPass: 'y',
      iv: 'z',
      tag: 't',
      cookiesJson: '{}',
    },
  };

  const main = buildMainScheduleView(fakeSchedule, '2026.10.08', fakeUser);
  const textLines = main.text.split('\n');
  check('дата в шапке жирным', textLines[0] === '📅 <b>08.10.2026 (Четверг)</b>');
  check('студент в шапке курсивом', textLines[1] === '👤 <i>Лысенко Н.Р.</i> │ ИЭ-11-26');
  check('в тексте НЕ дублируется список пар', !main.text.includes('Матан'));
  check('есть разделитель и итог дня', main.text.includes(RULE) && main.text.includes('<b>3 пары</b>'));
  check('итог дня показывает окно занятий', main.text.includes('<i>08:30–14:20</i>'));

  const flatButtons = main.keyboard.flat();
  const texts = flatButtons.map((b) => b.text);

  check('кнопка 1-й пары', texts.some((t) => t.includes('08:30–10:05') && t.includes('Матан')));
  check('кнопка 2-й пары', texts.some((t) => t.includes('10:15–11:50') && t.includes('Линал')));
  check('кнопка 3-й пары', texts.some((t) => t.includes('12:45–14:20') && t.includes('Информатика')));

  const lunchIdx = texts.findIndex((t) => t.includes('Обед'));
  const lesson3Idx = texts.findIndex((t) => t.includes('12:45–14:20'));
  const lesson1Idx = texts.findIndex((t) => t.includes('08:30–10:05'));
  const lesson2Idx = texts.findIndex((t) => t.includes('10:15–11:50'));
  check('обед между 2 и 3 парой', lesson1Idx < lesson2Idx && lesson2Idx < lunchIdx && lunchIdx < lesson3Idx);

  const navRow = main.keyboard.find((row) => row.some((b) => b.text.includes('Сегодня')));
  check('ряд навигации: Сегодня', Boolean(navRow));
  // На первом дне расписания кнопки «предыдущий день» нет — это ожидаемо
  check('на первом дне только «Сегодня» и «вперёд»', (navRow?.length ?? 0) === 2);

  // На среднем дне ряд навигации полный: ◀️ Пн | 🗓 Сегодня | Ср ▶️
  const midView = buildMainScheduleView(fakeSchedule, '2026.10.09', fakeUser);
  const midNav = midView.keyboard.find((row) => row.some((b) => b.text.includes('Сегодня')));
  check('ряд навигации: 3 кнопки на среднем дне', (midNav?.length ?? 0) === 3);
  check('навигация: ◀️ предыдущий день', midNav?.[0].text.includes('◀️') === true);
  check('навигация: следующий день ▶️', midNav?.[2].text.includes('▶️') === true);

  const quickRow = main.keyboard.find((row) => row.some((b) => b.callback_data === 'svc_grades'));
  check('ряд быстрого доступа: Оценки + ОСЭП', quickRow?.length === 2);
  check('ОСЭП в быстром ряду', quickRow?.some((b) => b.callback_data === 'svc_osep') === true);

  const lastRow = main.keyboard[main.keyboard.length - 1];
  check('нижний ряд: Остальное', lastRow.length === 1 && lastRow[0].callback_data === 'nav_more');
  check('нижний ряд с цветовым тоном', lastRow[0].text.includes('⚙️'));
  check('порядок рядов соблюдён', main.keyboard.indexOf(navRow!) < main.keyboard.indexOf(quickRow!));

  // Значок ДЗ 📝 на паре, к которой привязано домашнее задание
  homeworkStore.save({
    id: 'hw_smoke_1',
    groupName: 'ИЭ-11-26',
    discipline: 'Математический анализ',
    kind: 'lecture',
    targetDate: '2026.10.08',
    lessonNumber: 1,
    timeStart: '08:30',
    text: '№1-5 стр.20',
    files: [],
    createdAt: new Date().toISOString(),
  });

  const mainWithHw = buildMainScheduleView(fakeSchedule, '2026.10.08', fakeUser);
  const hwButton = mainWithHw.keyboard.flat().find((b) => b.text.includes('08:30–10:05'));
  check('значок ДЗ 📝 на кнопке пары', hwButton?.text.includes('📝') === true);
  check('в тексте пары нет — только в кнопке', !mainWithHw.text.includes('📝'));

  homeworkStore.delete('hw_smoke_1');

  section('Хаб «Остальное»');
  const more = buildMoreHubView(fakeUser);
  check('заголовок хаба', more.text.startsWith('🎛 <b>Дополнительные сервисы</b>'));
  check('студент в хабе', more.text.includes('👤 Лысенко Н.Р.') && more.text.includes('ИЭ-11-26'));
  check('хаб: разделитель', more.text.includes(RULE));
  check('5 рядов кнопок', more.keyboard.length === 5);
  check('ДЗ + Важное', more.keyboard[0].some((b) => b.callback_data === 'nav_dz') && more.keyboard[0].some((b) => b.callback_data === 'nav_important'));
  check('Пропуски + Книги', more.keyboard[1].some((b) => b.callback_data === 'svc_attendance') && more.keyboard[1].some((b) => b.callback_data === 'svc_library'));
  check('Приказы + Обновить сессию', more.keyboard[2].some((b) => b.callback_data === 'svc_orders') && more.keyboard[2].some((b) => b.callback_data === 'auth_refresh_session'));
  check('Выход из БАРС', more.keyboard[3][0].callback_data === 'auth_logout');
  check('Назад к расписанию', more.keyboard[4][0].callback_data === 'nav_menu');

  section('Сервисные экраны');
  const grades = buildGradesView({
    semesterName: '2026/2027, Осенний семестр',
    isCurrent: true,
    subjects: [
      {
        discipline: 'Математический анализ',
        lecturer: 'доц. Иванов И.И.',
        controlType: 'Экзамен',
        attestationRaw: 'зачёт с оценкой',
        controlPoints: [
          { number: 1, title: 'Матрицы', score: 5, weight: 50, week: '4' },
          { number: 2, title: 'Определители', score: 4, weight: 50, week: '7' },
          { number: 3, title: 'Пределы', score: null, weight: 50, week: '12' },
        ],
        weekScores: [],
        totalScore: 4.5,
      },
    ],
  });
  check('экран оценок: семестр', grades.text.includes('Осенний семестр'));
  check('экран оценок: название (зачёт с оценкой)', grades.text.includes('Математический анализ <i>(зачёт с оценкой)</i>'));
  check('экран оценок: средний 4,5', grades.text.includes('— <b>4,5</b>'));
  check('экран оценок: только средний, без прогнозов', !grades.text.includes('До автомата'));
  check('экран оценок: сворачиваемый блок КМ', grades.text.includes('<blockquote expandable>'));
  check('экран оценок: КМ с весом', grades.text.includes('КМ1  <b>5</b>  <i>вес 50%</i>'));
  check('экран оценок: незакрытый КМ', grades.text.includes('КМ3  <i>—</i>'));
  check('в заголовке оценок НЕТ порогов автомата', !grades.text.split('\n')[0].includes('Автомат'));
  check('в оценках НЕТ упоминаний автомата', !grades.text.includes('втомат'));

  check('из оценок назад на расписание', grades.keyboard[0][0].text === '◀️ К расписанию');
  check('из оценок callback = nav_menu', grades.keyboard[0][0].callback_data === 'nav_menu');

  const att = buildAttendanceView({
    totalMissedLessons: 6,
    totalExcusedLessons: 4,
    totalUnexcusedLessons: 2,
    totalMissed: 12,
    totalExcused: 8,
    totalUnexcused: 4,
    bySubject: [
      {
        discipline: 'Матан',
        missedLessons: 6,
        excusedLessons: 4,
        unexcusedLessons: 2,
        totalMissedHours: 12,
        excusedHours: 8,
        unexcusedHours: 4,
      },
    ],
  });
  check('экран пропусков: пары', att.text.includes('Пропущено пар: <b>6</b>'));
  check('экран пропусков: часы (пары × 2)', att.text.includes('академ. часах: <b>12 ч.</b>'));
  check('экран пропусков: по дисциплине', att.text.includes('Матан'));
  check('экран пропусков: цитата', att.text.includes('<blockquote>'));

  section('Шифрование учётных данных');
  const encLogin = encrypt('st123456');
  const encPass = encrypt('SuperSecret123');
  check('логин и пароль шифруются разными IV', encLogin.iv !== encPass.iv);
  check('логин расшифровывается', decrypt(encLogin.encryptedData, encLogin.iv, encLogin.tag) === 'st123456');
  check('пароль расшифровывается', decrypt(encPass.encryptedData, encPass.iv, encPass.tag) === 'SuperSecret123');

  const credUser: TelegramUser = {
    telegramId: 42,
    firstName: 'Тест',
    registeredAt: new Date().toISOString(),
    barsAuth: {
      encryptedLogin: encLogin.encryptedData,
      encryptedPass: encPass.encryptedData,
      iv: encLogin.iv,
      tag: encLogin.tag,
      ivPass: encPass.iv,
      tagPass: encPass.tag,
      cookiesJson: '{}',
    },
  };
  const creds = readBarsCredentials(credUser);
  check('readBarsCredentials: логин', creds.login === 'st123456');
  check('readBarsCredentials: пароль', creds.password === 'SuperSecret123');

  section('Гейт авторизации в botEngine');
  userStore.ensureUser(TEST_ID, { firstName: 'Тест', authState: 'AWAIT_LOGIN' });
  userStore.clearAuth(TEST_ID);

  const sender = { id: TEST_ID, firstName: 'Тест', lastName: '', username: 'tester' };

  const startRes = await processTelegramMessage(sender, '/start');
  check('/start без авторизации -> need_login', startRes.status === 'need_login');
  check('/start -> экран логина', startRes.messageText.includes('Введите <b>логин</b>'));
  check('/start удаляет входящее сообщение', startRes.deleteIncoming === true);
  check('поле authState = AWAIT_LOGIN', userStore.get(TEST_ID)?.authState === 'AWAIT_LOGIN');

  const loginRes = await processTelegramMessage(sender, 'st123456');
  check('ввод логина -> экран пароля', loginRes.messageText.includes('🔒 Логин: <b>st123456</b>'));
  check('логин сохранён', userStore.get(TEST_ID)?.tempAuthData?.login === 'st123456');
  check('authState = AWAIT_PASSWORD', userStore.get(TEST_ID)?.authState === 'AWAIT_PASSWORD');

  // Пустой ввод на шаге пароля возвращает на экран логина (без обращения к БАРС)
  const backToLogin = await processTelegramMessage(sender, '/start');
  check('/start на шаге пароля -> экран логина', backToLogin.messageText.includes('Введите <b>логин</b>'));
  check('authState сброшен в AWAIT_LOGIN', userStore.get(TEST_ID)?.authState === 'AWAIT_LOGIN');

  const cbBlocked = await processTelegramCallback(sender, 'nav_menu');
  check('клик по кнопке без авторизации блокируется', cbBlocked.status === 'need_login');
  check('клик ведёт на экран логина', cbBlocked.messageText.includes('Введите <b>логин</b>'));

  const hzBlocked = await processTelegramMessage(sender, 'дай расписание на завтра');
  check('текст без авторизации трактуется как логин', hzBlocked.status === 'need_login');

  section('Авторизованный пользователь');
  userStore.patch(TEST_ID, {
    barsAuth: {
      encryptedLogin: enc.encryptedData,
      encryptedPass: encrypt('secret-pass').encryptedData,
      iv: enc.iv,
      tag: enc.tag,
      cookiesJson: JSON.stringify({ cookies: null, finalUrl: '/bars_web/ST_Study/Main/Main' }),
      savedAt: new Date().toISOString(),
    },
    studentProfile: { fullName: 'Лысенко Николай Романович' },
    groupName: 'ИЭ-11-26',
    groupId: 21985,
    authState: null,
    tempAuthData: undefined,
  });
  check('isBarsAuthorized = true', isBarsAuthorized(userStore.get(TEST_ID)));

  const moreCb = await processTelegramCallback(sender, 'nav_more');
  check('клик «Остальное» доступен', moreCb.status === 'registered');
  check('клик «Остальное» -> хаб', moreCb.messageText.includes('🎛 <b>Дополнительные сервисы</b>'));
  check('хаб: 5 рядов', moreCb.keyboard?.length === 5);

  // Сервисный раздел с битой сессией не роняет бота, а возвращает экран входа
  const svcRes = await processTelegramCallback(sender, 'svc_grades');
  check('сервис с битой сессией -> need_login', svcRes.status === 'need_login');
  check('сервис с битой сессией -> экран входа', svcRes.messageText.includes('Введите <b>логин</b>'));
  check('после сервиса barsAuth удалён', userStore.get(TEST_ID)?.barsAuth === undefined);

  userStore.clearAuth(TEST_ID);
  check('после logout barsAuth удалён', userStore.get(TEST_ID)?.barsAuth === undefined);
  check('после logout профиль удалён', userStore.get(TEST_ID)?.studentProfile === undefined);
  check('после logout authState = AWAIT_LOGIN', userStore.get(TEST_ID)?.authState === 'AWAIT_LOGIN');

  // Чистим тестового пользователя
  userStore.remove(TEST_ID);
  check('тестовый пользователь удалён из users.json', userStore.get(TEST_ID) === undefined);

  section('Хранилище: patch/clearAuth');
  userStore.save({ telegramId: TEST_ID, firstName: 'Тест', registeredAt: new Date().toISOString(), groupName: 'ИЭ-11-26', groupId: 1 });
  userStore.patch(TEST_ID, { tempAuthData: { login: 'st1' } });
  check('patch сохраняет tempAuthData', userStore.get(TEST_ID)?.tempAuthData?.login === 'st1');
  userStore.patch(TEST_ID, { tempAuthData: undefined });
  check('patch c undefined удаляет поле', userStore.get(TEST_ID)?.tempAuthData === undefined);
  check('patch не затирает другие поля', userStore.get(TEST_ID)?.groupName === 'ИЭ-11-26');
  userStore.patch(TEST_ID, { barsAuth: { encryptedLogin: 'a', encryptedPass: 'b', iv: 'c', tag: 'd', cookiesJson: '{}' } });
  userStore.clearAuth(TEST_ID);
  check('clearAuth чистит barsAuth и профиль', userStore.get(TEST_ID)?.barsAuth === undefined && userStore.get(TEST_ID)?.studentProfile === undefined);
  check('clearAuth ставит AWAIT_LOGIN', userStore.get(TEST_ID)?.authState === 'AWAIT_LOGIN');
  userStore.remove(TEST_ID);

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Smoke-тесты упали:', err);
  process.exit(1);
});