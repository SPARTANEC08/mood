/**
 * Диффы снимков и сборка текста уведомления — чистая логика без сети.
 *
 * Сравниваются два снимка одного пользователя и формируются события: новые
 * баллы, письма, приказы, смена стипендии. Пустой/базовый предыдущий снимок
 * уведомлений не порождает.
 */

import { b, esc, fmtNum, i, RULE } from '../../../bot/format.js';
import { isBaselineSnapshot, type UserSnapshot } from '../../../storage/snapshotStore.js';
import type { SemesterGrades } from '../../bars/parsers/gradesParser.js';
import type { OrderItem, ScholarshipInfo } from '../../bars/parsers/studentInfoParser.js';
import type { OsepMessageBrief } from '../../mail/types.js';

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
  title: string;
  lines: string[];
}

function truncate(value: string, max: number): string {
  const clean = (value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Сравнивает снимки и формирует список событий.
 * Пустой prev означает базовую линию: уведомления не шлём, только сохраняем.
 */
export function diffSnapshots(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
  context: {
    grades?: SemesterGrades;
    mails?: OsepMessageBrief[];
    orders?: OrderItem[];
  } = {},
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
    const lines = changedGrades.map(([key, value]) => {
      const idx = key.lastIndexOf('_КТ');
      const discipline = idx > 0 ? key.slice(0, idx) : key;
      const point = idx > 0 ? key.slice(idx + 1) : '';
      const before = prev.gradesHash[key];
      const delta =
        before !== null && before !== undefined && typeof before === 'number' && value !== null
          ? value - before
          : null;
      const deltaStr = delta !== null && delta !== 0 ? ` ${i(`(${delta > 0 ? '+' : ''}${fmtNum(delta)})`)}` : '';
      return `• ${b(esc(truncate(discipline, 60)))} ${i(esc(point))}: ${b(fmtNum(value))}${deltaStr}`;
    });

    events.push({
      kind: 'grade',
      title: `📊 ${b('Новые баллы в БАРС')}`,
      lines,
    });
  }

  // 2. Новые письма ОСЭП
  if (next.lastSeenMailUid > prev.lastSeenMailUid) {
    const fresh = (context.mails ?? [])
      .filter((m) => m.uid > prev.lastSeenMailUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, 5);

    const lines = fresh.length > 0
      ? fresh.map((m) => {
          const att = m.hasAttachments ? '  📎' : '';
          return `• ${b(esc(truncate(m.subject, 60)))}${att}\n   ${i(esc(truncate(m.from, 40)))}`;
        })
      : [i('Подробнее — в разделе «📬 ОСЭП».')];

    events.push({
      kind: 'mail',
      title: `📬 ${b('Новое письмо на почте МЭИ')}`,
      lines,
    });
  }

  // 3. Новые приказы
  if (next.ordersCount > prev.ordersCount) {
    const added = Math.max(0, next.ordersCount - prev.ordersCount);
    const latest = (context.orders ?? []).slice(0, 3).map((o) => {
      const num = o.number ? `№${esc(o.number)}` : '';
      const date = o.date ? ` от ${esc(o.date)}` : '';
      return `• ${i(`${num}${date}`.trim())} ${esc(truncate(o.title, 60))}`;
    });

    events.push({
      kind: 'order',
      title: `📜 ${b('Новые приказы')}`,
      lines: [`Новых приказов: ${b(String(added))}`, ...latest],
    });
  }

  // 4. Изменение стипендии
  if (next.scholarshipStatus !== prev.scholarshipStatus) {
    events.push({
      kind: 'scholarship',
      title: `🎓 ${b('Изменение стипендии')}`,
      lines: [`Статус: ${esc(next.scholarshipStatus)}`],
    });
  }

  return events;
}

/**
 * Собирает текст сообщения из событий.
 *
 * Снизу добавляется подпись: главное сообщение бота перезаписывается при каждом
 * действии, а уведомление остаётся в переписке. Без пояснения кнопка «Скрыть»
 * выглядит неожиданно, и часть пользователей просто её не нажимает.
 */
export function renderNotification(events: NotificationEvent[]): string {
  const blocks = events.map((event) => [event.title, RULE, ...event.lines].join('\n'));
  return [...blocks, i('Сообщение можно скрыть кнопкой ниже.')].join('\n\n');
}
