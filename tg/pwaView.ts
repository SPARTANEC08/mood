/**
 * Экраны бота поддержки.
 *
 * Telegram больше не платформа приложения: здесь только ссылки на PWA, канал,
 * GitHub, поддержку и инструкции установки. Ни данных студента, ни привязки,
 * ни уведомлений — всё это живёт в приложении.
 */

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
export const GITHUB_URL = 'https://github.com/SPARTANEC08/mood';

function appLink(): string {
  const url = getPwaUrl();
  return url ? link(url, '🌐 Открыть Mood') : quote('Веб-приложение ещё не настроено на сервере.');
}

function appButtonRow(): InlineButton[] {
  const url = getPwaUrl();
  return url ? [urlBtn('🌐 Открыть Mood', url)] : [];
}

function supportRow(): InlineButton[] {
  return [
    urlBtn('📣 Канал', CHANNEL_URL),
    urlBtn('💬 Поддержка', SUPPORT_URL),
    urlBtn('🐙 GitHub', GITHUB_URL),
  ];
}

/** Главный экран: приложение, установка, поддержка. */
export function buildWelcomeView(): BotViewResult {
  return {
    text: joinBlocks([
      `👋 ${b('Mood')}`,
      'Расписание, задания, оценки и почта — в приложении.',
      '',
      b('Установка'),
      '• iPhone — откройте сайт в Safari → «Поделиться» → «На экран Домой».',
      '• Android — установите APK или в Chrome выберите «Установить приложение».',
      '',
      'Уведомления включаются в приложении: Кабинет → Настройки приложения → Push-уведомления.',
      '',
      RULE,
      '',
      i('Поддержка: @mood_mpei_sup'),
      '',
      appLink(),
    ]),
    keyboard: [
      ...(appButtonRow().length > 0 ? [appButtonRow()] : []),
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
      '1. Откройте сайт в Safari (именно Safari, не Chrome).',
      '2. Нажмите «Поделиться» → «На экран Домой» → «Добавить».',
      '3. Запустите Mood с иконки и войдите логином и паролем БАРС.',
      '4. Уведомления включите в приложении: Кабинет → Настройки приложения.',
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
      '1. Установите APK из сообщения ниже (разрешите установку из неизвестных источников).',
      '2. Откройте Mood и войдите логином и паролем БАРС.',
      '3. Уведомления включите в приложении: Кабинет → Настройки приложения.',
      '',
      apk
        ? i('Файл пришлю следующим сообщением.')
        : i('APK пока не собран на сервере.'),
      i('Можно и как PWA: Chrome → меню ⋮ → «Установить приложение».'),
      '',
      appLink(),
    ]),
    keyboard: [[btn('⬅️ Назад', 'menu_back')], supportRow()].filter((row) => row.length > 0),
    ...(apk ? { document: { path: apk, filename: apk.split('/').pop() ?? 'mood.apk' } } : {}),
  };
}
