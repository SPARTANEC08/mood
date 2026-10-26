import * as cheerio from 'cheerio';

import { cleanText } from './shared.ts';

export interface OrderItem {
  number: string;
  date: string;
  title: string;       // Например: "О зачислении", "О назначении государственной академической стипендии"
  status?: string;
}

export interface ScholarshipItem {
  type: string;         // Академическая, социальная, повышенная
  period?: string;      // Срок действия назначения
  amount?: string;      // Сумма (если отображается)
  startDate?: string;   // Как в БАРС, DD.MM.YYYY
  endDate?: string;
  /** Действует ли назначение на момент разбора. */
  isActive: boolean;
}

export interface ScholarshipInfo {
  isAppointed: boolean; // Назначена ли хотя бы одна действующая стипендия
  type?: string;        // Первое активное назначение — для старых потребителей
  period?: string;
  amount?: string;
  /** Все назначения из таблицы БАРС, включая завершённые. */
  items?: ScholarshipItem[];
}

export interface LibraryBook {
  title: string;
  author?: string;
  issueDate: string;   // Дата выдачи
  dueDate: string;     // Срок сдачи
  isOverdue: boolean;  // Просрочена ли книга
}

/**
 * Парсит дату формата DD.MM.YYYY в объект Date.
 */
function parseDate(dateStr: string, endOfDay = true): Date | null {
  const match = dateStr.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  return endOfDay
    ? new Date(year, month, day, 23, 59, 59, 999)
    : new Date(year, month, day, 0, 0, 0, 0);
}

/**
 * Действует ли стипендия в указанный момент.
 *
 * Если дат нет вовсе — считаем действующей: БАРС иногда отдаёт сокращённую
 * таблицу без периода. Если дата одна, ограничиваем только ей.
 */
function isScholarshipActive(startDate: string, endDate: string, now: Date): boolean {
  const start = parseDate(startDate, false);
  const end = parseDate(endDate, true);

  if (!start && !end) return true;
  if (start && now.getTime() < start.getTime()) return false;
  if (end && now.getTime() > end.getTime()) return false;
  return true;
}

/**
 * Проверяет, просрочена ли дата сдачи относительно текущего момента.
 */
function isDateOverdue(dueDateStr: string): boolean {
  const due = parseDate(dueDateStr);
  if (!due) return false;
  return due.getTime() < Date.now();
}

/**
 * Парсит таблицу приказов по студенту.
 */
export function parseOrders($: cheerio.CheerioAPI): OrderItem[] {
  const orders: OrderItem[] = [];

  // Поиск таблицы приказов (#tbl__PartialListStudent__Order или любая таблица с приказами)
  let table = $('#tbl__PartialListStudent__Order');
  if (!table.length) {
    $('table').each((_, t) => {
      const text = $(t).text().toLowerCase();
      if (text.includes('приказ') && (text.includes('содержание') || text.includes('дата'))) {
        table = $(t);
        return false;
      }
    });
  }

  if (!table.length) {
    return orders;
  }

  // Определение индексов колонок
  let numCol = 0;
  let dateCol = 1;
  let titleCol = 2;
  let statusCol = -1;

  table.find('thead tr th').each((idx, th) => {
    const text = cleanText($(th).text()).toLowerCase();
    if (text.includes('№') || text.includes('номер')) {
      numCol = idx;
    } else if (text.includes('дата')) {
      dateCol = idx;
    } else if (text.includes('содержание') || text.includes('наименование') || text.includes('суть')) {
      titleCol = idx;
    } else if (text.includes('статус') || text.includes('состояние')) {
      statusCol = idx;
    }
  });

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;

    const number = cleanText($(tds[numCol] || tds[0]).text());
    const date = cleanText($(tds[dateCol] || tds[1]).text());
    const title = cleanText($(tds[titleCol] || tds[2]).text());
    const status = statusCol !== -1 ? cleanText($(tds[statusCol]).text()) || undefined : undefined;

    if (number || title) {
      orders.push({
        number,
        date,
        title,
        status,
      });
    }
  });

  return orders;
}

/**
 * Парсит данные о назначенной стипендии студента.
 */
