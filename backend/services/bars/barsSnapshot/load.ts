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
import type { BarsSnapshotResponse, BarsMoreResponse, ApiMailMessage } from '../../../server/types.ts';
import type { AttendanceSummary } from '../parsers/attendanceParser.js';
import type { SemesterGrades, SubjectGrade } from '../parsers/gradesParser.js';
import type { BarsService } from '../barsService.ts';
import { emptyAcademic, summarizeAcademic } from './summarize.ts';

/**
 * Источник почты для снимка (структурный тип).
 *
 * Снимок БАРС почту больше не собирает (её ведёт нотификатор в
 * `mailPreviewCache`), поэтому жёсткая зависимость от конкретного клиента не
 * нужна: параметр оставлен структурным, чтобы не тянуть в снимок ни IMAP-, ни
 * OWA-клиент. Фактически всегда передаётся `null`.
 */
interface MailSource {
  getInboxStatus: () => Promise<{ total: number; unseen: number }>;
  fetchMessages: (options: { onlyUnread: boolean; limit: number }) => Promise<
    Array<{
      uid: number;
      from: string;
      subject: string;
      date: Date;
      isSeen: boolean;
      hasAttachments: boolean;
    }>
  >;
}

/** Сколько последних писем отдавать в превью. */
export const MAIL_PREVIEW_LIMIT = 8;

/** Один полный обход: БАРС обязательно, почта — по возможности. */
export async function loadSnapshot(
  barsService: BarsService,
  mailClient: MailSource | null,
): Promise<BarsSnapshotResponse> {
  const scraper = barsService.getScraper();

  // Страница успеваемости нужна дважды: целиком — для блока оценок, и для
  // сводки задолженностей/распределения в /api/bars/more. Запрос один и тот же,
  // поэтому он запускается ОДИН раз, а оба потребителя получают общий промис:
  // иначе на каждый снимок приходилось бы два похода в БАРС за одной страницей
  // и два её cheerio-разбора.
  const gradesPromise = scraper.getCurrentSemesterGrades();

  // Обязательные разделы идут в одном allSettled вместе с необязательными:
  // рейтинг и успеваемость для /api/bars/more необязательны, а без них
  // блок отдаётся пустым — потерянный рейтинг лучше пустой полоски.
  const [gradesRes, attendanceRes, moreRes, mailRes] = await Promise.allSettled([
    gradesPromise,
    scraper.getAttendance(),
    collectMore(scraper, gradesPromise),
    // Почта в снимок не собирается: её обновляет только фоновый нотификатор
    // (preview для интерфейса — mailPreviewCache). mailClient здесь всегда null,
    // а отсутствие почты в снимке — не ошибка.
    mailClient
      ? collectMail(mailClient)
      : Promise.resolve({ value: null, error: null }),
  ]);

  if (gradesRes.status === 'rejected') throw gradesRes.reason;
  if (attendanceRes.status === 'rejected') throw attendanceRes.reason;
  if (moreRes.status === 'rejected') throw moreRes.reason;

  const mail = mailRes.status === 'fulfilled' ? mailRes.value.value : null;
  const mailError = mailRes.status === 'fulfilled' ? mailRes.value.error : messageOf(mailRes.reason);

  return {
    grades: buildGrades(gradesRes.value),
    attendance: buildAttendance(attendanceRes.value),
    more: moreRes.value,
    mail,
    mailError,
    fetchedAt: new Date().toISOString(),
  };
}

/** Приказы, стипендия, библиотека, рейтинг и задолженности — с изоляцией ошибок. */
async function collectMore(
  scraper: {
    getOrders: () => Promise<Array<{ number: string; date: string; title: string; status?: string }>>;
    getScholarship: () => Promise<{ isAppointed: boolean; type?: string; period?: string; amount?: string }>;
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
  const [orders, scholarship, books, rating, academic] = await Promise.allSettled([
    scraper.getOrders(),
    scraper.getScholarship(),
    scraper.getLibraryBooks(),
    scraper.getRating(),
    gradesPromise,
  ]);

  if (orders.status === 'rejected') throw orders.reason;
  if (scholarship.status === 'rejected') throw scholarship.reason;
  if (books.status === 'rejected') throw books.reason;

  // Рейтинг и успеваемость необязательны: один недоступный раздел не должен
  // убирать приказы, стипендию и библиотеку.
  return buildMore({
    orders: orders.value,
    scholarship: scholarship.value,
    books: books.value,
    rating: rating.status === 'fulfilled' ? rating.value : emptyRating(),
    academic: academic.status === 'fulfilled' ? summarizeAcademic(academic.value.subjects) : emptyAcademic(),
  });
}

/** Превью писем без вложений и тел — только то, что видно в списке. */
async function collectMail(mail: MailSource): Promise<{
  value: BarsSnapshotResponse['mail'];
  error: string | null;
}> {
  try {
    const [status, messages] = await Promise.all([
      mail.getInboxStatus(),
      mail.fetchMessages({ onlyUnread: true, limit: MAIL_PREVIEW_LIMIT }),
    ]);

    return {
      value: {
        total: status.total,
        unseen: status.unseen,
        messages: messages.map<ApiMailMessage>((m) => ({
          uid: m.uid,
          from: m.from,
          subject: m.subject,
          date: m.date instanceof Date ? m.date.toISOString() : new Date().toISOString(),
          isSeen: m.isSeen,
          hasAttachments: m.hasAttachments,
        })),
      },
      error: null,
    };
  } catch (err: unknown) {
    // Почта — единственный раздел, который может упасть, не уронив снимок:
    // человек всё равно увидит оценки и приказы.
    return { value: null, error: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        week: p.week,
        date: p.date,
      })),
    };
  });

  // Общий средневзвешенный: среднее по дисциплинам, где есть хоть одна оценка.
  const scored = subjects
    .map((s) => s.currentAverage)
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
  scholarship: { isAppointed: boolean; type?: string; period?: string; amount?: string };
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
