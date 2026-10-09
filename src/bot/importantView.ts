import { homeworkStore, TelegramFileRef } from '../storage/homeworkStore.ts';
import { importantStore } from '../storage/importantStore.ts';
import { formatDisplayDate, toMoscow } from '../utils/time.ts';
import { b, esc, expandableQuote, i, quote, RULE, toneButton, truncate } from './format.ts';
import { formatDisciplineShortName, InlineButton, plural } from './scheduleView.ts';

export interface ViewResult {
  text: string;
  keyboard: InlineButton[][];
  filesToSend?: TelegramFileRef[];
}

/**
 * Иконка типа занятия для ДЗ.
 */
function hwIcon(kind: string): string {
  if (kind === 'lecture') return '📘';
  if (kind === 'lab') return '🧪';
  return '📙';
}

function hwKindShort(kind: string): string {
  if (kind === 'lecture') return 'л';
  if (kind === 'lab') return 'лаб';
  return 'п';
}

function hwKindFull(kind: string): string {
  if (kind === 'lecture') return 'Лекция';
  if (kind === 'lab') return 'Лабораторная';
  return 'Практика';
}

/**
 * Раздел «Важное» — список объявлений.
 */
export function buildImportantListView(groupName: string): ViewResult {
  const list = importantStore.getForGroup(groupName);

  const text =
    list.length === 0
      ? [`⭐ ${b('Важное')}`, '', quote('Объявлений пока нет.')].join('\n')
      : [`⭐ ${b('Важное')}  ${i(`${list.length} ${plural(list.length, 'объявление', 'объявления', 'объявлений')}`)}`].join('\n');

  const keyboard: InlineButton[][] = [];

  list.forEach((msg, idx) => {
    const filesTag = msg.files && msg.files.length > 0 ? '  📎' : '';
    keyboard.push([
      { text: `📌 ${idx + 1}. ${msg.title}${filesTag}`, callback_data: `imp:${msg.id}` },
    ]);
  });

  keyboard.push([toneButton('➕ Добавить объявление', 'important', 'imp_add')]);
  keyboard.push([toneButton('◀️ В остальное', 'back', 'nav_more')]);

  return { text, keyboard };
}

/**
 * Просмотр объявления: текст целиком, файлы приходят в чат.
 */
export function buildImportantDetailView(id: string): ViewResult {
  const msg = importantStore.get(id);

  if (!msg) {
    return {
      text: '⚠️ Сообщение не найдено.',
      keyboard: [
        [toneButton('◀️ К важным', 'back', 'nav_important')],
        [toneButton('⚙️ В остальное', 'neutral', 'nav_more')],
      ],
    };
  }

  const lines = [`⭐ ${b(msg.title)}`, RULE, quote(esc(msg.text))];

  const meta: string[] = [];
  if (msg.authorName) meta.push(esc(msg.authorName));
  if (msg.files && msg.files.length > 0) {
    meta.push(`${msg.files.length} ${plural(msg.files.length, 'файл', 'файла', 'файлов')}`);
  }
  if (meta.length > 0) {
    lines.push('', i(meta.join(' · ')));
  }

  return {
    text: lines.join('\n'),
    keyboard: [
      [toneButton('🗑 Удалить', 'back', `imp_del_ask:${msg.id}`)],
      [toneButton('◀️ К важным', 'back', 'nav_important')],
      [toneButton('⚙️ В остальное', 'neutral', 'nav_more')],
    ],
    filesToSend: msg.files && msg.files.length > 0 ? msg.files : undefined,
  };
}

/**
 * Промпт добавления объявления.
 */
export function buildImportantAddPromptView(): ViewResult {
  return {
    text: [
      `➕ ${b('Новое объявление')}`,
      '',
      'Отправьте текст сообщением — можно сразу с файлом.',
      '',
      quote(esc('Внимание: объявление увидят все одногруппники.')),
    ].join('\n'),
    keyboard: [[toneButton('❌ Отмена', 'neutral', 'nav_important')]],
  };
}

/**
 * Раздел «ДЗ»: список актуальных заданий.
 */
