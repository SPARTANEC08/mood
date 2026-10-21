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
  buildAndroidGuideView,
  buildClientMenu,
  buildIosGuideView,
  buildPwaOpenView,
  buildTargetLinkedElsewhereView,
  buildTgLinkedElsewhereView,
  buildUnlinkedView,
  buildUnlinkConfirmView,
  buildWelcomeView,
  type BotViewResult,
} from '../../tg/pwaView.js';
import {
  buildAdminAddConfirmView,
  buildAdminAddPromptView,
  buildAdminAddResultView,
  buildAdminMenu,
  buildAdminRemoveResultView,
  buildAdminRemoveView,
  buildBroadcastPromptView,
  buildBroadcastPreviewView,
  buildMailRefreshConfirmView,
  buildMailRefreshResultView,
  buildReportsView,
  buildStatsView,
} from '../../tg/adminView.js';
import type { StoredUser } from '../../db/storage/userStore.js';
import { link, RULE, RULE_CELL_WIDTH } from '../../tg/format.js';
import { diffSnapshots, renderNotification } from '../services/notifications/barsNotifier.js';
import type { SemesterGrades } from '../services/bars/parsers/gradesParser.js';
import type { UserSnapshot } from '../../db/storage/snapshotStore.js';

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

/** Тестовый пользователь для клиентского меню. */
function testUser(over: Partial<StoredUser> = {}): StoredUser {
  return {
    userId: '11111111-2222-4333-8444-555555555555',
    barsLoginHash: 'hash',
    firstName: 'Николай',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    studentProfile: { fullName: 'Лысенко Николай Романович' },
    groupName: 'ИЭ-11-26',
    telegramId: 100000001,
    notificationsEnabled: true,
    ...over,
  };
}

/** Экраны бота: клиентские и админские. */
const VIEWS: { name: string; view: BotViewResult }[] = [
  { name: 'Приветствие', view: buildWelcomeView() },
  { name: 'iOS', view: buildIosGuideView() },
  { name: 'Android', view: buildAndroidGuideView() },
  { name: 'Клиентское меню (вкл)', view: buildClientMenu(testUser(), false) },
  { name: 'Клиентское меню (выкл)', view: buildClientMenu(testUser({ notificationsEnabled: false }), false) },
  { name: 'Клиентское меню (админ)', view: buildClientMenu(testUser(), true) },
  { name: 'Отвязка: подтверждение', view: buildUnlinkConfirmView() },
  { name: 'Отвязка: результат', view: buildUnlinkedView() },
  { name: 'Аккаунт не найден', view: buildAccountNotFoundView() },
  { name: 'Telegram занят', view: buildTgLinkedElsewhereView() },
  { name: 'Аккаунт занят', view: buildTargetLinkedElsewhereView() },
  { name: 'Экран /app', view: buildPwaOpenView(1) },
  { name: 'Админ-меню', view: buildAdminMenu() },
  { name: 'Статистика', view: buildStatsView() },
  { name: 'Отчёты: пусто', view: buildReportsView([], 0) },
  { name: 'Почта: подтверждение', view: buildMailRefreshConfirmView() },
  { name: 'Почта: результат', view: buildMailRefreshResultView({ processed: 4, notified: 2, errors: 1 }) },
  { name: 'Рассылка: ввод', view: buildBroadcastPromptView() },
  { name: 'Рассылка: превью', view: buildBroadcastPreviewView('Тестовое объявление с <тегами> и & амперсандом') },
  { name: 'Админ: ввод ID', view: buildAdminAddPromptView() },
  { name: 'Админ: подтверждение', view: buildAdminAddConfirmView(123456789) },
  { name: 'Админ: назначен', view: buildAdminAddResultView(123456789, true) },
  { name: 'Админ: список снятия', view: buildAdminRemoveView([]) },
  { name: 'Админ: снят', view: buildAdminRemoveResultView(123456789, true) },
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
        `${name}: кнопка «${btn.text}» куда-то ведёт`,
        (typeof btn.callback_data === 'string' && btn.callback_data.length > 0) ||
          (typeof btn.url === 'string' && btn.url.startsWith('https://')),
      );
    }
  }
}

