/**
 * Экраны бота поддержки.
 *
 * Telegram больше не платформа приложения: здесь только ссылки на PWA, канал,
 * GitHub, поддержку и установку. Ни данных студента, ни привязки, ни
 * уведомлений — всё это живёт в приложении.
 *
 * Инструкции по установке больше не дублируются в боте: он отправляет на
 * лендинг, в раздел «Установка», где шаги уже описаны с картинками. На
 * Android дополнительно есть кнопка с постом последней версии APK в Telegram.
 */

import { b, i, joinBlocks } from './format.ts';

/** Кнопка Telegram: либо callback, либо ссылка. */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: 'danger' | 'success' | 'primary';
}

/** Что показать: текст и клавиатура. */
export interface BotViewResult {
  text: string;
  keyboard: InlineButton[][];
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

/** Адрес раздела установки на лендинге. */
function installUrl(): string | null {
  const url = getPwaUrl();
  return url ? `${url}/#install` : null;
}

export const CHANNEL_URL = 'https://t.me/mood_mpei';
export const SUPPORT_URL = 'https://t.me/mood_mpei_sup';
export const GITHUB_URL = 'https://github.com/SPARTANEC08/mood';

/** Пост с последней версией APK, если TELEGRAM_APK_POST_URL не задан. */
export const DEFAULT_APK_POST_URL = 'https://t.me/mood_mpei/15';

/**
 * Ссылка на пост с последней версией APK.
 *
 * Вынесена в окружение, чтобы менять пост после каждого релиза без пересборки
 * бота. Значение по умолчанию — актуальный пост канала на момент правки.
 */
export function getApkPostUrl(): string {
  const raw = process.env.TELEGRAM_APK_POST_URL?.trim();
  if (!raw) return DEFAULT_APK_POST_URL;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return DEFAULT_APK_POST_URL;
    return raw;
  } catch {
    console.warn('[APK] TELEGRAM_APK_POST_URL задан, но не разбирается как URL — беру значение по умолчанию');
    return DEFAULT_APK_POST_URL;
  }
}

function installButtonRow(): InlineButton[] {
  const url = installUrl();
  return url ? [urlBtn('📲 Установить', url)] : [];
}

function instructionButtonRow(): InlineButton[] {
  const url = installUrl();
  return url ? [urlBtn('🌐 Инструкция на сайте', url)] : [];
}

function backButtonRow(): InlineButton[] {
  return [btn('⬅️ Назад', 'menu_back')];
}

function supportRow(): InlineButton[] {
  return [
    urlBtn('📣 Канал', CHANNEL_URL),
    urlBtn('💬 Поддержка', SUPPORT_URL),
    urlBtn('🐙 GitHub', GITHUB_URL),
  ];
}

/** Главный экран: установка, платформы и ссылки на источники. */
export function buildWelcomeView(): BotViewResult {
  return {
    text: joinBlocks([
      `👋 ${b('Mood')}`,
      'Расписание, задания, оценки и почта МЭИ — в приложении.',
      '',
      'Выберите платформу — покажу, как установить.',
    ]),
    keyboard: [
      ...(installButtonRow().length > 0 ? [installButtonRow()] : []),
      [btn('📱 iOS', 'platform_ios'), btn('🤖 Android', 'platform_android')],
      supportRow(),
    ],
  };
}

/** iOS: подробная инструкция живёт на лендинге. */
export function buildIosGuideView(): BotViewResult {
  return {
    text: joinBlocks([
      `🍎 ${b('iPhone / iPad')}`,
      'Откройте сайт — там пошаговая инструкция с картинками.',
      '',
      i('Установка идёт через Safari: «Поделиться» → «На экран “Домой”».'),
    ]),
    keyboard: [instructionButtonRow(), backButtonRow()].filter((row) => row.length > 0),
  };
}

/** Android: та же инструкция на сайте плюс пост с последней версией APK. */
export function buildAndroidGuideView(): BotViewResult {
  return {
    text: joinBlocks([
      `🤖 ${b('Android')}`,
      'Откройте сайт — там пошаговая инструкция с картинками.',
      'Последнюю версию APK можно скачать в Telegram.',
      '',
      i('Можно и как PWA: Chrome → меню ⋮ → «Установить приложение».'),
    ]),
    keyboard: [
      [urlBtn('⬇️ Скачать из Telegram', getApkPostUrl())],
      ...(instructionButtonRow().length > 0 ? [instructionButtonRow()] : []),
      backButtonRow(),
    ],
  };
}
