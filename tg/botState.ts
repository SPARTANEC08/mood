/**
 * Короткоживущие состояния диалога (FSM) для админских действий.
 *
 * Состояние лежит на диске (`db/data/bot_flows.json`), поэтому переживает
 * рестарт сервиса: админ, пришедший с «жду текст рассылки», после рестарта
 * продолжает с того же места, а не видит внезапно меню.
 *
 * TTL обязателен: без него неверно нажатая кнопка оставляла бы бота в режиме
 * «жду текст» навсегда, и следующий обычный вопрос админа уходил бы в рассылку.
 * Протухшее состояние не просто удаляется — по нему запоминается «уведомление»,
 * чтобы бот ответил «сессия истекла, начните заново», а не промолчал.
 */

import { botFlowsStore, type BotFlowKind } from '../db/storage/botFlowsStore.ts';

export type { BotFlowKind } from '../db/storage/botFlowsStore.ts';

export interface BotFlow {
  kind: BotFlowKind;
  startedAt: number;
  data?: string;
}

/** Сколько ждём ответа админа. */
export const BOT_FLOW_TTL_MS = 5 * 60 * 1000;

/**
 * Сколько помним протухшее состояние, чтобы объяснить «сессия истекла».
 * Больше TTL, но не бесконечно: через полчаса админ уже и не помнит, что ждал.
 */
export const BOT_FLOW_NOTICE_TTL_MS = 30 * 60 * 1000;

/** Протухшие состояния по telegramId: kind и когда протухло. */
const expired = new Map<number, { kind: BotFlowKind; at: number }>();

export function setFlow(telegramId: number, kind: BotFlowKind, data?: string): void {
  expired.delete(telegramId);
  botFlowsStore.set({ telegramId, kind, startedAt: Date.now(), ...(data !== undefined ? { data } : {}) });
}

/** Текущее состояние или null, если его нет/оно протухло. */
export function getFlow(telegramId: number, now: number = Date.now()): BotFlow | null {
  const flow = botFlowsStore.get(telegramId);
  if (!flow) return null;

  if (now - flow.startedAt > BOT_FLOW_TTL_MS) {
    botFlowsStore.delete(telegramId);
    expired.set(telegramId, { kind: flow.kind, at: now });
    return null;
  }

  return { kind: flow.kind, startedAt: flow.startedAt, ...(flow.data !== undefined ? { data: flow.data } : {}) };
}

/** Обновляет данные внутри текущего состояния (текст рассылки, ID). */
export function setFlowData(telegramId: number, data: string): void {
  const flow = botFlowsStore.get(telegramId);
  if (flow) botFlowsStore.set({ ...flow, data });
}

export function clearFlow(telegramId: number): void {
  botFlowsStore.delete(telegramId);
  expired.delete(telegramId);
}

/**
 * «Сессия истекла» — один раз на протухшее состояние. Возвращает kind, если
 * админу нужно объяснить, что ожидание сброшено; после вызова забывает его.
 */
export function takeExpiredNotice(telegramId: number, now: number = Date.now()): BotFlowKind | null {
  const entry = expired.get(telegramId);
  if (!entry) return null;

  expired.delete(telegramId);
  if (now - entry.at > BOT_FLOW_NOTICE_TTL_MS) return null;
  return entry.kind;
}

/** Сколько состояний сейчас в памяти+на диске. Только для диагностики/тестов. */
export function botFlowCount(): number {
  return botFlowsStore.all().length;
}

/** Сброс для тестов: иначе состояние протекает между прогонами. */
export function resetFlows(): void {
  botFlowsStore.clearAll();
  expired.clear();
}
