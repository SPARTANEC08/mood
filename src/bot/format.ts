/**
 * Форматирование текста для Telegram.
 *
 * Всё сообщение отправляется в HTML-режиме: это единственный способ получить
 * настоящие цитаты (<blockquote>) и сворачиваемые блоки (<blockquote expandable>).
 * Любой пользовательский текст обязательно проходит через esc().
 *
 * Про кнопки. Их сборки здесь больше нет: пока бот был интерфейсом, здесь была
 * палитра из семнадцати тонов («лекция», «выйти», «обед»…) и их отображение в
 * три цвета Telegram. Бот стал push-каналом с тремя экранами, и палитра из
 * семнадцати значений на три кнопки стала балластом — кнопки теперь
 * собираются прямо в pwaView.ts, где видно, какие они вообще есть.
 *
 * RULE при этом остался: он нужен barsNotifier для пуш-уведомлений, и формат
 * уведомлений менять нельзя.
 */

import { randomUUID } from 'node:crypto';

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
  let parsed: URL;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return esc(text);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return esc(text);

  const safeUrl = parsed.href.replace(/["'\s<>]/g, '');
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
 * Идентификатор записи для callback_data.
 *
 * Раньше здесь был `Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`:
 * метка времени полностью предсказуема, оставалось всего 36^4 ≈ 1.7 млн вариантов
 * на запись, что делало перебор чужих записей тривиальным. Теперь 122 бита из
 * crypto.randomUUID — подобрать нельзя, а проверка группы всё равно остаётся
 * основной защитой.
 */
export function makeRecordId(prefix: 'hw' | 'imp'): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Разделяет текст на части и убирает повторы подряд идущих пробелов/переносов.
 */
export function collapseWhitespace(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Сокращает строку по длине, обрезая многоточием.
 */
export function truncate(value: string, max: number): string {
  const clean = collapseWhitespace(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Приводит текст ошибки к тому, что можно показать пользователю в Telegram.
 *
 * Сырые сообщения axios и imapflow содержат внутренние детали: хосты, порты,
 * пути, имена параметров, иногда фрагменты учётных данных. Пользователю они
 * ничего не дают, поэтому адреса и пути заменяются на заглушку, а сообщение
 * обрезается. Подробности остаются в логе на стороне сервера.
 */
export function safeErrorMessage(err: unknown, max: number = 200): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');

  const cleaned = raw
    // URL целиком и «host:port»
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, 'адрес')
    .replace(/\b[\w.-]+:\d{2,5}\b/g, 'адрес')
    // unix/относительные пути
    .replace(/(?:\/[\w.-]+){2,}/g, 'путь')
    // почта и похожие на токены длинные строки
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, 'адрес')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '…');

  return truncate(cleaned, max);
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
