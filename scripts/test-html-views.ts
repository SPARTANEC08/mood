/**
 * Проверка HTML-разметки экранов бота и текстов уведомлений.
 *
 * Telegram отклоняет сообщение целиком, если в HTML непарный или неизвестный
 * тег. Поэтому здесь ловим ошибки ДО отправки: считаем баланс тегов и ищем
 * сырые спецсимволы.
 *
 * Экранов у бота теперь шесть, и все они собираются в pwaView. Отдельно
 * проверяются тексты пуш-уведомлений: они идут мимо экранов, собираются в
 * barsNotifier и сломались бы в вёрстке так же незаметно.
 *
 * Запуск: npm run test:html
 */

import 'dotenv/config';

import * as cheerio from 'cheerio';

import {
  buildAccountNotFoundView,
  buildAlreadyLinkedView,
  buildNotificationsOffView,
  buildNotificationsOnView,
  buildPwaOpenView,
  buildWelcomeView,
  type BotViewResult,
} from '../src/bot/pwaView.js';
import { link, RULE, RULE_CELL_WIDTH } from '../src/bot/format.js';
import { diffSnapshots, renderNotification } from '../src/services/notifications/barsNotifier.js';
import type { SemesterGrades } from '../src/services/bars/parsers/gradesParser.js';
import type { UserSnapshot } from '../src/storage/snapshotStore.js';

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
 *
 * Ручной подсчёт парности, а не разбор cheerio: cheerio чинит непарные теги
 * молча, и проверка прошла бы именно на той разметке, которую Telegram
 * отвергнет.
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
  });

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
 * превратит соседний текст в невидимую сущность.
 */
function findRawEntities(text: string): string[] {
  const withoutTags = text.replace(/<[^>]*>/g, '');
  const problems: string[] = [];

  const angles = withoutTags.match(/[<>]/g) ?? [];
  if (angles.length > 0) problems.push(`неэкранированные < >: ${angles.length}`);

  const rawAmp = withoutTags.match(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-fA-F]+;)/g) ?? [];
  if (rawAmp.length > 0) problems.push(`неэкранированные &: ${rawAmp.length}`);

  return problems;
}

function auditAll(name: string, text: string): void {
  const result = validateHtml(text);
  check(`${name}: валидный HTML`, result.ok, result.error);

  const raw = findRawEntities(text);
  check(`${name}: спецсимволы экранированы`, raw.length === 0, raw.join('; '));
}

/** Экраны бота: ровно те, что собирает pwaView. */
const VIEWS: { name: string; view: BotViewResult }[] = [
  { name: 'Приветствие', view: buildWelcomeView() },
  { name: 'Уже подключено', view: buildAlreadyLinkedView() },
  { name: 'Уведомления включены', view: buildNotificationsOnView() },
  { name: 'Уведомления выключены', view: buildNotificationsOffView() },
  { name: 'Аккаунт не найден', view: buildAccountNotFoundView() },
  { name: 'Экран /app', view: buildPwaOpenView(1) },
];

/* ------------------------------------------------------------------ */
/* Проверки                                                               */
/* ------------------------------------------------------------------ */

section('Экраны бота');
for (const { name, view } of VIEWS) {
  auditAll(name, view.text);
  check(`${name}: есть клавиатура или пустой ряд`, Array.isArray(view.keyboard));
  for (const row of view.keyboard) {
    for (const btn of row) {
      check(
        `${name}: кнопка «${btn.text}» имеет callback_data`,
        typeof btn.callback_data === 'string' && btn.callback_data.length > 0,
      );
    }
  }
}

section('Кнопки ведут туда, куда объявлено');
{
  const callbacks = VIEWS.flatMap(({ view }) => view.keyboard.flat().map((b) => b.callback_data));
  const allowed = new Set(['pwa_open', 'notif_off', 'notif_on']);

  check('нет кнопок вне белого списка', callbacks.every((c) => allowed.has(c)), callbacks.join(', '));

  const on = buildNotificationsOnView();
  check('после включения — кнопка выключения', on.keyboard[0][0].callback_data === 'notif_off');
  check('кнопка выключения красная', on.keyboard[0][0].style === 'danger');

  const off = buildNotificationsOffView();
  check('после выключения — кнопка включения', off.keyboard[0][0].callback_data === 'notif_on');
  check('кнопка включения зелёная', off.keyboard[0][0].style === 'success');
}

