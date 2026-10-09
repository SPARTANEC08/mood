/**
 * Форматирование текста и кнопок для Telegram.
 *
 * Всё сообщение отправляется в HTML-режиме: это единственный способ получить
 * настоящие цитаты (<blockquote>) и сворачиваемые блоки (<blockquote expandable>).
 * Любой пользовательский текст обязательно проходит через esc().
 */

import type { InlineButton } from './scheduleView.js';

/**
 * Стиль кнопки. Telegram поддерживает ровно три цвета:
 * danger — красный, success — зелёный, primary — синий.
 * Если стиль не указан, клиент рисует кнопку в своём дефолтном виде.
 */
export type ButtonStyle = 'danger' | 'success' | 'primary';

/**
 * Тема кнопки. Хранится именно смысл, а не цвет: один и тот же смысл
 * может выглядеть по-разному в разных экранах.
 */
export type Tone =
  // Типы занятий в расписании
  | 'lecture'
  | 'practice'
  | 'lab'
  | 'lunch'
  // Сервисы
  | 'grades'
  | 'mail'
  | 'homework'
  | 'important'
  | 'attendance'
  | 'library'
  | 'orders'
  | 'session'
  | 'more'
  // Навигация и действия
  | 'back'
  | 'logout'
  | 'neutral';

/**
 * Соответствие тона и реального цвета Telegram.
 *
 * Правила цветов:
 * - лекции — синие, практики — красные, лабораторные — синие, обед — зелёный;
 * - сервисы чередуют синий и зелёный, чтобы ряд читался;
 * - навигация внутри экрана — синяя;
 * - красный закреплён только за «выйти» и «назад».
 */
const TONE_STYLE: Record<Tone, ButtonStyle | undefined> = {
  lecture: 'primary',
  practice: 'danger',
  lab: 'primary',
  lunch: 'success',

  grades: 'primary',
  mail: 'success',
  homework: 'primary',
  important: 'success',
  attendance: 'primary',
  library: 'success',
  orders: 'primary',
  session: 'success',
  more: 'primary',

  back: 'danger',
  logout: 'danger',
  neutral: undefined,
};

/**
 * Кнопка с цветом Telegram.
 */
export function toneButton(text: string, tone: Tone, callbackData: string): InlineButton {
  const style = TONE_STYLE[tone];
  return style ? { text, callback_data: callbackData, style } : { text, callback_data: callbackData };
}

/**
 * Экранирование текста для HTML-режима Telegram.
 * Без этого названия дисциплин с кавычками или «<» ломают разметку.
 */
export function esc(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Жирный текст.
 */
export function b(value: string): string {
  return `<b>${esc(value)}</b>`;
}

/**
 * Курсив.
 */
export function i(value: string): string {
  return `<i>${esc(value)}</i>`;
}

/**
 * Моноширинный текст: время, номера КМ, коды.
 */
export function code(value: string): string {
  return `<code>${esc(value)}</code>`;
}

/**
 * Ссылка в тексте.
 *
 * Telegram принимает в HTML-режиме только теги b, i, s, u, a, code, pre и
 * blockquote, поэтому адрес уходит в атрибут href. Сам href не экранируется
 * через esc(): там служебные символы, а экранирование сломало бы ссылку —
 * вместо этого отсекаются кавычки и пробелы, которые иначе вырвались бы из
 * атрибута и сломали разметку сообщения.
 */
export function link(url: string, text: string): string {
  const safeUrl = String(url).trim().replace(/["'\s<>]/g, '');
  return `<a href="${safeUrl}">${esc(text)}</a>`;
}

/**
 * Обычная цитата.
 */
export function quote(text: string): string {
  return `<blockquote>${text}</blockquote>`;
}

/**
 * Сворачиваемая цитата: показывается первая строка, остальное раскрывается по тапу.
 * Именно то, что нужно для длинных списков КМ.
 */
export function expandableQuote(text: string): string {
  return `<blockquote expandable>${text}</blockquote>`;
}

/**
 * Разделяет блоки текста пустой строкой.
 */
export function joinBlocks(blocks: (string | undefined)[]): string {
  return blocks.filter((b) => typeof b === 'string' && b.trim() !== '').join('\n\n');
}

/**
 * Сокращает строку по длине, обрезая многоточием.
 */
export function truncate(value: string, max: number): string {
  const clean = (value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Форматирует число в виде «4,5» — как это принято в ЛК МЭИ.
 */
export function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(value).replace('.', ',');
}

/**
 * Разделительная линия для членения экранов.
 *
 * Почему не просто «━━━━━━━━━━━━━━━━━━━━━━»:
 * символ ━ (U+2501) занимает ДВЕ ячейки в шрифте Telegram, поэтому 22 символа
 * занимают 44 ячейки. На телефоне в пузырь сообщения влезает около 28–34 ячеек,
 * и линия переносилась на вторую строку, ломая вёрстку.
 *
 * Решение — два одновременно:
 * 1. длина сокращена до 14 символов (28 ячеек), что влезает в узкий экран;
 * 2. между символами вставлен WORD JOINER (U+2060) — невидимый символ
 *    с нулевой шириной, который запрещает разрыв строки в этом месте.
 *    Даже если экран окажется ещё уже, лица не перенесутся, а уедут за край.
 *
 * WORD JOINER передаётся как HTML-сущность &amp;#8288;, потому что Telegram
 * режет наши строки именно как HTML.
 */
const RULE_GLYPH = '\u2501';

/** Невидимый запрет переноса: WORD JOINER, U+2060. */
const WORD_JOINER = '\u2060';

/**
 * Сколько видимых черт рисовать: 12 * 2 ячейки = 24.
 * Запас до~28 ячеек — минимального пузыря на телефоне — нужен на разные шрифты.
 */
const RULE_LENGTH = 12;

/**
 * Разделительная линия: 12 черт, склеенных неразрывными WORD JOINER.
 */
export const RULE = Array.from({ length: RULE_LENGTH }, () => RULE_GLYPH).join(WORD_JOINER);

/**
 * Сколько ячеек занимает разделитель на экране.
 * Нужна тестам: значение должно быть меньше ширины пузыря на узком телефоне.
 */
export const RULE_CELL_WIDTH = RULE_LENGTH * 2;