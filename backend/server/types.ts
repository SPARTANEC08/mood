/**
 * Контракты API PWA.
 *
 * Файл — единственный источник правды для клиента и сервера: фронтенд
 * импортирует те же типы, поэтому рассинхрон полей исключён на уровне
 * компиляции.
 *
 * Файлы здесь — это ServerFileRef (ссылки на серверное хранилище), а не
 * telegram file_id: файлы лежат на диске, и клиент получает их по HTTP.
 */

import type { LessonKindType, ServerFileRef } from '../../db/storage/homeworkStore.ts';

/** Профиль студента для шапки приложения. */
export interface BootstrapProfile {
  /** Идентификатор пользователя в системе Mood. */
  userId: string;
  /** Есть ли у пользователя Telegram. У PWA-пользователей — нет. */
  /**
   * Telegram-аккаунт, подключённый к уведомлениям.
   *
   * Отсутствует, если человек не нажимал «Подключить уведомления» в Telegram.
   */
  telegramId?: number;
  /**
   * Присылать ли уведомления в Telegram.
   *
   * Сервер отдаёт true по умолчанию: отсутствие поля означает «никто не
   * выключал», и на клиенте по умолчанию было бы неправильно показывать
   * выключенное состояние человеку, который ничего не выключал.
   */
  notificationsEnabled?: boolean;
  /** Присылать ли Web Push в приложение (независимо от Telegram). */
  pushEnabled?: boolean;
  /** Сколько устройств подписано на push. */
  pushDevices?: number;
  fullName: string;
  groupName: string;
  faculty?: string;
  recordBookNumber?: string;
  groupId?: number;
  /** Гостевой профиль: только расписание, без БАРС и личных разделов. */
  isGuest?: boolean;
}

/** Ответ GET /api/bootstrap. */
export interface BootstrapResponse {
  profile: BootstrapProfile;
  /** Авторизован ли студент в БАРС. false = приложение покажет экран входа. */
  barsAuthorized: boolean;
  /** Актуальна ли сохранённая сессия БАРС (может быть устаревшей). */
  sessionValid: boolean | null;
  /** Дата сегодня в формате YYYY.MM.DD (Москва). */
  today: string;
  /** Номер учебной недели на сегодня. */
  weekNumber: number;
  /** Диапазон дат расписания, доступный в кэше. */
  scheduleRange: { start: string; finish: string } | null;
  /** Непрочитанные письма ОСЭП, если удалось посчитать. */
  mailUnread: number | null;
}

/** Тип занятия в API. */
export type ApiLessonKind = LessonKindType;

/** Один вариант занятия (дисциплина + аудитория + преподаватель). */
export interface ApiLessonVariant {
  discipline: string;
  kindOfWork: string;
  /** Тип занятия, приведённый к трём значениям. */
  kind: ApiLessonKind;
  auditorium: string;
  building: string;
  lecturerShort: string;
  lecturerFullName: string;
  lecturerRank?: string;
  subgroup?: string;
  note?: string;
  onlineUrls: Array<{ url: string; description?: string }>;
}

/** Привязанное к паре домашнее задание. */
export interface ApiLessonHomework {
  id: string;
  text: string;
  authorName?: string;
  createdAt: string;
  fileCount: number;
}

/** Пара расписания для фронтенда. */
export interface ApiLessonSlot {
  lessonNumber: number;
  timeStart: string;
  timeEnd: string;
  variants: ApiLessonVariant[];
  /** ДЗ, привязанное к этой паре (первое — для бейджа). */
  homework: ApiLessonHomework[];
}

/** День расписания. */
export interface ApiScheduleDay {
  /** YYYY.MM.DD */
  rawDate: string;
  /** 1 = Пн … 7 = Вс */
  dayOfWeek: number;
  dayShort: string;
  dayName: string;
  slots: ApiLessonSlot[];
}

/** Ответ GET /api/schedule. */
export interface ScheduleResponse {
  groupName: string;
  facultyName: string;
  days: ApiScheduleDay[];
}

/** Контрольное мероприятие (КМ) в API. */
export interface ApiControlPoint {
  number: number;
  title?: string;
  weight?: number;
  score: number | null;
  /** Все попытки, если БАРС показал пересдачу в одной ячейке. */
  attempts?: number[];
  week?: string;
  date?: string;
}

