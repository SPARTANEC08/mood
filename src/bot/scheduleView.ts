import { ParsedSchedule, ParsedScheduleDay } from '../parser/types.ts';
import { homeworkStore, TelegramFileRef } from '../storage/homeworkStore.ts';
import { TelegramUser } from '../storage/userStore.ts';
import { normalizeRawDate, toMoscow } from '../utils/time.ts';
import { b, esc, expandableQuote, i, RULE, toneButton, Tone, truncate } from './format.ts';

export interface InlineButton {
  text: string;
  callback_data: string;
  /** Цвет кнопки Telegram: danger (красный), success (зелёный), primary (синий) */
  style?: 'danger' | 'success' | 'primary';
}

export interface BotViewResult {
  text: string;
  keyboard: InlineButton[][];
  filesToSend?: TelegramFileRef[];
}

/**
 * Сокращает любые длинные названия предметов в ультракомпактные понятные формы
 */
export function formatDisciplineShortName(name: string): string {
  const clean = (name || '').trim();
  const lower = clean.toLowerCase();

  // Государственность и общие курсы
  if (lower.includes('российской государственности')) return 'ОРГ';
  if (lower.includes('профессиональной деятельности')) return 'ОПД';
  if (lower.includes('безопасность жизнедеятельности')) return 'БЖД';

  // Физкультура
  if (lower.includes('физическ') || lower.includes('физкультур') || lower.includes('спорт')) return 'Физ-ра';

  // Языки
  if (lower.includes('иностранный язык') || lower.includes('английский')) return 'Иняз';

  // Математика
  if (lower.includes('математический анализ') || lower.includes('высшая математика') || lower === 'математика') return 'Матан';
  if (lower.includes('линейная алгебра') || lower.includes('аналитическая геометрия')) return 'Линал';
  if (lower.includes('дифференциальные уравнения')) return 'Диффуры';
  if (lower.includes('теория вероятностей')) return 'Тервер';
  if (lower.includes('дискретная математика')) return 'Дискретка';

  // IT и программирование
  if (lower.includes('информационные технологии') || lower.includes('информатика')) return 'Информатика';
  if (lower.includes('языки программирования') || lower.includes('программирование')) return 'Прога';
  if (lower.includes('вычислительные системы') || lower.includes('архитектура')) return 'АВС';
  if (lower.includes('базы данных')) return 'БД';
  if (lower.includes('операционные системы')) return 'ОС';
  if (lower.includes('компьютерные сети')) return 'Сети';

  // Инженерия и физика
  if (lower.includes('теоретические основы электротехники')) return 'ТОЭ';
  if (lower.includes('электротехника')) return 'Электротех.';
  if (
    lower.includes('инженерная графика') ||
    lower.includes('начертательная геометрия') ||
    lower.includes('компьютерная графика')
  ) {
    return 'Инжграф';
  }
  if (lower.includes('материаловедение')) return 'Материалы';
  if (lower.includes('метрология')) return 'Метрология';
  if (lower.includes('сопротивление материалов') || lower.includes('сопромат')) return 'Сопромат';
  if (lower.includes('теоретическая механика') || lower.includes('термех')) return 'Термех';
  if (lower.includes('электромагнитные поля')) return 'ЭМПВ';
  if (lower.includes('электродинамика')) return 'Электродин.';

  // Гуманитарные
  if (lower.includes('история россии') || lower === 'история') return 'История';
  if (lower.includes('социология') || lower.includes('политология')) return 'Социология';
  if (lower.includes('правоведение') || lower.includes('юриспруденция')) return 'Право';
  if (lower.includes('философия')) return 'Философия';
  if (lower.includes('экономика')) return 'Экономика';

  // Практики
  if (lower.includes('практика')) return 'Практика';

  // Если название всё ещё слишком длинное — сокращаем
  if (clean.length > 13) {
    const first = clean.split(' ')[0];
    if (first.length >= 3 && first.length <= 11) return first;
    return `${clean.slice(0, 11)}…`;
  }

  return clean;
}

export function getScheduleDay(
  schedule: ParsedSchedule,
  targetDate?: string
): ParsedScheduleDay | null {
  if (!schedule.days || schedule.days.length === 0) return null;

  if (targetDate) {
    const rawTarget = normalizeRawDate(targetDate);
    const found = schedule.days.find(
      (d) => d.rawDate === rawTarget || d.date === targetDate
    );
    if (found) return found;
  }

  const { rawDate: todayRaw } = toMoscow();
  const todayMatch = schedule.days.find((day) => day.rawDate === todayRaw);
  if (todayMatch) return todayMatch;

  const nextUpcoming = schedule.days.find((day) => day.rawDate >= todayRaw);
  if (nextUpcoming) return nextUpcoming;

  return schedule.days[0] || null;
}

/**
 * Значок, короткий тип и цветовой тон для вида занятия.
 * Лекции — синий, практики — красный, лабораторные — фиолетовый.
 */
