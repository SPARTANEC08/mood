import type { AttendanceSummary } from '../services/bars/parsers/attendanceParser.js';
import type {
  ControlPoint,
  SemesterGrades,
} from '../services/bars/parsers/gradesParser.js';
import type { LibraryBook, OrderItem, ScholarshipInfo } from '../services/bars/parsers/studentInfoParser.js';
import type { OsepMessage } from '../services/mail/types.js';
import { TelegramUser } from '../storage/userStore.ts';
import {
  b,
  esc,
  expandableQuote,
  fmtNum,
  i,
  link,
  quote,
  RULE,
  toneButton,
  truncate,
} from './format.ts';
import { buildSemesterReport, SubjectGradeReport } from './gradeCalculator.ts';
import { BotViewResult, formatStudentShortName, InlineButton, plural } from './scheduleView.ts';

/**
 * Кнопка возврата из сервисного экрана.
 *
 * Куда возвращаться — зависит от того, откуда раздел открыт:
 * - «Оценки» и «ОСЭП» висят в главном меню, поэтому назад — на расписание;
 * - «Пропуски», «Книги», «Приказы» живут в «Остальном», поэтому назад — туда.
 * Раньше все они возвращали в «Остальное», и выход из оценок уводил не туда.
 *
 * Красный закреплён за «назад» и «выйти» — чтобы их нельзя было спутать.
 */
function backRow(target: 'nav_menu' | 'nav_more' = 'nav_more'): InlineButton[] {
  const label = target === 'nav_menu' ? '◀️ К расписанию' : '◀️ В остальное';
  return [toneButton(label, 'back', target)];
}

/** Назад к расписанию: для разделов, открытых из главного меню. */
const BACK_TO_MENU = backRow('nav_menu');

/** Назад в «Остальное»: для разделов, открытых из «Остального». */
const BACK_ROW = backRow('nav_more');

/**
 * Экран «⚙️ Остальное» — хаб дополнительных сервисов и управления.
 */
export function buildMoreHubView(user: TelegramUser): BotViewResult {
  const fio = user.studentProfile?.fullName ?? user.firstName ?? 'Студент';
  const group = user.groupName ?? user.studentProfile?.groupName ?? '';

  const lines = [`🎛 ${b('Дополнительные сервисы')}`];

  lines.push(
    group
      ? `👤 ${esc(formatStudentShortName(fio))} ${i(`│ ${esc(group)}`)}`
      : `👤 ${esc(formatStudentShortName(fio))}`,
  );

  lines.push('', RULE);
  lines.push(
    i('Управление сессией БАРС, справки и документы'),
  );

  return {
    text: lines.join('\n'),
    keyboard: [
      [
        toneButton('📖 Домашние задания', 'homework', 'nav_dz'),
        toneButton('⭐ Важное', 'important', 'nav_important'),
      ],
      [
        toneButton('📉 Пропуски', 'attendance', 'svc_attendance'),
        toneButton('📚 Книги (НТБ)', 'library', 'svc_library'),
      ],
      [
        toneButton('📜 Приказы и стипендия', 'orders', 'svc_orders'),
        toneButton('🔄 Обновить сессию', 'session', 'auth_refresh_session'),
      ],
      [toneButton('🚪 Выйти из аккаунта БАРС', 'logout', 'auth_logout')],
      [toneButton('◀️ Назад к расписанию', 'back', 'nav_menu')],
    ],
  };
}

/**
 * Экран ошибки сервиса с кнопкой возврата.
 */
export function buildServiceErrorView(serviceName: string, error: string): BotViewResult {
  // Назад ведёт туда же, откуда открыли раздел: оценки и ОСЭП — с главного меню,
  // остальные — из «Остального».
  const target: 'nav_menu' | 'nav_more' =
    serviceName === 'Оценки' || serviceName === 'ОСЭП' ? 'nav_menu' : 'nav_more';
  const backLabel = target === 'nav_menu' ? '◀️ К расписанию' : '◀️ В остальное';

  return {
    text: [
      `⚠️ ${b(esc(serviceName))}`,
      '',
      quote(esc(truncate(error, 240))),
    ].join('\n'),
    keyboard: [
      [
        toneButton('🔄 Повторить', 'session', serviceRetryCallback(serviceName)),
        toneButton(backLabel, 'back', target),
      ],
    ],
  };
}

/**
 * Маппинг названия сервиса на callback для кнопки «Повторить».
 */
function serviceRetryCallback(serviceName: string): string {
  switch (serviceName) {
    case 'Оценки':
      return 'svc_grades';
    case 'Пропуски':
      return 'svc_attendance';
    case 'Книги':
      return 'svc_library';
    case 'Приказы и стипендия':
      return 'svc_orders';
    case 'ОСЭП':
      return 'svc_osep';
    default:
      return 'nav_more';
  }
}

/**
 * Тип контроля словами, как его показывает ЛК.
 */
