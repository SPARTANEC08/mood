import { b, esc, i, quote, RULE, toneButton } from './format.ts';
import { BotViewResult } from './scheduleView.ts';

/**
 * Экран входа в БАРС МЭИ — шаг 1: запрос логина.
 */
export function buildLoginPromptView(firstName?: string, error?: string): BotViewResult {
  const lines: string[] = [
    `👋 ${b('Добро пожаловать в Zbot!')}`,
    '',
    'Доступ к расписанию и сервисам МЭИ — через единую учётную запись БАРС.',
  ];

  if (firstName) {
    lines.push('', i(`С возвращением, ${esc(firstName)}.`));
  }

  if (error) {
    lines.push('', `❌ ${esc(error)}`);
  }

  lines.push('', RULE, `Введите ${b('логин')} от личного кабинета:`);
  lines.push(i('   например: st123456'));

  return { text: lines.join('\n'), keyboard: [] };
}

/**
 * Экран входа — шаг 2: запрос пароля.
 */
export function buildPasswordPromptView(login: string): BotViewResult {
  return {
    text: [
      `🔒 Логин: ${b(esc(login))}`,
      '',
      'Введите пароль от личного кабинета МЭИ:',
      '',
      quote('Сообщение с паролем будет удалено сразу после отправки.'),
    ].join('\n'),
    keyboard: [],
  };
}

/**
 * Экран входа — шаг 3: запрос кода двухфакторной аутентификации.
 */
export function buildTwoFactorPromptView(channelHint?: string): BotViewResult {
  const lines = [
    `📲 ${b('Двухфакторная аутентификация')}`,
    '',
    'Код подтверждения отправлен на ваш телефон или почту МЭИ.',
  ];

  if (channelHint) {
    lines.push('', i(`Канал: ${esc(channelHint)}`));
  }

  lines.push('', RULE, `Введите ${b('код')} из сообщения:`);

  return { text: lines.join('\n'), keyboard: [] };
}

/**
 * Технический экран: подключение к БАРС МЭИ.
 */
export function buildBarsConnectingView(login: string): BotViewResult {
  return {
    text: [
      '⏳ ' + b('Подключение к БАРС МЭИ...'),
      '',
      quote(`Логин: ${esc(login)}`),
      '',
      i('Это занимает несколько секунд.'),
    ].join('\n'),
    keyboard: [],
  };
}

/**
 * Экран ошибки авторизации с возможностью начать заново.
 */
export function buildAuthErrorView(error: string, login?: string): BotViewResult {
  const lines = [`❌ ${b(esc(error))}`];

  if (login) {
    lines.push('', quote(`Логин: ${esc(login)}`));
  }

  lines.push('', RULE, 'Можно начать вход заново.');

  return {
    text: lines.join('\n'),
    keyboard: [[toneButton('🔄 Начать заново', 'neutral', 'auth_restart')]],
  };
}

/**
 * Экран успешного выхода из аккаунта БАРС.
 */
export function buildLogoutView(): BotViewResult {
  return {
    text: [
      `🚪 ${b('Вы вышли из аккаунта БАРС МЭИ')}`,
      '',
      quote('Зашифрованные данные доступа и сохранённая сессия удалены.'),
      '',
      RULE,
      `Введите ${b('логин')}: ${i('например, st123456')}`,
    ].join('\n'),
    keyboard: [],
  };
}