section('Кнопки меню');
{
  const menuOn = buildClientMenu(testUser(), false);
  const toggleOn = menuOn.keyboard.flat().find((b) => b.callback_data === 'notif_off');
  check('включены → кнопка выключения', Boolean(toggleOn));
  check('кнопка выключения красная', toggleOn?.style === 'danger');

  const menuOff = buildClientMenu(testUser({ notificationsEnabled: false }), false);
  const toggleOff = menuOff.keyboard.flat().find((b) => b.callback_data === 'notif_on');
  check('выключены → кнопка включения', Boolean(toggleOff));
  check('кнопка включения зелёная', toggleOff?.style === 'success');

  check('у обычного пользователя нет админ-кнопки', !menuOn.keyboard.flat().some((b) => b.callback_data === 'admin'));
  check(
    'у админа есть админ-кнопка',
    buildClientMenu(testUser(), true).keyboard.flat().some((b) => b.callback_data === 'admin'),
  );

  const welcome = buildWelcomeView().keyboard.flat().map((b) => b.callback_data);
  check('приветствие: выбор iOS', welcome.includes('platform_ios'));
  check('приветствие: выбор Android', welcome.includes('platform_android'));

  const adminCbs = buildAdminMenu().keyboard.flat().map((b) => b.callback_data);
  for (const expected of ['admin_stats', 'admin_reports:0', 'admin_mail', 'admin_broadcast', 'admin_add', 'admin_remove', 'menu']) {
    check(`админ-меню: ${expected}`, adminCbs.includes(expected));
  }
}

section('Экран /app совпадает с приветствием');
{
  check('/app = приветствие', buildPwaOpenView(1).text === buildWelcomeView().text);
  check('iOS-инструкция: Safari и «На экран Домой»', /Safari/.test(buildIosGuideView().text) && /экран Домой/.test(buildIosGuideView().text));
  check('Android-инструкция: APK или PWA', /APK/.test(buildAndroidGuideView().text));
}

section('Ссылка на приложение — только там, где нужна');
{
  const appLinkInText = (view: BotViewResult): boolean => view.text.includes('Открыть Mood');
  const appLinkInKeyboard = (view: BotViewResult): boolean =>
    view.keyboard.flat().some((button) => (button.url ?? '').includes('109-120-129-61') || (button.url ?? '').includes((process.env.PWA_URL ?? '###').replace(/\/$/, '')));

  // Приветствие и Android-инструкция — без ссылки: первый экран не должен
  // рекомендовать браузер раньше приложения, а Android получает APK.
  check('приветствие без ссылки', !appLinkInText(buildWelcomeView()));
  check('Android без ссылки', !appLinkInText(buildAndroidGuideView()));

  // iOS: ссылка обязательна (когда PWA_URL вообще задан) — приложение
  // ставится из Safari по этой ссылке.
  check('iOS со ссылкой', appLinkInText(buildIosGuideView()) || !process.env.PWA_URL);

  // После входа ссылка есть и текстом, и кнопкой.
  const menu = buildClientMenu(testUser(), false);
  check('меню: ссылка только кнопкой, без текста', !appLinkInText(menu));
  check('меню: кнопка на сайт есть', appLinkInKeyboard(menu) || !process.env.PWA_URL);
}

section('Схемы ссылок Telegram');
{
  check('javascript: не попадает в href', !link('javascript:alert(1)', 'опасно').includes('href='));
  check('https остаётся кликабельным', link('https://hub.example/', 'Mood').includes('href="https://hub.example/"'));
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

  const rendered = events.map(renderNotification).join('\n');
  auditAll('Уведомления', rendered);
  check('emoji баллов', rendered.includes('🎓'));
  check('emoji приказов', rendered.includes('📄'));
  check('emoji стипендии', rendered.includes('💰'));
  check('в Telegram только типы, без деталей', !rendered.includes('За неделю') && !rendered.includes('№1'));
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
