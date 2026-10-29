/**
 * Журнал согласий: append-only история акцептов и отзывов.
 *
 * В `StoredUser.consents` лежит только текущее состояние для быстрых проверок.
 * Здесь — доказательная база: когда, с какого IP и каким способом человек
 * принял конкретную версию документа. Записи не перезаписываются.
 */

import { randomUUID } from 'node:crypto';

import { JsonDocument } from '../jsonStore.ts';
import type { ConsentLogRecord, LegalDocId } from '../../backend/legal/types.ts';

interface ConsentsDocument {
  records: ConsentLogRecord[];
}

const document = new JsonDocument<ConsentsDocument>('consents.json');

function read(): ConsentsDocument {
  const doc = document.read();
  if (!Array.isArray(doc.records)) doc.records = [];
  return doc;
}

export const consentStore = {
  /** Последняя активная запись по типу (для проверки дублей). */
  latestActive(userId: string, type: LegalDocId): ConsentLogRecord | undefined {
    const records = read().records;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (record.userId === userId && record.type === type && !record.revokedAt) return record;
    }
    return undefined;
  },

  /**
   * Фиксирует акцепт. Повторный акцепт той же версии не создаёт дубль:
   * человек мог дважды отправить форму или перезагрузить экран.
   */
  accept(
    userId: string,
    type: LegalDocId,
    version: string,
    meta: { ip?: string; method: 'pwa' | 'bot' },
  ): ConsentLogRecord {
    const existing = this.latestActive(userId, type);
    if (existing && existing.version === version) return existing;

    const record: ConsentLogRecord = {
      id: randomUUID(),
      userId,
      type,
      version,
      acceptedAt: new Date().toISOString(),
      ip: meta.ip,
      method: meta.method,
    };

    const doc = read();
    doc.records.push(record);
    document.save();
    return record;
  },

  /** Отмечает последний активный акцепт отозванным. */
  revoke(userId: string, type: LegalDocId): ConsentLogRecord | undefined {
    const existing = this.latestActive(userId, type);
    if (!existing) return undefined;

    existing.revokedAt = new Date().toISOString();
    document.save();
    return existing;
  },

  /** История пользователя в порядке добавления. */
  listForUser(userId: string): ConsentLogRecord[] {
    return read().records.filter((record) => record.userId === userId);
  },

  all(): ConsentLogRecord[] {
    return [...read().records];
  },
};