export function parseScholarship(
  $: cheerio.CheerioAPI,
  now: Date = new Date(),
): ScholarshipInfo {
  // 1. Поиск таблицы со стипендиями
  let table = $('table').filter((_, t) => {
    const text = $(t).text().toLowerCase();
    return text.includes('стипенди') || (text.includes('дата начала') && text.includes('вид'));
  }).first();

  // Никакого fallback на первую таблицу: на странице оценок она тоже есть, и
  // тогда КМ/даты выдаются за стипендии. Если таблицы с нужными заголовками
  // нет — пусть разбор вернёт пусто, а scraper повторит запрос.
  const items: ScholarshipItem[] = [];

  if (table.length) {
    let startCol = -1;
    let endCol = -1;
    let typeCol = -1;
    let amountCol = -1;

    table.find('thead tr th').each((idx, th) => {
      const text = cleanText($(th).text()).toLowerCase();
      if (text.includes('начала')) startCol = idx;
      else if (text.includes('окончания')) endCol = idx;
      else if (text.includes('вид') || text.includes('тип')) typeCol = idx;
      else if (text.includes('размер') || text.includes('сумма')) amountCol = idx;
    });

    // Не у всех таблиц БАРС есть tbody. Берём строки с td в любом случае.
    let rows = table.find('tbody tr');
    if (rows.length === 0) {
      rows = table.find('tr').filter((_, tr) => $(tr).find('td').length > 0);
    }

    const seen = new Set<string>();

    rows.each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;

      const startDate = startCol !== -1 ? cleanText($(tds[startCol]).text()) : '';
      const endDate = endCol !== -1 ? cleanText($(tds[endCol]).text()) : '';
      const rawType = typeCol !== -1 ? cleanText($(tds[typeCol]).text()) : cleanText($(tds[2]).text());
      const amount = amountCol !== -1 ? cleanText($(tds[amountCol]).text()) : '';

      // В БАРС бывают строки с пустым «Видом», но с суммой и периодом —
      // например, социальная выплата без заполненного вида. Это всё равно
      // назначение, и терять его нельзя.
      if (!rawType && !amount && !startDate && !endDate) return;

      const lowerType = rawType.toLowerCase();
      if (
        lowerType.includes('не назначена') ||
        lowerType === 'нет' ||
        lowerType === '—' ||
        lowerType.startsWith('итого') ||
        lowerType.startsWith('всего')
      ) {
        return;
      }

      const type = rawType || 'Стипендия (вид не указан)';

      let period: string | undefined = undefined;
      if (startDate && endDate) {
        period = `${startDate} — ${endDate}`;
      } else if (startDate || endDate) {
        period = startDate || endDate;
      }

      const key = `${type}|${period ?? ''}|${amount}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({
        type,
        period,
        amount: amount || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        isActive: isScholarshipActive(startDate, endDate, now),
      });
    });
  }

  if (items.length > 0) {
    // Старые потребители (уведомления, скрипты) ждут одно «главное» назначение.
    // Берём первое действующее, а если таких нет — первую строку как историю.
    const active = items.filter((item) => item.isActive);
    const primary = active[0] ?? items[0];

    return {
      isAppointed: active.length > 0,
      type: primary?.type,
      period: primary?.period,
      amount: primary?.amount,
      items,
    };
  }

  // 2. Резервный поиск по текстовым карточкам или алертам
  let foundFromText: ScholarshipInfo | null = null;
  $('.card, .alert, .summary, [class*="stipend"]').each((_, el) => {
    if (foundFromText) return;
    const text = cleanText($(el).text());
    if (text.toLowerCase().includes('стипенди')) {
      const isNotAppointed = text.toLowerCase().includes('не назначена');
      if (isNotAppointed) {
        foundFromText = { isAppointed: false, items: [] };
      } else {
        const typeMatch = text.match(/(академическая|социальная|повышенная)[^\n,.]*/i);
        const type = typeMatch ? cleanText(typeMatch[0]) : undefined;
        const item: ScholarshipItem = { type: type ?? 'Стипендия', isActive: true };
        foundFromText = {
          isAppointed: true,
          type: item.type,
          items: [item],
        };
      }
    }
  });

  if (foundFromText) {
    return foundFromText;
  }

  return {
    isAppointed: false,
    items: [],
  };
}

/**
 * Парсит карточку читателя / взятые книги в библиотеке НТБ МЭИ.
 */
export function parseLibrary($: cheerio.CheerioAPI): LibraryBook[] {
  const books: LibraryBook[] = [];

  // Поиск таблицы книг (#tbl__PartialListStudent__BookCopy или таблица с наименованием и датой возврата)
  let table = $('#tbl__PartialListStudent__BookCopy');
  if (!table.length) {
    $('table').each((_, t) => {
      const text = $(t).text().toLowerCase();
      if ((text.includes('наименование') || text.includes('книга')) && (text.includes('возврат') || text.includes('автор'))) {
        table = $(t);
        return false;
      }
    });
  }

  if (!table.length) {
    return books;
  }

  let titleCol = 0;
  let authorCol = -1;
  let issueDateCol = -1;
  let dueDateCol = -1;

  table.find('thead tr th').each((idx, th) => {
    const text = cleanText($(th).text()).toLowerCase();
    if (text.includes('наименование') || text.includes('название') || text.includes('книга')) {
      titleCol = idx;
    } else if (text.includes('автор')) {
      authorCol = idx;
    } else if (text.includes('выдач')) {
      issueDateCol = idx;
    } else if (text.includes('возврат') || text.includes('срок сдачи') || text.includes('крайн')) {
      dueDateCol = idx;
    }
  });

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;

    const title = cleanText($(tds[titleCol] || tds[0]).text());
    if (!title) return;

    const author = authorCol !== -1 ? cleanText($(tds[authorCol]).text()) || undefined : undefined;
    const issueDate = issueDateCol !== -1 ? cleanText($(tds[issueDateCol]).text()) : '';
    const dueDate = dueDateCol !== -1 ? cleanText($(tds[dueDateCol]).text()) : '';

    const isOverdue = dueDate ? isDateOverdue(dueDate) : false;

    books.push({
      title,
      author,
      issueDate,
      dueDate,
      isOverdue,
    });
  });

  return books;
}
