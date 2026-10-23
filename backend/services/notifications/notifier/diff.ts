/**
 * Диффы снимков и сборка текста уведомления — чистая логика без сети.
 *
 * Сравниваются два снимка одного пользователя и формируются события: новые
 * баллы, письма, приказы, смена стипендии. Пустой/базовый предыдущий снимок
 * уведомлений не порождает.
 */

import { createHash } from 'node:crypto';

import { b, fmtNum } from '../../../../tg/format.js';
import { isBaselineSnapshot, type UserSnapshot } from '../../../../db/storage/snapshotStore.js';
import type { SemesterGrades } from '../../bars/parsers/gradesParser.js';
import type { OrderItem, ScholarshipInfo } from '../../bars/parsers/studentInfoParser.js';

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
 *
 * `title` — HTML для Telegram (там только тип). `label` и `details` — для
 * приложения: там можно показать конкретику. `key` стабилен, чтобы повторный
 * круг нотификатора не создал дубль в in-app уведомлениях.
 */
export interface NotificationEvent {
  kind: 'grade' | 'mail' | 'order' | 'scholarship';
  title: string;
  label: string;
  details: string[];
  key: string;
}

/**
 * Сравнивает снимки и формирует список событий.
 * Пустой prev означает базовую линию: уведомления не шлём, только сохраняем.
 */
export function diffSnapshots(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
  context: { orders?: OrderItem[] } = {},
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
    const gained = changedGrades.reduce((sum, [key, value]) => {
      if (typeof value !== 'number') return sum;
      const before = prev.gradesHash[key];
      const delta = typeof before === 'number' ? value - before : value;
      return sum + Math.max(0, delta);
    }, 0);

    const details: string[] = [];
    for (const [key, value] of changedGrades) {
      if (typeof value !== 'number') continue;
      const idx = key.lastIndexOf('_КТ');
      const discipline = idx > 0 ? key.slice(0, idx) : key;
      const point = idx > 0 ? key.slice(idx + 1) : '';
      const before = prev.gradesHash[key];
      const delta = typeof before === 'number' ? value - before : null;
      const deltaStr = delta !== null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${fmtNum(delta)})` : '';
      details.push(`${discipline} ${point}: ${fmtNum(value)}${deltaStr}`.trim());
    }
    if (gained > 0) details.unshift(`За неделю: +${fmtNum(gained)}`);

    const key = createHash('sha1').update(details.join('|')).digest('hex').slice(0, 16);
    events.push({
      kind: 'grade',
      title: `🎓 ${b('Новые оценки')}`,
      label: 'Новые оценки',
      details,
      key: `grade:${key}`,
    });
  }

  // 2. Новое письмо — без деталей: почту в приложении не читаем.
  if (next.lastSeenMailUid > prev.lastSeenMailUid) {
    events.push({
      kind: 'mail',
      title: `📧 ${b('Новое письмо')}`,
      label: 'Новое письмо',
      details: [],
      key: `mail:${next.lastSeenMailUid}`,
    });
  }

  // 3. Новый приказ
  if (next.ordersCount > prev.ordersCount) {
    const added = Math.max(0, next.ordersCount - prev.ordersCount);
    const latest = (context.orders ?? [])
      .slice(0, 3)
      .map((order) =>
        [order.number ? `№${order.number}` : '', order.date ?? '', order.title]
          .filter(Boolean)
          .join(' ')
          .trim(),
      )
      .filter(Boolean);

    events.push({
      kind: 'order',
      title: `📄 ${b('Новый приказ')}`,
      label: 'Новый приказ',
      details: [`Новых приказов: ${added}`, ...latest],
      key: `order:${next.ordersCount}`,
    });
  }

  // 4. Изменение стипендии
  if (next.scholarshipStatus !== prev.scholarshipStatus) {
    events.push({
      kind: 'scholarship',
      title: `💰 ${b('Изменилась стипендия')}`,
      label: 'Изменилась стипендия',
      details: [`Статус: ${next.scholarshipStatus}`],
      key: `scholarship:${next.scholarshipStatus}`,
    });
  }

  return events;
}

/**
 * Текст уведомления для Telegram.
 *
 * Только тип события. Конкретика лежит в `label`/`details` и показывается
 * приложением, а не Telegram.
 */
export function renderNotification(event: Pick<NotificationEvent, 'title'>): string {
  return event.title;
}
