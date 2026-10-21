/**
 * Диффы снимков и сборка текста уведомления — чистая логика без сети.
 *
 * Сравниваются два снимка одного пользователя и формируются события: новые
 * баллы, письма, приказы, смена стипендии. Пустой/базовый предыдущий снимок
 * уведомлений не порождает.
 */

import { b } from '../../../../tg/format.js';
import { isBaselineSnapshot, type UserSnapshot } from '../../../../db/storage/snapshotStore.js';
import type { SemesterGrades } from '../../bars/parsers/gradesParser.js';
import type { ScholarshipInfo } from '../../bars/parsers/studentInfoParser.js';

/**
 * Собирает ключи баллов вида "Дисциплина_КТ1" из страницы успеваемости.
 * null означает, что контрольная точка ещё не закрыта баллом.
 */
export function buildGradesHash(grades: SemesterGrades): Record<string, number | null> {
  const out: Record<string, number | null> = {};

  for (const subject of grades.subjects) {
    const discipline = subject.discipline.trim();
    for (const point of subject.controlPoints) {
      out[`${discipline}_КТ${point.number}`] = point.score;
    }
  }

  return out;
}

/**
 * Нормализует статус стипендии в короткую строку для сравнения.
 */
export function buildScholarshipStatus(scholarship: ScholarshipInfo): string {
  if (!scholarship.isAppointed) return 'нет';
  return [scholarship.type, scholarship.period].filter(Boolean).join(', ') || 'назначена';
}

/**
 * Определяет, является ли ошибка сетевой/серверной, а не логической.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? '';

  return (
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up/i.test(
      `${message} ${code}`,
    ) ||
    /HTTP error (429|500|502|503|504)|status code (429|500|502|503|504)/i.test(message) ||
    /Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-out/i.test(message) ||
    /\b(429|500|502|503|504)\b/.test(message)
  );
}

/**
 * Событие, готовое к отправке студенту.
 */
export interface NotificationEvent {
  kind: 'grade' | 'mail' | 'order' | 'scholarship';
  /** Только тип события. Никаких дисциплин, баллов, тем и статусов. */
  title: string;
}

/**
 * Сравнивает снимки и формирует список событий.
 * Пустой prev означает базовую линию: уведомления не шлём, только сохраняем.
 */
export function diffSnapshots(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
): NotificationEvent[] {
  if (isBaselineSnapshot(prev) || !prev) return [];

  const events: NotificationEvent[] = [];

  // 1. Новые баллы по контрольным точкам
  const changedGrades = Object.entries(next.gradesHash).filter(
    ([key, value]) =>
      value !== null &&
      (prev.gradesHash[key] === undefined || prev.gradesHash[key] === null || prev.gradesHash[key] !== value),
  );

  if (changedGrades.length > 0) {
    events.push({
      kind: 'grade',
      title: `🎓 ${b('Новые оценки')}`,
    });
  }

  // 2. Новое письмо
  if (next.lastSeenMailUid > prev.lastSeenMailUid) {
    events.push({
      kind: 'mail',
      title: `📧 ${b('Новое письмо')}`,
    });
  }

  // 3. Новый приказ
  if (next.ordersCount > prev.ordersCount) {
    events.push({
      kind: 'order',
      title: `📄 ${b('Новый приказ')}`,
    });
  }

  // 4. Изменение стипендии
  if (next.scholarshipStatus !== prev.scholarshipStatus) {
    events.push({
      kind: 'scholarship',
      title: `💰 ${b('Изменилась стипендия')}`,
    });
  }

  return events;
}

/**
 * Текст уведомления для Telegram.
 *
 * Только тип события: без дисциплин, баллов, тем писем, номеров приказов и
 * статусов стипендии. Деталей нет и в самом объекте события — в Telegram они
 * не уходят, а приложению они не нужны.
 */
export function renderNotification(event: NotificationEvent): string {
  return event.title;
}
