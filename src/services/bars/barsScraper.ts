import { BarsClient } from './barsClient.js';
import { parseGradesPage, type SemesterGrades } from './parsers/gradesParser.js';
import { parseAttendancePage, type AttendanceSummary } from './parsers/attendanceParser.js';
import {
  parseOrders,
  parseScholarship,
  parseLibrary,
  type OrderItem,
  type ScholarshipInfo,
  type LibraryBook,
} from './parsers/studentInfoParser.js';

/**
 * Высокоуровневый сервис скрапинга и обработки данных из личного кабинета БАРС МЭИ.
 */
export class BarsScraper {
  private client: BarsClient;

  constructor(client?: BarsClient) {
    this.client = client ?? new BarsClient();
  }

  /**
   * Возвращает авторизованный BarsClient, при необходимости подгружая сохраненную сессию.
   */
  public async getClient(): Promise<BarsClient> {
    if (!this.client.getSavedSession()) {
      await this.client.loadSavedSession();
    }
    return this.client;
  }

  /**
   * Извлекает ID студента из сохраненной сессии (из финального URL дашборда).
   */
  private getStudentId(): string {
    const session = this.client.getSavedSession();
    const match = session?.finalUrl?.match(/studentID=([a-f0-9-]+)/i);
    return match ? match[1] : '';
  }

  /**
   * Загружает страницу оценок через BarsClient и парсит оценки текущего семестра.
   */
  public async getCurrentSemesterGrades(): Promise<SemesterGrades> {
    const client = await this.getClient();
    const session = client.getSavedSession();
    const targetUrl = session?.finalUrl || '/bars_web/ST_Study/Main/Main';
    const $ = await client.getHtml(targetUrl);
    return parseGradesPage($);
  }

  /**
   * Загружает страницу сводки/посещаемости через BarsClient и парсит пропуски занятий.
   */
  public async getAttendance(): Promise<AttendanceSummary> {
    const client = await this.getClient();
    const studentId = this.getStudentId();
    const targetUrl = studentId
      ? `/bars_web/ST_Study/Main/Summary?studentID=${studentId}`
      : '/bars_web/ST_Study/Main/Summary';
    const $ = await client.getHtml(targetUrl);
    return parseAttendancePage($);
  }

  /**
   * Загружает страницу приказов по студенту и парсит список приказов.
   */
  public async getOrders(): Promise<OrderItem[]> {
    const client = await this.getClient();
    const studentId = this.getStudentId();
    const targetUrl = studentId
      ? `/bars_web/ST_LK/Order/ListStudent__Order?studentID=${studentId}`
      : '/bars_web/ST_LK/Order/ListStudent__Order';
    const $ = await client.getHtml(targetUrl);
    return parseOrders($);
  }

  /**
   * Загружает страницу стипендий и парсит информацию о назначенной стипендии.
   */
  public async getScholarship(): Promise<ScholarshipInfo> {
    const client = await this.getClient();
    const studentId = this.getStudentId();
    const targetUrl = studentId
      ? `/bars_web/ST_LK/ScholarshipEvent/ListStudent__ScholarshipEvent?studentID=${studentId}`
      : '/bars_web/ST_LK/ScholarshipEvent/ListStudent__ScholarshipEvent';
    const $ = await client.getHtml(targetUrl);
    return parseScholarship($);
  }

  /**
   * Загружает страницу книг и парсит список взятой литературы в НТБ МЭИ.
   */
  public async getLibraryBooks(): Promise<LibraryBook[]> {
    const client = await this.getClient();
    const studentId = this.getStudentId();
    const targetUrl = studentId
      ? `/bars_web/ST_LIB/BookCopy/ListStudent__BookCopy?studentID=${studentId}`
      : '/bars_web/ST_LIB/BookCopy/ListStudent__BookCopy';
    const $ = await client.getHtml(targetUrl);
    return parseLibrary($);
  }
}