section('Экран /app совпадает с приветствием');
{
  // Отдельного экрана у /app больше нет: показывать нечего, и различать эти
  // два состояния незачем — но и разойтись они не должны.
  check('/app = приветствие', buildPwaOpenView(1).text === buildWelcomeView().text);
  check('приветствие содержит установку PWA на iPhone', /iPhone:.*Safari/s.test(buildWelcomeView().text));
  check('приветствие содержит установку PWA на Android', /Android:.*Chrome/s.test(buildWelcomeView().text));
}

section('Экран не обещает того, чего нет');
{
  for (const { name, view } of VIEWS) {
    // Ссылка на приложение обязана быть, иначе человек останется без пути:
    // единственное, что бот умеет, — показать, где приложение.
    const hasAppLink = view.text.includes('Открыть приложение') || !process.env.PWA_URL;
    check(`${name}: есть куда пойти`, hasAppLink);
  }
}

section('Схемы ссылок Telegram');
{
  check('javascript: не попадает в href', !link('javascript:alert(1)', 'опасно').includes('href='));
  check('https остаётся кликабельным', link('https://hub.example/', 'Hub').includes('href="https://hub.example/"'));
}

section('Тексты пуш-уведомлений');
{
  const base = (over: Partial<UserSnapshot> = {}): UserSnapshot => ({
    gradesHash: {},
    lastSeenMailUid: 0,
    ordersCount: 0,
    scholarshipStatus: 'нет',
    lastCheckedAt: new Date().toISOString(),
    ...over,
  });

  // Оценки нужны по именам дисциплин, иначе в снимке есть хэши без названий и
  // diff не знает, что показать в строке.
  const grades: SemesterGrades = {
    semesterName: '2026/2027, Осенний семестр',
    isCurrent: true,
    subjects: [
      {
        discipline: 'Математический анализ',
        controlType: 'Экзамен',
        controlPoints: [{ number: 1, score: 42, weight: 100 }],
        weekScores: [],
        totalScore: 42,
      },
      {
        discipline: 'Физика',
        controlType: 'Экзамен',
        controlPoints: [{ number: 1, score: 5, weight: 100 }],
        weekScores: [],
        totalScore: 5,
      },
    ],
  };

  const events = diffSnapshots(
    base(),
    base({
      gradesHash: { 'Математический анализ_КТ1': 42, 'Физика_КТ1': 5 },
      lastSeenMailUid: 15,
      ordersCount: 3,
      scholarshipStatus: 'Академическая, 01.09.2026-31.01.2027',
    }),
    { grades },
  );

  check('найдены события', events.length > 0, `получено ${events.length}`);

  const rendered = renderNotification(events);
  auditAll('Уведомления', rendered);
  check('есть подпись про кнопку', rendered.includes('скрыть') || rendered.includes('Скрыть'));
}

section('Разделительные полосы: перенос на узких экранах');
{
  // RULE склеен WORD JOINER'ами именно поэтому: 12 «толстых» символов занимают
  // 24 ячейки, а пузырь на телефоне — 28–34. Проверяем, что склейка на месте.
  const glyphs = RULE.replace(/\u2060/g, '');
  check('RULE состоит из 12 чёрточек', glyphs.length === 12, `${glyphs.length}`);
  check('между чёрточками WORD JOINER (U+2060)', RULE.includes('\u2060'));
  check('RULE_CELL_WIDTH = 24', RULE_CELL_WIDTH === 24, `${RULE_CELL_WIDTH}`);
  check('видимая ширина вдвое меньше кода', glyphs.length * 2 === RULE_CELL_WIDTH);
}

section('Итог');
console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
console.log('='.repeat(52));

if (failed > 0) process.exit(1);
