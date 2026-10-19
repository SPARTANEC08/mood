/**
 * Отчёты статистики с диска — единственный источник для админского раздела
 * «📜 Отчёты». Никакой истории в базе: файлы уже формируются сервисом отчётов
 * в `db/data/reports/`.
 *
 * Поддерживаем два имени, потому что за время жизни проекта успели появиться оба:
 *   - `stats-YYYY.MM.DD.html` (текущее);
 *   - `YYYY-MM-DD.html` (формат из ранних версий/ручных выгрузок).
 *
 * Ключ отчёта — `YYYY-MM-DD` (безопасен для callback_data), подпись — `DD.MM.YYYY`.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ReportFile {
  /** Ключ для callback_data: YYYY-MM-DD. */
  key: string;
  /** Человеческая дата: DD.MM.YYYY. */
  label: string;
  filename: string;
  filePath: string;
  sortKey: string;
}

export const REPORTS_PER_PAGE = 10;

/** Каталог отчётов по умолчанию. Вынесен параметром — для тестов. */
export function defaultReportsDir(): string {
  return path.resolve(process.cwd(), 'db', 'data', 'reports');
}

/** YYYY.MM.DD или YYYY-MM-DD → YYYY-MM-DD (или null, если это не дата). */
function normalizeKey(raw: string): string | null {
  const match = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(raw);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function labelFor(key: string): string {
  const [year, month, day] = key.split('-');
  return `${day}.${month}.${year}`;
}

/** Список HTML-отчётов, новые сверху. Недоступный каталог = пустой список. */
export function listReports(dir: string = defaultReportsDir()): ReportFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const result: ReportFile[] = [];

  for (const filename of names) {
    if (!filename.toLowerCase().endsWith('.html')) continue;

    const base = filename.slice(0, -'.html'.length);
    const rawDate = base.startsWith('stats-') ? base.slice('stats-'.length) : base;
    const key = normalizeKey(rawDate);
    if (!key) continue;

    const filePath = path.join(dir, filename);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }

    result.push({ key, label: labelFor(key), filename, filePath, sortKey: key });
  }

  return result.sort((a, z) => z.sortKey.localeCompare(a.sortKey));
}

/** Одна страница отчётов (0 — самая новая). */
export function pageOfReports(
  reports: ReportFile[],
  page: number,
  perPage: number = REPORTS_PER_PAGE,
): { items: ReportFile[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(reports.length / perPage));
  const safePage = Math.min(Math.max(0, Number.isFinite(page) ? page : 0), pages - 1);
  const start = safePage * perPage;
  return { items: reports.slice(start, start + perPage), page: safePage, pages };
}

/** Поиск отчёта по ключу (для кнопки-даты). */
export function findReport(reports: ReportFile[], key: string): ReportFile | undefined {
  return reports.find((report) => report.key === key);
}
