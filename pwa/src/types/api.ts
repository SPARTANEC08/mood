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
  /** Присылать ли Web Push в приложение (независимо от Telegram). */
  pushEnabled?: boolean;
  /** Сколько устройств подписано на push. */
  pushDevices?: number;
  /** Админ: показывает шестерёнку и доступ к /api/admin. */
  isAdmin?: boolean;
  /** Основной админ из ADMIN_BARS_LOGINS: управляет админами и настройками. */
  isEnvAdmin?: boolean;
  fullName: string;
  groupName: string;
  faculty?: string;
  recordBookNumber?: string;
  groupId?: number;
  /** Гостевой профиль: только расписание, без БАРС и личных разделов. */
  isGuest?: boolean;
}

/** Группа из поиска МЭИ для гостевого входа. */
export interface GuestGroup {
  id: number;
  label: string;
  description?: string;
}

export interface GuestGroupsResponse {
  items: GuestGroup[];
}

/** Ответ GET /api/auth/config. */
export interface AuthConfigResponse {
  tokenTtlMs: number;
  /** Открыта ли регистрация новых аккаунтов (и гостевой вход). */
  registrationOpen?: boolean;
}

/** Типы юридических документов, по которым даётся акцепт. */
export type LegalDocId =
  | 'processing'
  | 'dissemination'
  | 'push'
  | 'terms'
  | 'guest'
  | 'age';

export interface LegalDocumentMeta {
  id: LegalDocId;
  version: string;
  title: string;
  shortTitle: string;
  url: string;
  required: boolean;
}