/** Дисциплина с разбивкой по КМ. */
export interface ApiSubjectGrade {
  discipline: string;
  controlType: string;
  /** Форма аттестации из ЛК: «экзамен», «зачёт с оценкой», «зачёт (без оценки)». */
  attestation?: string;
  currentAverage: number | null;
  barsAverage: number | null;
  gradedWeight: number;
  totalWeight: number;
  totalCount: number;
  gradedCount: number;
  pendingCount: number;
  finalGrade?: string;
  controlPoints: ApiControlPoint[];
}

/** Ответ GET /api/bars/grades. */
export interface GradesResponse {
  semesterName: string;
  subjects: ApiSubjectGrade[];
  /** Средневзвешенный балл по всем дисциплинам. */
  overallAverage: number | null;
}

/** Пропуски по дисциплине. */
export interface ApiSubjectAttendance {
  discipline: string;
  missedLessons: number;
  excusedLessons: number;
  unexcusedLessons: number;
  totalMissedHours: number;
  excusedHours: number;
  unexcusedHours: number;
}

/** Ответ GET /api/bars/attendance. */
export interface AttendanceResponse {
  totalMissedLessons: number;
  totalExcusedLessons: number;
  totalUnexcusedLessons: number;
  totalMissedHours: number;
  totalExcusedHours: number;
  totalUnexcusedHours: number;
  bySubject: ApiSubjectAttendance[];
}

/** Раздел внутривузовского рейтинга. */
export interface ApiRatingPart {
  key: string;
  title: string;
  /** Балл за всё время. */
  total: number | null;
  /** Балл за текущий семестр. */
  semester: number | null;
}

/** Распределение выставленных оценок по КМ. */
export interface GradeDistribution {
  fives: number;
  fours: number;
  threes: number;
  twos: number;
  /** Всего выставленных оценок. */
  total: number;
}

/** Ответ GET /api/bars/more. */
export interface BarsMoreResponse {
  orders: Array<{ number: string; date: string; title: string; status?: string }>;
  scholarship: {
    isAppointed: boolean;
    type?: string;
    period?: string;
    amount?: string;
    /** Все назначения из БАРС: академическая, социальная, повышенная и т.д. */
    items?: Array<{
      type: string;
      period?: string;
      amount?: string;
      startDate?: string;
      endDate?: string;
      isActive: boolean;
    }>;
  };
  libraryBooks: Array<{
    title: string;
    author?: string;
    issueDate: string;
    dueDate: string;
    isOverdue: boolean;
  }>;
  /** Внутривузовский рейтинг. */
  rating: {
    period: string | null;
    /** Балл за учебную деятельность за семестр. */
    academicScore: number | null;
    /** Балл «Учеба, прочее». */
    studyScore: number | null;
    parts: ApiRatingPart[];
    comprehensive: ApiRatingPart | null;
    /** Общий балл за семестр. */
    overall: number | null;
  };
  /**
   * Задолженности и распределение оценок.
   *
   * Задолженность — это неоценённое или отрицательно оценённое КМ, проще
   * говоря «двойка». Именно эту цифру показывает ЛК в блоке задолженностей.
   */
  academic: {
    /** Сколько двоек за КМ (или незакрытых КМ со знаком «не зачтено»). */
    debts: number;
    /** Сколько КМ закрыто из всех. */
    closed: number;
    /** Всего КМ в семестре. */
    total: number;
    /** Распределение выставленных оценок — для полоски в приложении. */
    distribution: GradeDistribution;
  };
}

/** Ответ GET /api/mail. */
export interface MailResponse {
  /** Всего писем в ящике (для диагностики). */
  total: number | null;
  /** Непрочитанных сейчас — это число показывает строка «Почта». */
  unseen: number | null;
}

/**
 * Снимок данных БАРС и почты — ответ POST /api/bars/refresh.
 *
 * Отдаётся целиком, а не одним разделом: снимок всё равно собирается за один
 * поход в МЭИ, поэтому клиенту незачем запрашивать его по кускам и получать
 * четыре последовательных обхода вместо одного.
 *
 * Почта здесь — единственный необязательный блок: она лежит на другом сервере
 * (IMAP) и может не ответить, не сделав при этом ни оценки, ни приказы
 * недоступными.
 */
