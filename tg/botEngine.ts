/**
 * Логика бота поддержки.
 *
 * Никаких аккаунтов, привязок, уведомлений и админских экранов: Telegram
 * оставлен как канал «открыть приложение / поддержка». Поэтому здесь только
 * выбор экрана по команде или кнопке.
 */

import {
  buildAndroidGuideView,
  buildIosGuideView,
  buildWelcomeView,
  type BotViewResult,
} from './pwaView.ts';

export interface BotSender {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface ProcessResult {
  view: BotViewResult;
  toast?: string;
  deleteCurrent?: boolean;
  forceNewMessage?: boolean;
}

/** Любой текст и /start показывают главный экран со ссылками. */
export async function processTelegramMessage(
  _sender: BotSender,
  text: string,
): Promise<ProcessResult> {
  const command = text.trim().toLowerCase();

  if (command.startsWith('/ios')) return { view: buildIosGuideView() };
  if (command.startsWith('/android')) return { view: buildAndroidGuideView() };

  return { view: buildWelcomeView() };
}

/** Кнопки: установка по платформам и возврат в меню. */
export async function processTelegramCallback(
  _sender: BotSender,
  data: string,
): Promise<ProcessResult> {
  if (data === 'platform_ios') return { view: buildIosGuideView() };
  if (data === 'platform_android') return { view: buildAndroidGuideView() };
  return { view: buildWelcomeView() };
}