function getLessonBadge(kindOfWork: string): { icon: string; shortKind: string; tone: Tone } {
  const k = (kindOfWork || '').toLowerCase();
  if (k.includes('лек')) return { icon: '📘', shortKind: 'л', tone: 'lecture' };
  if (k.includes('практ') || k.includes('семин')) return { icon: '📙', shortKind: 'п', tone: 'practice' };
  if (k.includes('лаб')) return { icon: '🧪', shortKind: 'лаб', tone: 'lab' };
  return { icon: '📍', shortKind: 'зан', tone: 'neutral' };
}

/**
 * Главный экран расписания.
 *
 * Вёрстка: короткая шапка (дата + студент), список пар — только кнопками,
 * чтобы текст не дублировал то, что уже видно в клавиатуре.
 */
export function buildMainScheduleView(
  schedule: ParsedSchedule,
  targetDate?: string,
  user?: TelegramUser
): BotViewResult {
  const day = getScheduleDay(schedule, targetDate);

  if (!day) {
    return {
      text: '📅 <b>Расписание не найдено</b>',
      keyboard: [[toneButton('🔄 Обновить', 'neutral', 'refresh_schedule')]],
    };
  }

  const lines: string[] = [`📅 ${b(`${esc(day.date)} (${esc(day.dayName)})`)}`];

  if (user?.studentProfile?.fullName) {
    const fio = formatStudentShortName(user.studentProfile.fullName);
    const group = user.groupName ?? user.studentProfile.groupName ?? '';
    lines.push(group ? `👤 ${i(esc(fio))} │ ${esc(group)}` : `👤 ${i(esc(fio))}`);
  }

  const lessonsCount = day.slots.length;
  if (lessonsCount === 0) {
    lines.push('', '🎉 ' + b('Сегодня занятий нет'));
  } else {
    const first = day.slots[0].timeStart;
    const last = day.slots[day.slots.length - 1].timeEnd;
    lines.push(
      `${RULE}\n📚 ${b(`${lessonsCount} ${plural(lessonsCount, 'пара', 'пары', 'пар')}`)}  ${i(`${esc(first)}–${esc(last)}`)}`,
    );
  }

  const keyboard: InlineButton[][] = [];
  let lunchInserted = false;

  day.slots.forEach((slot, slotIndex) => {
    // Обед между 2 и 3 парой
    if (!lunchInserted && slot.lessonNumber >= 3) {
      keyboard.push([toneButton('🥪 12:45–13:45  Обед', 'lunch', 'lunch_joke')]);
      lunchInserted = true;
    }

    const primaryVariant = slot.variants[0];
    const { icon, shortKind, tone } = getLessonBadge(primaryVariant.kindOfWork);

    const hwList = homeworkStore.getForSlot(
      schedule.groupName,
      day.rawDate,
      slot.lessonNumber,
      slot.variants.map((v) => v.discipline)
    );

    const hwBadge = hwList.length > 0 ? '  📝' : '';
    const shortDiscipline = formatDisciplineShortName(primaryVariant.discipline);
    const audStr = primaryVariant.auditorium ? ` · ${esc(primaryVariant.auditorium)}` : '';

    keyboard.push([
      toneButton(
        `${icon} ${esc(slot.timeStart)}–${esc(slot.timeEnd)}  ${esc(shortDiscipline)} (${shortKind}) ${audStr}${hwBadge}`,
        tone,
        `sub:${day.rawDate}:${slotIndex}`,
      ),
    ]);
  });

  if (!lunchInserted && day.slots.length >= 2) {
    keyboard.push([toneButton('🥪 12:45–13:45  Обед', 'lunch', 'lunch_joke')]);
  }

  // Навигация по дням
  const currentIndex = schedule.days.findIndex((d) => d.rawDate === day.rawDate);
  const navRow: InlineButton[] = [];

  if (currentIndex > 0) {
    const prevDay = schedule.days[currentIndex - 1];
    navRow.push(toneButton(`◀️ ${esc(prevDay.dayShort)}`, 'neutral', `day:${prevDay.rawDate}`));
  }

  navRow.push(toneButton(`🗓 Сегодня`, 'neutral', 'day:current'));

  if (currentIndex >= 0 && currentIndex < schedule.days.length - 1) {
    const nextDay = schedule.days[currentIndex + 1];
    navRow.push(toneButton(`${esc(nextDay.dayShort)} ▶️`, 'neutral', `day:${nextDay.rawDate}`));
  }

  keyboard.push(navRow);

  // Быстрый доступ
  keyboard.push([
    toneButton('📊 Оценки', 'neutral', 'svc_grades'),
    toneButton('📬 ОСЭП', 'neutral', 'svc_osep'),
  ]);

  // Нижний ряд
  keyboard.push([toneButton('⚙️ Остальное', 'neutral', 'nav_more')]);

  return {
    text: lines.join('\n'),
    keyboard,
  };
}

