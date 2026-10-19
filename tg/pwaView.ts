/**
 * Клиентские экраны бота: приветствие, установка, главное меню, отвязка.
 *
 * Бот остаётся тонким push-каналом: данных (расписание, ДЗ, оценки, почта) в
 * нём нет. Экраны собираются здесь, а решение «что показать» принимает
 * botEngine. Всё — HTML-разметка Telegram, пользовательский текст только через
 * `b`/`i`/`link` (они экранируют).
 *
 * Одностраничная логика: клиентское меню — одно сообщение, которое
 * редактируется на месте (см. telegramService). Поэтому все экраны возвращают
 * только текст и клавиатуру, без побочных эффектов.
 */

import type { StoredUser } from '../db/storage/userStore.ts';
import { findLatestApk } from './apk.ts';
import { b, i, joinBlocks, link, quote, RULE } from './format.ts';

/** Кнопка Telegram: либо callback, либо ссылка. */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: 'danger' | 'success' | 'primary';
}

/** Что показать: текст, клавиатура и (опционально) файл. */
export interface BotViewResult {
  text: string;
  keyboard: InlineButton[][];
  /** Локальный файл, который нужно отправить документом вместе с экраном. */
  /**
   * Документ для отправки: файл с диска (`path`) либо готовый HTML из памяти
   * (`html` + `filename`). Второе нужно отчёту по кнопке: он не должен попадать
   * на диск вообще (в архиве живут только автоотчёты в 00:00).
   */
  document?: { path?: string; filename: string; html?: string };
}

function btn(text: string, callbackData: string, style?: InlineButton['style']): InlineButton {
  return style ? { text, callback_data: callbackData, style } : { text, callback_data: callbackData };
}

function urlBtn(text: string, url: string): InlineButton {
  return { text, url };
}

/** Публичный адрес PWA или null, если он не задан/невалиден. */
export function getPwaUrl(): string | null {
  const raw = process.env.PWA_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const isLocalHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalHttp) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    console.warn('[PWA] PWA_URL задан, но не разбирается как URL — кнопка скрыта');
    return null;
  }
}

export const CHANNEL_URL = 'https://t.me/mood_mpei';
export const SUPPORT_URL = 'https://t.me/mood_mpei_sup';

function appLink(): string {
  const url = getPwaUrl();
  return url ? link(url, '🌐 Открыть Mood') : quote('Веб-приложение ещё не настроено на сервере.');
}

function appButtonRow(): InlineButton[] {
  const url = getPwaUrl();
  return url ? [urlBtn('🌐 Открыть Mood', url)] : [];
}

function supportRow(): InlineButton[] {
  return [urlBtn('📣 Канал', CHANNEL_URL), urlBtn('💬 Поддержка', SUPPORT_URL)];
}

/**
 * Приветствие и первый экран.
 *
 * Сразу объясняем порядок: сначала вход в приложении, потом «Подключить
 * уведомления». Иначе человек жмёт /start и ждёт уведомлений, хотя привязки
 * ещё нет — бот о нём ничего не знает.
 */
export function buildWelcomeView(): BotViewResult {
  return {
    text: joinBlocks([
      `👋 ${b('Mood')}`,
      'Расписание, задания, оценки и почта — в приложении.',
      '',
      b('Как подключить уведомления'),
      '1. Открой приложение и войди логином и паролем БАРС.',
      '2. В профиле нажми «Подключить уведомления в Telegram».',
      '3. Вернись сюда — меню появится само.',
      '',
      'Пришлю сообщение о новых баллах, письмах, приказах и стипендии.',
      '',
      RULE,
      '',
      i('Установить приложение: выбери платформу ниже.'),
      '',
      i('Ссылка на приложение появится после выбора iOS или в меню после входа.'),
    ]),
    // Ссылку на сайт здесь НЕ показываем: человеку без установленного
    // приложения она ничего не даёт, а в первом сообщении от неё только шум.
    keyboard: [
      [btn('📱 iOS', 'platform_ios'), btn('🤖 Android', 'platform_android')],
      supportRow(),
    ],
  };
}

/** Инструкция для iOS: APK не подходит. */
export function buildIosGuideView(): BotViewResult {
  return {
    text: joinBlocks([
      `🍎 ${b('Установка на iPhone / iPad')}`,
      '1. Открой сайт в Safari (именно Safari, не Chrome).',
      '2. Нажми «Поделиться» → «На экран Домой» → «Добавить».',
      '3. Запусти Mood с иконки и войди логином БАРС.',
      '4. Профиль → «Подключить уведомления в Telegram».',
      '',
      i('APK для iOS не подходит — это Android-приложение.'),
      '',
      appLink(),
    ]),
    keyboard: [[btn('⬅️ Назад', 'menu_back')], appButtonRow(), supportRow()].filter(
      (row) => row.length > 0,
    ),
  };
}