export interface LegalStatus {
  consentRequired: boolean;
  missing: LegalDocId[];
  accepted: Array<{ id: LegalDocId; version: string; acceptedAt: string }>;
  documents: LegalDocumentMeta[];
  policy: { id: string; version: string; title: string; url: string };
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
  /** Согласия на юридические документы. */
  legal?: LegalStatus;
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
  /** Личная отметка «Сделано» (у разных студентов группы разная). */
  done: boolean;
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

/** Тип уведомления внутри приложения. */
export type AppNotificationKind = 'broadcast' | 'grade' | 'mail' | 'order' | 'scholarship';

/** Одна новая оценка в структурированном уведомлении. */
export interface AppNotificationGradeItem {
  discipline: string;
  point: number;
  title?: string;
  weight?: number;
  score: number;
  delta: number | null;
}

/**
 * Структурированные детали события.
 *
 * Сервер отдаёт их с новыми уведомлениями; у старых записей `data` нет, и
 * интерфейс показывает текстовые `details`.
 */
export type AppNotificationData =
  | { type: 'grade'; items: AppNotificationGradeItem[] }
  | { type: 'mail'; count: number }
  | { type: 'order'; items: Array<{ number?: string; date?: string; title: string }> }
  | {
      type: 'scholarship';
      appointed: boolean;
      scholarshipType?: string;
      period?: string;
      amount?: string;
    };

/** Уведомление для показа в PWA: рассылка или событие с деталями. */
export interface AppNotification {
  kind: AppNotificationKind;
  id: string;
  createdAt: string;
  /** Текст рассылки (только kind === 'broadcast'). */
  text?: string;
  /** Тип события для приложения (только события). */
  label?: string;
  /** Детали события текстом — fallback для старых записей. */
  details?: string[];
  /** Структурированные детали — используются, если пришли. */
  data?: AppNotificationData;
  /** Прочитано. Приходит из ленты; у «следующего» всегда false. */
  read?: boolean;
}

/** Ответ GET /api/notifications/next. */
export interface NextNotificationResponse {
  item: AppNotification | null;
}

/** Ответ GET /api/notifications — вся лента. */
export interface NotificationsFeedResponse {
  items: AppNotification[];
  unread: number;
}

/* ── админка ──────────────────────────────────────────────────────────────── */

export interface ActiveBreakdown {
  total: number;
  users: number;
  guests: number;
}

export interface AdminDayStats {
  date: string;
  requests: number;
  visits: number;
  maxOnline: number;
  newBarsSessions: number;
  currentBars: number;
  currentOnline: number;
  homework: { created: number; deleted: number; total: number };
  important: { created: number; deleted: number; total: number };
  platforms: { ios: number; android: number; web: number; unknown: number };
  files: { totalFiles: number; totalBytes: number };
  sessionsCount: number;
  /** Уникальные люди за день; null у старых срезов. */
  active: ActiveBreakdown | null;
  hours: Array<{ label: string; value: number }> | null;
  source: 'json' | 'html';
}

export type AdminStatsPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'date';

export interface AdminStatsResponse {
  period: AdminStatsPeriod;
  from: string;
  to: string;
  live: {
    requestsByHour: Array<{ label: string; value: number }>;
    windowStart: number;
    windowEnd: number;
    moscowNow: { date: string; time: string };
    /** Текущее состояние: сессии БАРС и онлайн за 5 минут. */
    current: { barsSessions: number; online: number };
    /** Календарный день по Москве: уникальные люди и открытия. */
    today: { active: ActiveBreakdown; visits: number; requests: number } | null;
    window: { visits: number; requests: number; active: ActiveBreakdown };
  } | null;
  days: AdminDayStats[];
  totals: {
    requests: number;
    visits: number;
    maxOnline: number;
    newBarsSessions: number;
    homeworkCreated: number;
    homeworkDeleted: number;
    importantCreated: number;
    importantDeleted: number;
  };
  latest: AdminDayStats | null;
  availableDates: string[];
}

export type AdminUserFilter = 'all' | 'bars' | 'guests' | 'admins';

export interface AdminUserSummary {
  id: string;
  name: string;
  group: string;
  platform: string;
  lastSeenAt: number;
  bars: 'active' | 'none';
  push: number;
  isGuest: boolean;
  isAdmin: boolean;
  createdAt: string;
}

export interface AdminUserDetails extends AdminUserSummary {
  faculty: string;
  recordBookNumber: string;
  barsAuthedAt: string | null;
  pwaTokens: number;
  pushEnabled: boolean;
  sessionValid: boolean;
}

export interface AdminJob {
  id: string;
  kind: 'broadcast' | 'notifier';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  progress: Record<string, number>;
  message?: string;
  error?: string;
}

export interface AdminAnnouncement {
  id: string;
  text: string;
  createdAt: string;
  createdBy?: number | string;
  targetUserId?: string;
  /** Ссылка в сообщении. */
  url?: string;
  /** false — только push, в ленте приложения не показывалось. */
  feed?: boolean;
  channels?: { feed: boolean; push: boolean };
}

export interface AdminAuditEntry {
  id: string;
  at: string;
  adminUserId: string;
  adminName: string;
  action: string;
  target?: string;
  details?: string;
}

export interface AdminDiagnostics {
  uptimeSec: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  disk: { totalBytes: number; freeBytes: number; usedRatio: number } | null;
  users: {
    total: number;
    guests: number;
    barsAuthorized: number;
    withTelegram: number;
    withPush: number;
  };
  pushDevices: number;
  notifier: { running: boolean; lastCycleFinishedAt: number | null; activeWindow: boolean };
  registrationOpen: boolean;
  jobs: { broadcast: string | null; notifier: string | null };
  audit: AdminAuditEntry[];
}

export interface AdminAdminsResponse {
  env: { barsHashes: number };
  assigned: Array<{ userId: string; name: string; group: string; addedAt: string }>;
}

/* ── темы оформления ──────────────────────────────────────────────────────── */

/** Один вариант темы: три оттенка HSL, насыщенность и светлота вычисляются. */
export interface ApiThemeVariant {
  backgroundHue: number;
  surfaceHue: number;
  accentHue: number;
}

export interface ApiThemeVariants {
  light?: ApiThemeVariant;
  dark?: ApiThemeVariant;
}

/** Тема в публичном API. Автор не отдаётся — только булев `mine`. */
export interface ApiTheme {
  id: string;
  name: string;
  variants: ApiThemeVariants;
  createdAt: string;
  mine: boolean;
}

export interface ThemesResponse {
  items: ApiTheme[];
}

export interface CreateThemeBody {
  name: string;
  variants: ApiThemeVariants;
}

export interface AdminTheme {
  id: string;
  name: string;
  variants: ApiThemeVariants;
  createdAt: string;
  status: 'published' | 'hidden' | 'deleted';
}

export interface AdminThemesResponse {
  items: AdminTheme[];
}
