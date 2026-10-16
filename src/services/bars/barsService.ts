import { BarsClient } from './barsClient.js';
import { BarsScraper } from './barsScraper.js';
import type { SemesterGrades } from './parsers/gradesParser.js';
import type { AttendanceSummary } from './parsers/attendanceParser.js';
import type { OrderItem, ScholarshipInfo, LibraryBook } from './parsers/studentInfoParser.js';
import { safeErrorMessage } from '../../bot/format.ts';

export interface StudentProfileData {
  fio: string;
  group: string;
  studyCard?: string;
  email?: string;
}

export interface FullStudentProfile {
  student: StudentProfileData;
  grades: SemesterGrades;
  attendance: AttendanceSummary;
  scholarship: ScholarshipInfo;
  orders: OrderItem[];
  libraryBooks: LibraryBook[];
  warnings: string[];
}

/**
 * Единый фасад для взаимодействия с личным кабинетом БАРС МЭИ.
 * Объединяет скрапинг оценок, посещаемости, приказов, стипендии и библиотеки.
 */
export class BarsService {
  private client: BarsClient;
  private scraper: BarsScraper;

  constructor(client?: BarsClient) {
    this.client = client ?? new BarsClient();
    this.scraper = new BarsScraper(this.client);
  }

  /**
   * Возвращает экземпляр внутреннего HTTP-клиента BarsClient.
   */
  public getClient(): BarsClient {
    return this.client;
  }

  /**
   * Возвращает экземпляр внутреннего скрапера BarsScraper.
   */
  public getScraper(): BarsScraper {
    return this.scraper;
  }

  /**
   * Инициализирует и возвращает сессию (при необходимости подгружая из файла).
   */
  public async initSession(sessionFilePath?: string): Promise<void> {
    if (!this.client.getSavedSession()) {
      await this.client.loadSavedSession(sessionFilePath);
    }
  }

  /**
   * Проверяет, является ли текущая сохраненная сессия активной и не истекшей.
   */
  public async isSessionValid(): Promise<boolean> {
    return this.client.isSessionValid();
  }

  /**
   * Выполняет полный вход в БАРС МЭИ через логин, пароль и 2FA-код.
   */
  public async login(
    options: import('./barsAuth.js').LoginOptions,
  ): Promise<import('./barsAuth.js').LoginResult> {
    return this.client.login(options);
  }

  /**
   * Собирает полную карточку студента в один вызов.
   * Выполняет параллельный сбор разделов с изоляцией ошибок: если один из разделов
   * временно недоступен (500, таймаут и т.п.), остальные данные успешно возвращаются.
   */
  public async getFullStudentProfile(): Promise<FullStudentProfile> {
    await this.initSession();

    const session = this.client.getSavedSession();
    const student: StudentProfileData = {
      fio: session?.fio || 'Неизвестно',
      group: session?.group || 'Неизвестно',
      studyCard: session?.studyCard,
    };

    // Параллельный запуск выгрузки всех разделов
    const [gradesRes, attendanceRes, ordersRes, scholarshipRes, libraryRes] =
      await Promise.allSettled([
        this.scraper.getCurrentSemesterGrades(),
        this.scraper.getAttendance(),
        this.scraper.getOrders(),
        this.scraper.getScholarship(),
        this.scraper.getLibraryBooks(),
      ]);

    const warnings: string[] = [];

    // 1. Оценки текущего семестра
    let grades: SemesterGrades;
    if (gradesRes.status === 'fulfilled') {
      grades = gradesRes.value;
    } else {
      const err = safeErrorMessage(gradesRes.reason);
      warnings.push(`Не удалось загрузить успеваемость: ${err}`);
      console.warn(`[BarsService] Ошибка выгрузки оценок: ${err}`);
      grades = {
        semesterName: 'Не удалось определить',
        isCurrent: true,
        subjects: [],
      };
    }

    // 2. Посещаемость
    let attendance: AttendanceSummary;
    if (attendanceRes.status === 'fulfilled') {
      attendance = attendanceRes.value;
    } else {
      const err = safeErrorMessage(attendanceRes.reason);
      warnings.push(`Не удалось загрузить посещаемость: ${err}`);
      console.warn(`[BarsService] Ошибка выгрузки посещаемости: ${err}`);
      attendance = {
        totalMissedLessons: 0,
        totalExcusedLessons: 0,
        totalUnexcusedLessons: 0,
        totalMissed: 0,
        totalExcused: 0,
        totalUnexcused: 0,
        bySubject: [],
      };
    }

    // 3. Приказы
    let orders: OrderItem[];
    if (ordersRes.status === 'fulfilled') {
      orders = ordersRes.value;
    } else {
      const err = safeErrorMessage(ordersRes.reason);
      warnings.push(`Не удалось загрузить приказы: ${err}`);
      console.warn(`[BarsService] Ошибка выгрузки приказов: ${err}`);
      orders = [];
    }

    // 4. Стипендия
    let scholarship: ScholarshipInfo;
    if (scholarshipRes.status === 'fulfilled') {
      scholarship = scholarshipRes.value;
    } else {
      const err = safeErrorMessage(scholarshipRes.reason);
      warnings.push(`Не удалось загрузить данные о стипендии: ${err}`);
      console.warn(`[BarsService] Ошибка выгрузки стипендии: ${err}`);
      scholarship = {
        isAppointed: false,
      };
    }

    // 5. Библиотека
    let libraryBooks: LibraryBook[];
    if (libraryRes.status === 'fulfilled') {
      libraryBooks = libraryRes.value;
    } else {
      const err = safeErrorMessage(libraryRes.reason);
      warnings.push(`Не удалось загрузить библиотечные книги: ${err}`);
      console.warn(`[BarsService] Ошибка выгрузки библиотеки: ${err}`);
      libraryBooks = [];
    }

    return {
      student,
      grades,
      attendance,
      scholarship,
      orders,
      libraryBooks,
      warnings,
    };
  }
}