/** Инструкция для Android + APK файлом, если он уже собран на сервере. */
export function buildAndroidGuideView(): BotViewResult {
  const apk = findLatestApk();

  return {
    text: joinBlocks([
      `🤖 ${b('Установка на Android')}`,
      '1. Установи APK из сообщения ниже (разреши установку из неизвестных источников).',
      '2. Открой Mood и войди логином БАРС.',
      '3. Профиль → «Подключить уведомления в Telegram».',
      '',
      apk
        ? i('Файл пришлю следующим сообщением.')
        : i('APK пока не собран на сервере. Можно поставить PWA: Chrome → меню ⋮ → «Установить приложение».'),
    ]),
    keyboard: [[btn('⬅️ Назад', 'menu_back')], supportRow()].filter((row) => row.length > 0),
    ...(apk ? { document: { path: apk, filename: apk.split('/').pop() ?? 'mood.apk' } } : {}),
  };
}

/** Главное меню привязанного пользователя. */
export function buildClientMenu(user: StoredUser, admin: boolean): BotViewResult {
  const enabled = user.notificationsEnabled !== false;
  const name = user.studentProfile?.fullName?.trim();
  const group = user.groupName?.trim();

  const rows: InlineButton[][] = [
    [
      enabled
        ? btn('🔕 Выключить уведомления', 'notif_off', 'danger')
        : btn('🔔 Включить уведомления', 'notif_on', 'success'),
    ],
    [btn('🔗 Отвязать аккаунт', 'unlink')],
    ...(getPwaUrl() ? [appButtonRow()] : []),
    supportRow(),
  ];

  if (admin) rows.push([btn('🛠 Администратор', 'admin')]);

  return {
    text: joinBlocks([
      `🏠 ${b('Главное меню')}`,
      name ? `${b(name)}${group ? ` · ${group}` : ''}` : '',
      `${enabled ? '🔔' : '🔕'} Уведомления: ${enabled ? b('включены') : b('выключены')}`,
      '',
      i('Уведомления приходят отдельным сообщением. Выключить или включить можно здесь.'),
    ]),
    keyboard: rows,
  };
}

/** Подтверждение отвязки: действие необратимо для Telegram-подписки. */
export function buildUnlinkConfirmView(): BotViewResult {
  return {
    text: joinBlocks([
      `🔗 ${b('Отвязать аккаунт?')}`,
      'Уведомления в Telegram перестанут приходить. Приложение, данные и вход в БАРС останутся.',
      '',
      i('Подключить снова можно в профиле приложения.'),
    ]),
    keyboard: [
      [btn('✅ Да, отвязать', 'unlink_yes', 'danger'), btn('✕ Нет', 'menu')],
    ],
  };
}

/** Результат отвязки. */
export function buildUnlinkedView(): BotViewResult {
  return {
    text: joinBlocks([
      `✅ ${b('Аккаунт отвязан')}`,
      'PWA продолжает работать, данные не тронуты.',
      '',
      'Чтобы вернуть уведомления: открой приложение → профиль → «Подключить уведомления в Telegram».',
      '',
      appLink(),
    ]),
    keyboard: [[btn('🏠 В меню', 'menu')], ...(getPwaUrl() ? [appButtonRow()] : [])],
  };
}

/** Адрес из /start не найден. */
export function buildAccountNotFoundView(): BotViewResult {
  return {
    text: joinBlocks([
      `⚠️ ${b('Аккаунт не найден')}`,
      'Открой приложение и войди заново — после этого нажми «Подключить уведомления в Telegram».',
      '',
      i('Если приложение не установлено — нажми «⬅️ Назад» и выбери платформу.'),
    ]),
    keyboard: [[btn('⬅️ Назад', 'menu_back')], supportRow()].filter((row) => row.length > 0),
  };
}

/** Этот Telegram уже привязан к другой записи: молча перепривязывать нельзя. */
export function buildTgLinkedElsewhereView(): BotViewResult {
  return {
    text: joinBlocks([
      `⚠️ ${b('Этот Telegram уже привязан к другому аккаунту')}`,
      'Сначала отвяжи его в главном меню или в приложении, затем подключи нужный аккаунт.',
    ]),
    keyboard: [[btn('🏠 В меню', 'menu')], supportRow()],
  };
}

/** Целевая запись уже привязана к другому Telegram. */
export function buildTargetLinkedElsewhereView(): BotViewResult {
  return {
    text: joinBlocks([
      `⚠️ ${b('Аккаунт уже привязан к другому Telegram')}`,
      'Отвяжи его там или напиши в поддержку — молча перепривязывать не будем.',
    ]),
    keyboard: [supportRow()],
  };
}

/** `/app` и старые ссылки: показываем приветствие (или меню — решает движок). */
export function buildPwaOpenView(_telegramId: number): BotViewResult {
  return buildWelcomeView();
}