function attestationLabel(report: SubjectGradeReport): string {
  const raw = (report.attestationRaw ?? '').toLowerCase();
  if (raw.includes('зачёт (без оценки)') || raw.includes('зачет (без оценки)')) {
    return 'зачёт';
  }
  if (raw.includes('зачёт с оценкой') || raw.includes('зачет с оценкой')) {
    return 'зачёт с оценкой';
  }
  if (raw.includes('экзамен')) return 'экзамен';
  return report.controlType === 'Неизвестно' ? '' : report.controlType;
}

/**
 * Значок среднего балла: зелёный — отлично, жёлтый — хорошо,
 * оранжевый — удовлетворительно, красный — неудовлетворительно.
 */
function averageIcon(avg: number | null): string {
  if (avg === null) return '⚪';
  if (avg >= 4.5) return '🟢';
  if (avg >= 3.5) return '🟡';
  if (avg >= 2.5) return '🟠';
  return '🔴';
}

/**
 * Список КМ дисциплины в сворачиваемой цитате.
 */
function buildKmBlock(points: ControlPoint[], gradedCount: number): string {
  const lines: string[] = [];

  points.forEach((p) => {
    const score = p.score === null ? i('—') : b(String(p.score));
    const weight = typeof p.weight === 'number' ? `${p.weight}%` : '';
    const when = p.week ? ` · нед. ${esc(p.week)}` : '';
    lines.push(`КМ${p.number}  ${score}  ${i(`вес ${weight}`)}${when}`);
  });

  lines.push('');
  lines.push(i(`Закрыто ${gradedCount} из ${points.length} КМ`));

  return expandableQuote(lines.join('\n'));
}

/**
 * Экран оценок: средний балл по дисциплинам и список КМ с весами.
 *
 * Формат строки: «Математика (зачёт с оценкой) — 4,5»
 * Ниже идёт сворачиваемый блок с КМ и их весами.
 */
export function buildGradesView(grades: SemesterGrades): BotViewResult {
  const reports = buildSemesterReport(grades.subjects);

  const lines: string[] = [
    `📊 ${b('Оценки')}  ${i(esc(truncate(grades.semesterName, 40)))}`,
  ];

  if (reports.length === 0) {
    lines.push('', quote('Данных по успеваемости не найдено.'));
    return { text: lines.join('\n'), keyboard: [BACK_TO_MENU] };
  }

  for (const report of reports) {
    const type = attestationLabel(report);
    const avg = fmtNum(report.currentAverage);
    const title = type
      ? `${esc(truncate(report.discipline, 38))} ${i(`(${esc(type)})`)}`
      : esc(truncate(report.discipline, 44));

    lines.push('', RULE);
    lines.push(`${averageIcon(report.currentAverage)} ${title} — ${b(avg)}`);

    if (report.finalGrade) {
      lines.push(`${i('Итоговая оценка:')} ${esc(report.finalGrade)}`);
    }

    const kmBlock = buildKmBlock(report.controlPoints, report.gradedCount);
    if (kmBlock) {
      lines.push(kmBlock);
    }
  }

  return { text: lines.join('\n'), keyboard: [BACK_TO_MENU] };
}

/**
 * Экран пропусков.
 *
 * БАРС считает пропуски в парах; одна пара = 2 академических часа,
 * поэтому в интерфейсе показываются и пары, и часы.
 */
export function buildAttendanceView(attendance: AttendanceSummary): BotViewResult {
  const lines: string[] = [`📉 ${b('Пропуски')}`];

  if (attendance.lastUpdated) {
    lines.push(i(`Состояние на ${esc(attendance.lastUpdated)}`));
  }

  const card = [
    `⏱ Пропущено пар: ${b(String(attendance.totalMissedLessons))}`,
    `⏳ В академ. часах: ${b(`${attendance.totalMissed} ч.`)}`,
    `   уважительных: ${attendance.totalExcused} ч.`,
    `   без уважительной: ${attendance.totalUnexcused} ч.`,
  ];
  lines.push('', quote(card.join('\n')));

  const withMisses = attendance.bySubject.filter((s) => s.missedLessons > 0);

  if (withMisses.length === 0) {
    lines.push('', '🎉 ' + b('Пропусков нет'));
    return { text: lines.join('\n'), keyboard: [BACK_ROW] };
  }

  lines.push('', RULE);
  withMisses.forEach((s) => {
    lines.push(`• ${esc(truncate(s.discipline, 40))}`);
    lines.push(`   ${s.missedLessons} ${plural(s.missedLessons, 'пара', 'пары', 'пар')} = ${s.totalMissedHours} ч.`);
    if (s.excusedLessons > 0) {
      lines.push(`   уважительных: ${s.excusedLessons} ${plural(s.excusedLessons, 'пара', 'пары', 'пар')} (${s.excusedHours} ч.)`);
    }
  });

  return { text: lines.join('\n'), keyboard: [BACK_ROW] };
}

/**
 * Экран книг, выданных НТБ МЭИ.
 */