/**
 * «08:30» -> 510. Нужна для подсчёта длительности дня.
 */
function timeToMinutes(time: string): number {
  const m = (time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

/**
 * Русское склонение: plural(2, 'пара', 'пары', 'пар') -> 'пары'.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;

  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/**
 * Карточка конкретной пары: детали занятия и привязанное ДЗ.
 */
export function buildSubjectDetailView(
  schedule: ParsedSchedule,
  rawDate: string,
  slotIndex: number
): BotViewResult {
  const day = schedule.days.find((d) => d.rawDate === rawDate);

  if (!day || !day.slots[slotIndex]) {
    return {
      text: '⚠️ Занятие не найдено.',
      keyboard: [
        [toneButton('◀️ Назад', 'back', `day:${rawDate}`)],
        [toneButton('🗓 Расписание', 'neutral', 'nav_menu')],
      ],
    };
  }

  const slot = day.slots[slotIndex];
  const primary = slot.variants[0];
  const { icon, shortKind } = getLessonBadge(primary.kindOfWork);

  const lines: string[] = [
    `${icon} ${b(esc(primary.discipline))} ${i(esc(shortKind))}`,
    '',
    `⏰ ${esc(slot.timeStart)}–${esc(slot.timeEnd)}  ·  ${esc(String(slot.lessonNumber))} ${plural(slot.lessonNumber, 'пара', 'пары', 'пар')}`,
  ];

  const meta: string[] = [];
  if (primary.auditorium) {
    meta.push(`🏛 ${esc(primary.auditorium)}${primary.building ? ` (${esc(primary.building)})` : ''}`);
  }
  const lecturer = primary.lecturerShort || primary.lecturerFullName;
  if (lecturer) {
    meta.push(`👨‍🏫 ${esc(lecturer)}`);
  }
  if (primary.note) {
    meta.push(`📌 ${esc(truncate(primary.note, 90))}`);
  }

  if (meta.length > 0) {
    lines.push('', ...meta);
  }

  // Подгруппы — только когда пара реально разделена
  if (slot.variants.length > 1) {
    lines.push('', RULE);
    slot.variants.forEach((v) => {
      lines.push(
        `▸ ${esc(v.subgroup || 'Подгруппа')}: ${esc(v.auditorium)}${v.lecturerShort ? ` · ${esc(v.lecturerShort)}` : ''}`,
      );
    });
  }

  const hwList = homeworkStore.getForSlot(
    schedule.groupName,
    day.rawDate,
    slot.lessonNumber,
    slot.variants.map((v) => v.discipline)
  );

  const filesToSend: TelegramFileRef[] = [];
  const actionButtons: InlineButton[] = [];

  lines.push('', RULE);

  if (hwList.length > 0) {
    lines.push(b('📝 Домашнее задание'));

    const parts: string[] = [];
    hwList.forEach((hw, idx) => {
      const label = hwList.length > 1 ? `#${idx + 1}: ` : '';
      const body = hw.text || 'См. прикреплённые файлы.';
      parts.push(`${label}${esc(body)}`);

      if (hw.files && hw.files.length > 0) {
        filesToSend.push(...hw.files);
      }
      actionButtons.push(
        toneButton(
          `🗑 Удалить ДЗ${hwList.length > 1 ? ` #${idx + 1}` : ''}`,
          'back',
          `hw_del_ask:${hw.id}`,
        ),
      );
    });

    lines.push(expandableQuote(parts.join('\n')));
  } else {
    lines.push('📝 Домашнее задание: ' + i('отсутствует'));
  }

  const keyboard: InlineButton[][] = [];
  if (actionButtons.length > 0) {
    keyboard.push(actionButtons);
  }
  keyboard.push([
    toneButton('◀️ Назад', 'back', `day:${rawDate}`),
    toneButton('🗓 Расписание', 'neutral', 'nav_menu'),
  ]);

  return {
    text: lines.join('\n'),
    keyboard,
    filesToSend: filesToSend.length > 0 ? filesToSend : undefined,
  };
}

export function getRandomLunchJoke(): string {
  const jokes = [
    '🥪 Обед — святое время! Приятного аппетита!',
    '☕️ Время перекусить между парами!',
    '🍕 Гранит науки лучше учится на сытый желудок!',
    '🍲 Столовая МЭИ ждет!',
  ];
  return jokes[Math.floor(Math.random() * jokes.length)];
}

/**
 * Сокращает ФИО до вида «Лысенко Н.Р.» для компактной шапки.
 */
export function formatStudentShortName(fullName: string): string {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Студент';
  if (parts.length === 1) return parts[0];

  const surname = parts[0];
  const initials = parts
    .slice(1, 3)
    .map((p) => `${p.charAt(0).toUpperCase()}.`)
    .join('');

  return initials ? `${surname} ${initials}` : surname;
}
