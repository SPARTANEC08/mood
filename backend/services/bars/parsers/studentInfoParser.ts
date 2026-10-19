import * as cheerio from 'cheerio';

import { cleanText } from './shared.ts';

export interface OrderItem {
  number: string;
  date: string;
  title: string;       // Например: "О зачислении", "О назначении государственной академической стипендии"
  status?: string;
}

export interface ScholarshipInfo {
  isAppointed: boolean; // Назначена ли стипендия
  type?: string;        // Академическая, социальная, повышенная
  period?: string;      // Срок действия назначения
  amount?: string;      // Сумма (если отображается)
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
function parseDate(dateStr: string): Date | null {
  const match = dateStr.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  return new Date(year, month, day, 23, 59, 59, 999);
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
export function parseScholarship($: cheerio.CheerioAPI): ScholarshipInfo {
  // 1. Поиск таблицы со стипендиями
  let table = $('table').filter((_, t) => {
    const text = $(t).text().toLowerCase();
    return text.includes('стипенди') || (text.includes('дата начала') && text.includes('вид'));
  }).first();

  if (!table.length) {
    table = $('table').first();
  }

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

    const rows = table.find('tbody tr');
    if (rows.length > 0) {
      // Ищем действующую стипендию (где текущая дата между началом и концом) или берем последнюю/первую
      for (let i = 0; i < rows.length; i++) {
        const tr = rows.eq(i);
        const tds = tr.find('td');
        if (tds.length < 3) continue;

        const startDate = startCol !== -1 ? cleanText($(tds[startCol]).text()) : '';
        const endDate = endCol !== -1 ? cleanText($(tds[endCol]).text()) : '';
        const rawType = typeCol !== -1 ? cleanText($(tds[typeCol]).text()) : cleanText($(tds[2]).text());
        const amount = amountCol !== -1 ? cleanText($(tds[amountCol]).text()) : undefined;

        let period: string | undefined = undefined;
        if (startDate && endDate) {
          period = `${startDate} — ${endDate}`;
        } else if (startDate || endDate) {
          period = startDate || endDate;
        }

        if (rawType) {
          return {
            isAppointed: true,
            type: rawType,
            period,
            amount: amount || undefined,
          };
        }
      }
    }
  }

  // 2. Резервный поиск по текстовым карточкам или алертам
  let foundFromText: ScholarshipInfo | null = null;
  $('.card, .alert, .summary, [class*="stipend"]').each((_, el) => {
    if (foundFromText) return;
    const text = cleanText($(el).text());
    if (text.toLowerCase().includes('стипенди')) {
      const isNotAppointed = text.toLowerCase().includes('не назначена');
      if (isNotAppointed) {
        foundFromText = { isAppointed: false };
      } else {
        const typeMatch = text.match(/(академическая|социальная|повышенная)[^\n,.]*/i);
        foundFromText = {
          isAppointed: true,
          type: typeMatch ? cleanText(typeMatch[0]) : undefined,
        };
      }
    }
  });

  if (foundFromText) {
    return foundFromText;
  }

  return {
    isAppointed: false,
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
