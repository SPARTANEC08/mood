/**
 * Сборка одного полного снимка БАРС+почты: один обход МЭИ на пользователя.
 *
 * Обязательные разделы (оценки, пропуски) идут параллельно с необязательными
 * (рейтинг, приказы, стипендия, книги, почта) и с изоляцией ошибок: упавшая
 * почта не роняет снимок, а обязательный раздел — пробрасывается вызывающему.
 *
 * Страница успеваемости нужна дважды: целиком для блока оценок и для сводки в
 * /api/bars/more. Запрос запускается ОДИН раз, оба потребителя получают общий
 * промис — иначе на каждый снимок приходилось бы два похода в БАРС.
 */

import { buildSubjectReport } from '../../../gradeCalculator.ts';
import type { BarsSnapshotResponse, BarsMoreResponse } from '../../../server/types.ts';
import type { AttendanceSummary } from '../parsers/attendanceParser.js';
import type { SemesterGrades, SubjectGrade } from '../parsers/gradesParser.js';
import type { BarsService } from '../barsService.ts';
import { emptyAcademic, summarizeAcademic } from './summarize.ts';

/**
 * Один полный обход БАРС.
 *
 * Почта в снимок больше не входит: она не читается, а её счётчики ведёт
 * нотификатор (`mailStatusCache`). Параметр оставлен ради совместимости
 * сигнатуры и намеренно не используется.
 */
export interface SnapshotLoadOptions {
  /**
   * Предыдущий снимок. Его «медленные» разделы (приказы, стипендия, книги,
   * рейтинг) переиспользуются, если им меньше MORE_REUSE_MS.
   *
   * Почему. БАРС периодически залипает на одной странице: замер показал
   * 31 секунду на списке приказов при норме 0.2–1.2 с. Из-за этого весь
   * pull-to-refresh на «Успеваемости» и в «Кабинете» ждал полминуты, хотя
   * оценки и пропуски уже пришли. Эти разделы меняются раз в семестр, так что
   * обновлять их на каждый жест бессмысленно.
   */
  previous?: BarsSnapshotResponse;
  /** Когда предыдущий снимок был собран. */
  previousAt?: number;
}

/** Как долго переиспользуем приказы/стипендию/книги/рейтинг. */
const MORE_REUSE_MS = 6 * 60 * 60 * 1000;

