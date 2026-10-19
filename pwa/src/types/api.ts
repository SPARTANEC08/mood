/**
 * Контракты API PWA — клиентская копия src/server/types.ts.
 *
 * Файл намеренно продублирован, а не импортирован с сервера: клиент не должен
 * зависеть от модулей бота, иначе типы из src/storage и src/parser попадут
 * в бандл. При изменении контракта правятся оба файла — они рядом и
 * проверяются компилятором.
 */

/**
 * Ссылка на файл в серверном хранилище.
 *
 * Повторяет серверный ServerFileRef, но объявлена здесь: клиент не должен
 * импортировать серверные модули. Telegram в этой схеме не участвует —
 * файл лежит в data/files/<userId>/, а fileId это UUID.
 */
export interface ServerFileRef {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** Профиль студента для шапки приложения. */
export interface BootstrapProfile {
  /** Идентификатор пользователя в Mood — общий для бота и PWA. */
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
  fullName: string;
  groupName: string;
  faculty?: string;
  recordBookNumber?: string;
  groupId?: number;
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

/**
 * Тип занятия.
 * Дублируется здесь специально: клиент не должен импортировать серверные
 * модули — иначе типы из src/server попадут в бандл и свяжут сборку с ботом.
 */


/**
 * Тип занятия.
 *
 * Дублируется здесь, а не импортируется с сервера: клиент не должен зависеть
 * от модулей бота, иначе типы из src/storage попадут в бандл. При изменении
 * правятся оба файла — src/server/types.ts и этот.
 */
export type LessonKindType = 'lecture' | 'practice' | 'lab';

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
  total: number | null;
  semester: number | null;
}

/** Распределение выставленных оценок по КМ. */
export interface GradeDistribution {
  fives: number;
  fours: number;
  threes: number;
  twos: number;
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
    academicScore: number | null;
    studyScore: number | null;
    parts: ApiRatingPart[];
    comprehensive: ApiRatingPart | null;
    overall: number | null;
  };
  /** Задолженности и распределение оценок. */
  academic: {
    debts: number;
    closed: number;
    total: number;
    distribution: GradeDistribution;
  };
}

/** Письмо ОСЭП в API. */
export interface ApiMailMessage {
  uid: number;
  from: string;
  subject: string;
  /** ISO-дата для форматирования на клиенте. */
  date: string;
  isSeen: boolean;
  hasAttachments: boolean;
}

/** Ответ GET /api/mail. */
export interface MailResponse {
  total: number | null;
  unseen: number | null;
  messages: ApiMailMessage[];
}

/**
 * Снимок данных БАРС и почты — ответ POST /api/bars/refresh.
 *
 * Приходит целиком: сервер всё равно собирает снимок за один поход в МЭИ, а
 * после принудительного обновления клиенту нужны и оценки, и пропуски, и
 * рейтинг сразу. Почта внутри — единственный необязательный блок.
 */
export interface BarsSnapshotResponse {
  grades: GradesResponse;
  attendance: AttendanceResponse;
  more: BarsMoreResponse;
  /** null, если в этом круге почта не ответила. */
  mail: MailResponse | null;
  /** Причина, по которой mail === null. */
  mailError: string | null;
  /** Момент, когда сервер сходил в МЭИ (ISO). */
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
}

/** Ответ GET /api/homework. */
export interface HomeworkResponse {
  items: ApiHomework[];
}

/** Тело POST /api/homework. */
export interface CreateHomeworkBody {
  discipline: string;
  kind: LessonKindType;
  text: string;
  /** Результаты предварительной загрузки через /api/files/upload. */
  fileIds?: string[];
}

/**
 * Тело PATCH /api/homework/:id.
 *
 * fileIds — полный новый состав: сервер удаляет всё, чего в списке нет.
 * Предмет и тип занятия не меняются — по ним запись привязана к конкретной паре.
 */
export interface UpdateHomeworkBody {
  text?: string;
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

/** Ответ GET /api/subjects. */
export interface SubjectsResponse {
  /** Все дисциплины из расписания группы. */
  items: string[];
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
  fileIds?: string[];
}

/** Ошибка API. */
export interface ApiError {
  error: string;
  message: string;
  /** true = клиенту нужно предложить вход в БАРС через бота. */
  needBarsLogin: boolean;
}

/** Объявление админа, которое показывается модальным окном в приложении. */
export interface AppAnnouncement {
  id: string;
  text: string;
  createdAt: string;
}

/** Ответ GET /api/announcements/next. */
export interface NextAnnouncementResponse {
  item: AppAnnouncement | null;
}