export function buildLibraryView(books: LibraryBook[]): BotViewResult {
  const lines: string[] = [`📚 ${b('Книги (НТБ)')}`];

  if (books.length === 0) {
    lines.push('', quote('Книг на руках нет.'));
    return { text: lines.join('\n'), keyboard: [BACK_ROW] };
  }

  const overdue = books.filter((bk) => bk.isOverdue);
  const total = `${books.length} ${plural(books.length, 'книга', 'книги', 'книг')}`;

  lines.push('', i(`На руках: ${total}`));

  if (overdue.length > 0) {
    lines.push(
      `⚠️ ${b(`Просрочено: ${overdue.length} ${plural(overdue.length, 'книга', 'книги', 'книг')}`)}`,
    );
  }

  lines.push('');

  const cards = books.map((bk) => {
    const meta: string[] = [];
    if (bk.author) meta.push(esc(truncate(bk.author, 50)));
    if (bk.dueDate) {
      meta.push(`срок ${esc(bk.dueDate)}${bk.isOverdue ? ' · просрочен' : ''}`);
    }
    const head = `${bk.isOverdue ? '⚠️' : '📗'} ${b(esc(truncate(bk.title, 70)))}`;
    return meta.length > 0 ? `${head}\n${i(`   ${meta.join(' · ')}`)}` : head;
  });

  // Одна книга показывается целиком, несколько — сворачиваются
  lines.push(cards.length === 1 ? cards[0] : expandableQuote(cards.join('\n\n')));

  return { text: lines.join('\n'), keyboard: [BACK_ROW] };
}

/**
 * Экран приказов и стипендии.
 */
export function buildOrdersView(orders: OrderItem[], scholarship: ScholarshipInfo): BotViewResult {
  const lines: string[] = [`📜 ${b('Приказы и стипендия')}`];

  lines.push('', RULE);

  if (scholarship.isAppointed) {
    const parts = [scholarship.type, scholarship.period, scholarship.amount].filter(Boolean);
    lines.push(`🎓 ${b('Стипендия назначена')}`);
    if (parts.length > 0) {
      lines.push(i(esc(truncate(parts.join(' · '), 70))));
    }
  } else {
    lines.push(`🎓 ${b('Стипендия не назначена')}`);
  }

  lines.push('', RULE);

  if (orders.length === 0) {
    lines.push(quote('Приказы не найдены.'));
    return { text: lines.join('\n'), keyboard: [BACK_ROW] };
  }

  lines.push(`Всего ${b(`${orders.length} ${plural(orders.length, 'приказ', 'приказа', 'приказов')}`)}`);

  const items = orders.slice(0, 8).map((o, idx) => {
    const num = o.number ? `№${esc(o.number)}` : '';
    const date = o.date ? ` ${i(`от ${esc(o.date)}`)}` : '';
    return `${b(`${idx + 1}.`)} ${num}${date}\n${esc(truncate(o.title, 70))}`;
  });

  lines.push('', expandableQuote(items.join('\n\n')));

  if (orders.length > 8) {
    lines.push(i(`Показаны первые 8 из ${orders.length}`));
  }

  return { text: lines.join('\n'), keyboard: [BACK_ROW] };
}

/**
 * Веб-интерфейс почты ОСЭП (Exchange OWA).
 *
 * Отдельная константа, потому что проверить адрес не удалось: mail.mpei.ru
 * отдаёт 401 на все пути, включая существующие, поэтому отличить рабочий
 * путь от несуществующего без входа в почту невозможно. Значение вынесено
 * сюда, чтобы заменить его в одном месте, если адрес окажется другим.
 */
const OSEP_WEB_URL = 'https://mail.mpei.ru/owa/';

/**
 * Экран последних писем ОСЭП.
 */
export function buildOsepView(messages: OsepMessage[], totalUnread?: number): BotViewResult {
  const lines: string[] = [`📬 ${b('ОСЭП')}`];

  if (totalUnread !== undefined) {
    lines.push(i(`Непрочитанных: ${totalUnread}`));
  }

  // Ссылка не заворачивается в i(): курсив экранирует теги, и <a> превратился
  // бы в текст «&lt;a href...&gt;» — Telegram счёл бы такое сообщение битым.
  lines.push('', link(OSEP_WEB_URL, 'Открыть почту в браузере'));

  lines.push('', RULE);

  if (messages.length === 0) {
    lines.push(quote('Непрочитанных писем нет. ✉️'));
    return { text: lines.join('\n'), keyboard: [BACK_TO_MENU] };
  }

  messages.forEach((m) => {
    const dd = String(m.date.getDate()).padStart(2, '0');
    const mm = String(m.date.getMonth() + 1).padStart(2, '0');
    const att = m.hasAttachments ? '  📎' : '';

    lines.push(`${b(`${dd}.${mm}`)}  ${b(esc(truncate(m.subject, 55)))}${att}`);
    lines.push(i(`   ${esc(truncate(m.from, 45))}`));

    if (m.snippet) {
      lines.push(`   ${esc(truncate(m.snippet, 110))}`);
    }
    lines.push('');
  });

  return { text: lines.join('\n'), keyboard: [BACK_TO_MENU] };
}