export async function loadSnapshot(
  barsService: BarsService,
  _mailClient: unknown = null,
  options: SnapshotLoadOptions = {},
): Promise<BarsSnapshotResponse> {
  const scraper = barsService.getScraper();

  // Страница успеваемости нужна дважды: целиком — для блока оценок, и для
  // сводки задолженностей/распределения в /api/bars/more. Запрос один и тот же,
  // поэтому он запускается ОДИН раз, а оба потребителя получают общий промис:
  // иначе на каждый снимок приходилось бы два похода в БАРС за одной страницей
  // и два её cheerio-разбора.
  const gradesPromise = scraper.getCurrentSemesterGrades();

  const canReuseMore = Boolean(
    options.previous?.more &&
      options.previousAt &&
      Date.now() - options.previousAt < MORE_REUSE_MS,
  );

  /*
   * «Кабинет» не должен страдать из-за одного зависшего раздела.
   *
   * grades и attendance обязательны: без них экран бесполезен. Приказы,
   * стипендия, книги и рейтинг — нет: если БАРС не отдал их за отведённое
   * время, отдаём прошлые значения или пустые списки, но не роняем весь снимок.
   */
  const morePromise = canReuseMore
    ? Promise.resolve(options.previous!.more)
    : collectMore(scraper, gradesPromise).catch((err: unknown) => {
        console.warn(
          '[BARS] разделы кабинета не обновились, отдаю прошлые/пустые:',
          err instanceof Error ? err.message : err,
        );
        return options.previous?.more ?? emptyMore();
      });

  const [gradesRes, attendanceRes, moreRes] = await Promise.allSettled([
    gradesPromise,
    scraper.getAttendance(),
    morePromise,
  ]);

  if (gradesRes.status === 'rejected') throw gradesRes.reason;
  if (attendanceRes.status === 'rejected') throw attendanceRes.reason;
  if (moreRes.status === 'rejected') throw moreRes.reason;

  return {
    grades: buildGrades(gradesRes.value),
    attendance: buildAttendance(attendanceRes.value),
    more: moreRes.value,
    // Почта в снимке БАРС не участвует: её статус живёт в mailStatusCache.
    mail: null,
    mailError: null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Приказы, стипендия, библиотека, рейтинг и задолженности — с изоляцией ошибок. */
async function collectMore(
  scraper: {
    getOrders: () => Promise<Array<{ number: string; date: string; title: string; status?: string }>>;
    getScholarship: () => Promise<{
      isAppointed: boolean;
      type?: string;
      period?: string;
      amount?: string;
      items?: Array<{
        type: string;
        period?: string;
        amount?: string;
        startDate?: string;
        endDate?: string;
        isActive: boolean;
      }>;
    }>;
    getLibraryBooks: () => Promise<
      Array<{ title: string; author?: string; issueDate: string; dueDate: string; isOverdue: boolean }>
    >;
    getRating: () => Promise<{
      period: string | null;
      academicScore: number | null;
      studyScore: number | null;
      parts: Array<{ key: string; title: string; total: number | null; semester: number | null }>;
      comprehensive: { key: string; title: string; total: number | null; semester: number | null } | null;
      overall: number | null;
    }>;
  },
  // Общий промис страницы успеваемости с loadSnapshot: одна загрузка на снимок.
  gradesPromise: Promise<SemesterGrades>,
): Promise<BarsMoreResponse> {
  /*
   * Разделы «Кабинета» не обязательны: если БАРС залип на одном из них,
   * отдаём остальные, а не роняем весь экран. 10 секунд — уже аномалия:
   * в замерах те же страницы отвечают 0.2–1.2 с.
   */
  const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: таймаут 10 с`)), 10_000);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

  const [orders, scholarship, books, rating, academic] = await Promise.allSettled([
    withTimeout(scraper.getOrders(), 'приказы'),
    withTimeout(scraper.getScholarship(), 'стипендия'),
    withTimeout(scraper.getLibraryBooks(), 'библиотека'),
    withTimeout(scraper.getRating(), 'рейтинг'),
    gradesPromise,
  ]);

  return buildMore({
    orders: orders.status === 'fulfilled' ? orders.value : [],
    scholarship: scholarship.status === 'fulfilled' ? scholarship.value : { isAppointed: false },
    books: books.status === 'fulfilled' ? books.value : [],
    // Рейтинг и успеваемость необязательны: один недоступный раздел не должен
    // убирать приказы, стипендию и библиотеку.
    rating: rating.status === 'fulfilled' ? rating.value : emptyRating(),
    academic:
      academic.status === 'fulfilled'
        ? summarizeAcademic(academic.value.subjects)
        : emptyAcademic(),
  });
}

/** Оценки в форму API: тот же расчёт, что и в боте. */
function buildGrades(semester: SemesterGrades): BarsSnapshotResponse['grades'] {
  const subjects = semester.subjects.map((subject: SubjectGrade) => {
    const report = buildSubjectReport(subject);

    return {
      discipline: report.discipline,
      controlType: report.controlType,
      attestation: report.attestationRaw,
      currentAverage: report.currentAverage,
      barsAverage: report.barsAverage,
      gradedWeight: report.gradedWeight,
      totalWeight: report.totalWeight,
      totalCount: report.totalCount,
      gradedCount: report.gradedCount,
      pendingCount: report.pendingCount,
      finalGrade: report.finalGrade,
      controlPoints: report.controlPoints.map((p) => ({
        number: p.number,
        title: p.title,
        weight: p.weight,
        score: p.score,
        attempts: p.attempts,
        week: p.week,
        date: p.date,
      })),
    };
  });

  // Общий средневзвешенный: среднее по дисциплинам, где есть хоть одна оценка.
  // Если БАРС уже посчитал балл по дисциплине — берём его: там учтены пересдачи,
  // которые приложение по видимым КМ восстановить не может.
  const scored = subjects
    .map((s) => s.barsAverage ?? s.currentAverage)
    .filter((v): v is number => typeof v === 'number');

  return {
    semesterName: semester.semesterName,
    subjects,
    overallAverage:
      scored.length === 0
        ? null
        : Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100,
  };
}

/** Пропуски в форму API. */
function buildAttendance(summary: AttendanceSummary): BarsSnapshotResponse['attendance'] {
  return {
    totalMissedLessons: summary.totalMissedLessons,
    totalExcusedLessons: summary.totalExcusedLessons,
    totalUnexcusedLessons: summary.totalUnexcusedLessons,
    totalMissedHours: summary.totalMissed,
    totalExcusedHours: summary.totalExcused,
    totalUnexcusedHours: summary.totalUnexcused,
    bySubject: summary.bySubject.map((s) => ({
      discipline: s.discipline,
      missedLessons: s.missedLessons,
      excusedLessons: s.excusedLessons,
      unexcusedLessons: s.unexcusedLessons,
      totalMissedHours: s.totalMissedHours,
      excusedHours: s.excusedHours,
      unexcusedHours: s.unexcusedHours,
    })),
  };
}

function buildMore(input: {
  orders: Array<{ number: string; date: string; title: string; status?: string }>;
  scholarship: {
    isAppointed: boolean;
    type?: string;
    period?: string;
    amount?: string;
    items?: Array<{
      type: string;
      period?: string;
      amount?: string;
      startDate?: string;
      endDate?: string;
      isActive: boolean;
    }>;
  };
  books: Array<{
    title: string;
    author?: string;
    issueDate: string;
    dueDate: string;
    isOverdue: boolean;
  }>;
  rating: BarsMoreResponse['rating'];
  academic: BarsMoreResponse['academic'];
}): BarsMoreResponse {
  return {
    orders: input.orders,
    scholarship: input.scholarship,
    libraryBooks: input.books,
    rating: input.rating,
    academic: input.academic,
  };
}

function emptyRating(): BarsMoreResponse['rating'] {
  return {
    period: null,
    academicScore: null,
    studyScore: null,
    parts: [],
    comprehensive: null,
    overall: null,
  };
}

/** Пустой «Кабинет»: используется, когда разделы не пришли, а прошлого снимка нет. */
function emptyMore(): BarsMoreResponse {
  return buildMore({
    orders: [],
    scholarship: { isAppointed: false },
    books: [],
    rating: emptyRating(),
    academic: emptyAcademic(),
  });
}