export function buildHomeworkListView(groupName: string): ViewResult {
  const { rawDate: todayRaw } = toMoscow();
  const list = homeworkStore.getUpcoming(groupName, todayRaw);

  const text =
    list.length === 0
      ? [`📖 ${b('Домашние задания')}`, '', quote('Актуальных заданий пока нет.')].join('\n')
      : [
          `📖 ${b('Домашние задания')}  ${i(`${list.length} ${plural(list.length, 'задание', 'задания', 'заданий')}`)}`,
        ].join('\n');

  const keyboard: InlineButton[][] = [];

  list.forEach((hw, idx) => {
    const filesTag = hw.files && hw.files.length > 0 ? '  📎' : '';
    const dateStr = formatDisplayDate(hw.targetDate);
    const pairStr = hw.lessonNumber
      ? ` · ${hw.lessonNumber} ${plural(hw.lessonNumber, 'пара', 'пары', 'пар')}`
      : '';

    keyboard.push([
      {
        text: `${hwIcon(hw.kind)} ${idx + 1}. ${formatDisciplineShortName(hw.discipline)} (${hwKindShort(hw.kind)}, ${dateStr}${pairStr})${filesTag}`,
        callback_data: `hw_detail:${hw.id}`,
      },
    ]);
  });

  keyboard.push([toneButton('➕ Добавить ДЗ', 'homework', 'prompt_dz')]);
  keyboard.push([toneButton('◀️ В остальное', 'back', 'nav_more')]);

  return { text, keyboard };
}

/**
 * Просмотр конкретного ДЗ.
 */
export function buildSingleHomeworkDetailView(id: string): ViewResult {
  const hw = homeworkStore.get(id);

  if (!hw) {
    return {
      text: '⚠️ ДЗ не найдено.',
      keyboard: [
        [toneButton('◀️ К списку ДЗ', 'back', 'nav_dz')],
        [toneButton('⚙️ В остальное', 'neutral', 'nav_more')],
      ],
    };
  }

  const lines = [
    `${hwIcon(hw.kind)} ${b(hw.discipline)} ${i(`(${hwKindFull(hw.kind)})`)}`,
    '',
    RULE,
  ];

  const meta: string[] = [`📅 ${formatDisplayDate(hw.targetDate)}`];
  if (hw.lessonNumber) {
    meta.push(
      `${hw.lessonNumber} ${plural(hw.lessonNumber, 'пара', 'пары', 'пар')}${hw.timeStart ? ` в ${hw.timeStart}` : ''}`,
    );
  }
  if (hw.authorName) meta.push(`добавил: ${hw.authorName}`);

  lines.push(i(esc(meta.join(' · '))));
  lines.push('');

  if (hw.text) {
    lines.push(expandableQuote(esc(hw.text)));
  } else {
    lines.push(quote('Задание — в прикреплённых файлах ниже.'));
  }

  const keyboard: InlineButton[][] = [
    [toneButton('🗑 Удалить ДЗ', 'back', `hw_del_ask:${hw.id}`)],
    [toneButton('◀️ К списку ДЗ', 'back', 'nav_dz')],
    [toneButton('⚙️ В остальное', 'neutral', 'nav_more')],
  ];

  return {
    text: lines.join('\n'),
    keyboard,
    filesToSend: hw.files && hw.files.length > 0 ? hw.files : undefined,
  };
}

/**
 * Подтверждение удаления.
 */
export function buildConfirmDeleteView(
  kind: 'hw' | 'imp',
  id: string,
  title: string
): ViewResult {
  const isHw = kind === 'hw';
  const noun = isHw ? 'ДЗ' : 'объявление';

  const text = [
    `⚠️ ${b(`Удалить ${noun}?`)}`,
    '',
    quote(esc(truncate(title, 120))),
  ].join('\n');

  const confirmCb = isHw ? `hw_del_confirm:${id}` : `imp_del_confirm:${id}`;
  const cancelCb = isHw ? `hw_detail:${id}` : `imp:${id}`;

  return {
    text,
    keyboard: [
      [
        toneButton('🗑 Да, удалить', 'back', confirmCb),
        toneButton('❌ Отмена', 'neutral', cancelCb),
      ],
    ],
  };
}