export interface BarsSnapshotResponse {
  grades: GradesResponse;
  attendance: AttendanceResponse;
  more: BarsMoreResponse;
  /** null, если в этом круге почта не ответила. */
  mail: MailResponse | null;
  /** Причина, по которой mail === null. */
  mailError: string | null;
  /** Момент, когда снимок ушёл в МЭИ (ISO). */
  fetchedAt: string;
}

/** Домашнее задание в API. */
export interface ApiHomework {
  id: string;
  groupName: string;
  discipline: string;
  kind: LessonKindType;
  /** YYYY.MM.DD */
  targetDate: string;
  lessonNumber?: number;
  timeStart?: string;
  text: string;
  authorName?: string;
  createdAt: string;
  files: ServerFileRef[];
  /** Текущий пользователь — автор записи: только он может править и удалять. */
  canEdit: boolean;
  /** Личная отметка «Сделано» (у разных студентов группы разная). */
  done: boolean;
}

/** Ответ GET /api/homework. */
export interface HomeworkResponse {
  items: ApiHomework[];
}

/**
 * Тело POST /api/homework.
 *
 * fileIds — результаты предварительной загрузки через POST /api/files/upload.
 * Файлы загружаются раньше записи и прикрепляются по идентификатору: загрузка
 * одного файла не должна падать вместе с проверкой текста, а порядок «сначала
 * файл, потом запись» позволяет откатить уже загруженное, если запись не
 * создалась.
 *
 * Текст может быть пустым, если есть файлы: «решение на фото» — нормальная
 * формулировка задания, и заставлять писать текст только ради текста бессмысленно.
 */
export interface CreateHomeworkBody {
  discipline: string;
  kind: LessonKindType;
  text: string;
  fileIds?: string[];
}

/** Тело PATCH /api/homework/:id. */
export interface UpdateHomeworkBody {
  text?: string;
  /** Полный новый список файлов: отсутствующие удаляются у человека. */
  fileIds?: string[];
}

/** Объявление в API. */
export interface ApiImportant {
  id: string;
  groupName: string;
  title: string;
  text: string;
  authorName?: string;
  createdAt: string;
  files: ServerFileRef[];
  /** Текущий пользователь — автор записи: только он может править и удалять. */
  canEdit: boolean;
}

/** Ответ GET /api/important. */
export interface ImportantResponse {
  items: ApiImportant[];
}

/** Тело POST /api/important. */
export interface CreateImportantBody {
  title: string;
  text: string;
  fileIds?: string[];
}

/** Тело PATCH /api/important/:id. */
export interface UpdateImportantBody {
  title?: string;
  text?: string;
  /** Полный новый список файлов: отсутствующие удаляются у человека. */
  fileIds?: string[];
}

/** Ошибка API в едином формате. */
export interface ApiError {
  error: string;
  message: string;
  /** true = клиенту нужно предложить вход в БАРС через бота. */
  needBarsLogin: boolean;
}

/**
 * Ответ POST /api/pwa/issue и GET /api/pwa/issue?pairCode=…
 *
 * Токен — три части base64url: userId, expiresAt, HMAC-SHA256.
 * Формат разбирается функцией verifyPwaToken, клиенту достаточно хранить
 * строку целиком и знать, до какого момента она действительна.
 */
export interface PwaTokenResponse {
  token: string;
  /** Момент истечения в миллисекундах epoch. */
  expiresAt: number;
  /** Под кем выполнен вход. */
  userId: string;
  /** Профиль, чтобы приложение не делало лишний запрос сразу после входа. */
  profile: BootstrapProfile;
}

/** Тело запросов входа и регистрации. */
export interface LoginBody {
  login: string;
  password: string;
}

/** Тип уведомления в центре приложения. */
export type AppNotificationKind = 'broadcast' | 'grade' | 'mail' | 'order' | 'scholarship';

/**
 * Элемент ленты уведомлений.
 *
 * `text` есть только у объявлений администратора, `label`/`details` — у
 * событий. Поле `read` приходит только из списка; эндпоинт «следующее»
 * возвращает непрочитанное и без него.
 */
export interface AppNotificationItem {
  id: string;
  kind: AppNotificationKind;
  createdAt: string;
  read: boolean;
  label?: string;
  text?: string;
  details?: string[];
}

/** Ответ GET /api/notifications. */
export interface NotificationsFeedResponse {
  items: AppNotificationItem[];
  unread: number;
}

/** Ответ GET /api/notifications/unread-count. */
export interface NotificationsUnreadResponse {
  unread: number;
  events: number;
  broadcasts: number;
}