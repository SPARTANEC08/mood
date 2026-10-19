/**
 * Хранилище коротких состояний диалога (FSM) бота.
 *
 * Почему на диске, а не в памяти: состояние переживает рестарт сервиса. Раньше
 * рестарт посреди рассылки оставлял админа в недоумении — он присылал текст,
 * а бот отвечал меню, будто ничего не ждал. Теперь ожидание сохраняется, а
 * протухшее (TTL) обрабатывается отдельно и внятно.
 *
 * Живёт рядом с остальными данными (`db/data/bot_flows.json`), права те же —
 * 0600/0700. Данных немного: одна запись на админа с активным действием.
 */

import { JsonStore } from '../jsonStore.ts';

export type BotFlowKind = 'broadcast_text' | 'admin_add_id';

export interface StoredBotFlow {
  telegramId: number;
  kind: BotFlowKind;
  startedAt: number;
  /** Черновик текста рассылки или Telegram ID — зависит от kind. */
  data?: string;
}

const store = new JsonStore<StoredBotFlow>('bot_flows.json');

export const botFlowsStore = {
  get(telegramId: number): StoredBotFlow | undefined {
    return store.get(telegramId);
  },

  set(flow: StoredBotFlow): void {
    store.set(flow.telegramId, flow);
  },

  delete(telegramId: number): void {
    store.delete(telegramId);
  },

  all(): StoredBotFlow[] {
    return store.values();
  },

  /** Сброс для тестов. */
  clearAll(): void {
    for (const flow of store.values()) store.delete(flow.telegramId);
  },
};
