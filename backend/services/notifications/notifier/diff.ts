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
import type { UserEventData, UserEventGradeItem } from '../../../../db/storage/userEventStore.ts';
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
  /** Структура для нового интерфейса; текст остаётся для старых записей. */
  data?: UserEventData;
  key: string;
}

/**
 * Стабильный ключ приказа.
 *
 * Номер+дата — лучший вариант: они не меняются от перерисовки таблицы.
 * Если номера нет (бывает в части выгрузок), остаётся дата+содержание.
 * Статус намеренно не входит: его изменение — не новый приказ.
 */
export function orderKey(order: OrderItem): string {
  const number = (order.number ?? '').trim();
  const date = (order.date ?? '').trim();
  const title = (order.title ?? '').trim();

  if (number) return `n:${number}|${date}`;
  return `t:${date}|${title}`;
}

/**
 * Сравнивает снимки и формирует список событий.
 * Пустой prev означает базовую линию: уведомления не шлём, только сохраняем.
 */
export function diffSnapshots(
  prev: UserSnapshot | undefined,
  next: UserSnapshot,
  context: {
    orders?: OrderItem[];
    newMailCount?: number;
    /** Для названий и весов КМ в структурированном уведомлении. */
    grades?: SemesterGrades | null;
    /** Для типа/периода/суммы в уведомлении о стипендии. */
    scholarship?: ScholarshipInfo | null;
  } = {},
): NotificationEvent[] {
  if (isBaselineSnapshot(prev) || !prev) return [];

  const events: NotificationEvent[] = [];

  // 1. Новые баллы по контрольным точкам.
  //
  // Снижение и сброс в «нет оценки» уведомлений не порождают: студент не должен
  // получать тревожное сообщение из-за исправления преподавателя. Новым
  // считается закрытая КМ и любой рост уже выставленного балла.
  const changedGrades = Object.entries(next.gradesHash).filter(([key, value]) => {
    if (typeof value !== 'number') return false;
    const before = prev.gradesHash[key];
    return before === undefined || before === null || value > before;
  });

  if (changedGrades.length > 0) {
    const details: string[] = [];
    const items: UserEventGradeItem[] = [];
    for (const [key, value] of changedGrades) {
      if (typeof value !== 'number') continue;

      // Внутренний ключ снимка остаётся с «КТ» — менять его нельзя: старые
      // снимки в базе перестали бы совпадать, и после деплоя все баллы пришли
      // бы разом как новые. Меняется только подпись для человека.
      const idx = key.lastIndexOf('_КТ');
      const discipline = idx > 0 ? key.slice(0, idx) : key;
      const pointRaw = idx > 0 ? key.slice(idx + 1) : '';
      const point = pointRaw.startsWith('КТ') ? `КМ${pointRaw.slice(2)}` : pointRaw;
      const pointNumber = Number(pointRaw.startsWith('КТ') ? pointRaw.slice(2) : '');
      const before = prev.gradesHash[key];
      const delta = typeof before === 'number' ? value - before : null;
      const deltaStr = delta !== null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${fmtNum(delta)})` : '';
      const heading = [discipline, point].filter(Boolean).join(' · ');

      details.push(`${heading}: ${fmtNum(value)}${deltaStr}`.trim());

      const subject = context.grades?.subjects.find(
        (candidate) => candidate.discipline.trim() === discipline,
      );
      const controlPoint = subject?.controlPoints.find(
        (candidate) => candidate.number === pointNumber,
      );

      items.push({
        discipline,
        point: Number.isFinite(pointNumber) ? pointNumber : 0,
        title: controlPoint?.title,
        weight: controlPoint?.weight,
        score: value,
        delta,
      });
    }

    const key = createHash('sha1').update(details.join('|')).digest('hex').slice(0, 16);
    events.push({
      kind: 'grade',
      title: `🎓 ${b('Новые оценки')}`,
      label: 'Новые оценки',
      details,
      data: { type: 'grade', items },
      key: `grade:${key}`,
    });
  }

  // 2. Новое письмо. Содержимое почты не читаем: только количество новых
  // писем, которое уже известно по UID из нотификатора.
  if (next.lastSeenMailUid > prev.lastSeenMailUid) {
    const newMailCount =
      typeof context.newMailCount === 'number' && context.newMailCount > 0
        ? context.newMailCount
        : 0;

    events.push({
      kind: 'mail',
      title: `📧 ${b('Новое письмо')}`,
      label: 'Новое письмо',
      details: newMailCount > 0 ? [`Новых писем: ${newMailCount}`] : [],
      data: { type: 'mail', count: newMailCount },
      key: `mail:${next.lastSeenMailUid}`,
    });
  }

  /*
   * 3. Новый приказ — только по реально новым ключам.
   *
   * `ordersSeen` отсутствует у снимков, созданных до этого фикса. Для них
   * первый круг — миграционная базовая линия: не уведомляем, просто запоминаем
   * текущие приказы. Иначе после деплоя все старые приказы пришли бы разом.
   *
   * Если info не опрашивался, context.orders нет — событие не строим, снимок
   * сохраняет прежнее множество.
   */
  const seenOrders = prev.ordersSeen;
  if (prev.ordersInitialized === true && Array.isArray(seenOrders) && context.orders) {
    const seen = new Set(seenOrders);
    const newOrders = context.orders.filter((order) => !seen.has(orderKey(order)));

    if (newOrders.length > 0) {
      const details = [
        `Новых приказов: ${newOrders.length}`,
        ...newOrders.slice(0, 3).map((order) =>
          [order.number ? `№${order.number}` : '', order.date ?? '', order.title]
            .filter(Boolean)
            .join(' ')
            .trim(),
        ),
      ].filter(Boolean);

      const key = createHash('sha1')
        .update(newOrders.map(orderKey).sort().join('|'))
        .digest('hex')
        .slice(0, 16);

      events.push({
        kind: 'order',
        title: `📄 ${b('Новый приказ')}`,
        label: 'Новый приказ',
        details,
        data: {
          type: 'order',
          items: newOrders.slice(0, 3).map((order) => ({
            number: order.number,
            date: order.date,
            title: order.title,
          })),
        },
        key: `order:${key}`,
      });
    }
  }

  // 4. Стипендия: только факт назначения или отмены.
  //
  // Смена типа или периода — не повод для уведомления: в БАРС такие поля
  // обновляются и без изменения самой выплаты. Сравниваем именно состояние
  // «назначена / не назначена».
  const wasAppointed = (prev.scholarshipStatus ?? 'нет') !== 'нет';
  const isAppointed = (next.scholarshipStatus ?? 'нет') !== 'нет';

  if (wasAppointed !== isAppointed) {
    events.push({
      kind: 'scholarship',
      // Формулировка Telegram не меняется: бот по-прежнему получает только
      // тип события. Конкретика «назначена/отменена» — для приложения.
      title: `💰 ${b('Изменилась стипендия')}`,
      label: isAppointed ? 'Назначена стипендия' : 'Стипендия отменена',
      details: isAppointed
        ? [`Назначена: ${next.scholarshipStatus}`]
        : ['Выплата стипендии отменена'],
      data: {
        type: 'scholarship',
        appointed: isAppointed,
        scholarshipType: context.scholarship?.type,
        period: context.scholarship?.period,
        amount: context.scholarship?.amount,
      },
      key: `scholarship:${isAppointed ? 'on' : 'off'}:${next.scholarshipStatus}`,
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
