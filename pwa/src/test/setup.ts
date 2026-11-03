/**
 * Тестовый стенд: настоящие компоненты приложения на фейковых данных.
 *
 * Страница /test/ не ходит в API и не читает реальные данные: здесь
 * подменяются `fetch` и `localStorage` ДО загрузки приложения. Настоящая
 * сессия и кэш пользователя не затрагиваются — всё живёт в памяти вкладки.
 *
 * Никакого отдельного UI здесь нет: дальше монтируется обычный ScheduleApp,
 * поэтому тестовая страница выглядит ровно как приложение.
 */

import type {
  ApiHomework,
  ApiImportant,
  ApiLessonSlot,
  ApiLessonVariant,
  ApiScheduleDay,
  AppNotification,
  AttendanceResponse,
  BarsMoreResponse,
  BarsSnapshotResponse,
  BootstrapResponse,
  GradesResponse,
  LegalStatus,
  MailResponse,
  ScheduleResponse,
} from '@/types/api';

const DAY = 86_400_000;
const MSK = 3 * 3_600_000;

/* ───────────────────────────── даты ───────────────────────────── */

const nowMs = Date.now();
const msk = new Date(nowMs + MSK);
const dowFromMonday = (msk.getUTCDay() + 6) % 7;

const mondayMs =
  Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - dowFromMonday * DAY;

function rawAt(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}.${mm}.${dd}`;
}

function rawOffset(days: number): string {
  return rawAt(mondayMs + (dowFromMonday + days) * DAY);
}

const TODAY_RAW = rawOffset(0);

/* ─────────────────────────── расписание ─────────────────────────── */

const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_NAME = [
  'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье',
];

function variant(
  discipline: string,
  kind: ApiLessonVariant['kind'],
  kindOfWork: string,
  auditorium: string,
  lecturerShort: string,
  lecturerFullName: string,
): ApiLessonVariant {
  return {
    discipline,
    kindOfWork,
    kind,
    auditorium,
    building: 'корп. Г',
    lecturerShort,
    lecturerFullName,
    onlineUrls: [],
  };
}

const TIMES: Array<[string, string]> = [
  ['09:00', '10:30'],
  ['10:40', '12:10'],
  ['12:40', '14:10'],
  ['14:20', '15:50'],
];

/**
 * Пара «прямо сейчас» для тестовой страницы.
 *
 * Время считается в момент открытия /test/, а не на сборке: благодаря этому
 * подсветка текущей пары видна независимо от того, когда открыли страницу.
 */
function currentSlotTimes(): [string, string] {
  const minutes = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  const start = Math.max(0, Math.min(minutes - 20, 23 * 60 + 30));
  const end = Math.min(23 * 60 + 59, Math.max(minutes + 40, start + 15));
  const format = (value: number): string =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return [format(start), format(end)];
}

function slotsFor(
  dayIndex: number,
  withHomework = false,
  firstTimes?: [string, string],
): ApiLessonSlot[] {
  const plans: Array<Array<ApiLessonVariant>> = [
    [
      variant('Математический анализ', 'practice', 'Практическое занятие', 'Г-312', 'Иванов И. И.', 'Иванов Иван Иванович'),
      variant('Физика', 'lecture', 'Лекция', 'А-201', 'Петров П. П.', 'Петров Пётр Петрович'),
      variant('Информатика', 'lab', 'Лабораторная работа', 'ВЦ-4', 'Сидоров С. С.', 'Сидоров Сергей Сергеевич'),
    ],
    [
      variant('История', 'practice', 'Семинар', 'Б-105', 'Кузнецова А. В.', 'Кузнецова Анна Викторовна'),
      variant('Физика', 'lab', 'Лабораторная работа', 'Ф-12', 'Петров П. П.', 'Петров Пётр Петрович'),
      variant('Математический анализ', 'lecture', 'Лекция', 'Г-101', 'Иванов И. И.', 'Иванов Иван Иванович'),
    ],
    [
      variant('Информатика', 'practice', 'Практическое занятие', 'ВЦ-2', 'Сидоров С. С.', 'Сидоров Сергей Сергеевич'),
      variant('Математический анализ', 'practice', 'Практическое занятие', 'Г-312', 'Иванов И. И.', 'Иванов Иван Иванович'),
      variant('Физкультура', 'practice', 'Практическое занятие', 'Спортзал', 'Орлов О. О.', 'Орлов Олег Олегович'),
    ],
    [
      variant('Физика', 'practice', 'Практическое занятие', 'Ф-5', 'Петров П. П.', 'Петров Пётр Петрович'),
      variant('История', 'lecture', 'Лекция', 'Б-201', 'Кузнецова А. В.', 'Кузнецова Анна Викторовна'),
      variant('Английский язык', 'practice', 'Практическое занятие', 'И-14', 'Смирнова Е. А.', 'Смирнова Елена Андреевна'),
    ],
    [
      variant('Математический анализ', 'lab', 'Лабораторная работа', 'Г-312', 'Иванов И. И.', 'Иванов Иван Иванович'),
      variant('Информатика', 'lecture', 'Лекция', 'ВЦ-1', 'Сидоров С. С.', 'Сидоров Сергей Сергеевич'),
    ],
  ];

  const dayPlan = plans[dayIndex % plans.length]!;

  return dayPlan.map((v, index) => ({
    lessonNumber: index + 1,
    timeStart: index === 0 && firstTimes ? firstTimes[0] : TIMES[index]![0],
    timeEnd: index === 0 && firstTimes ? firstTimes[1] : TIMES[index]![1],
    variants: [v],
    homework:
      withHomework && index === 0
        ? [
            {
              id: 'hw-math-1',
              text: 'Задачи 12–18 из методички',
              authorName: 'Иванов И. И.',
              createdAt: new Date(nowMs - 2 * DAY).toISOString(),
              fileCount: 1,
            },
          ]
        : [],
  }));
}

const schedule: ScheduleResponse = {
  groupName: 'ИЭ-11-26',
  facultyName: 'ИЭТЭ',
  days: Array.from({ length: 7 }, (_, index): ApiScheduleDay => ({
    rawDate: rawAt(mondayMs + index * DAY),
    dayOfWeek: index + 1,
    dayShort: DAY_SHORT[index]!,
    dayName: DAY_NAME[index]!,
    // В тесте у сегодняшнего дня пара гарантированно идёт прямо сейчас.
    slots:
      index < 5 || index === dowFromMonday
        ? slotsFor(index, index === 1, index === dowFromMonday ? currentSlotTimes() : undefined)
        : [],
  })),
};

/* ───────────────────────────── ДЗ и «Важное» ───────────────────────────── */

const homework: ApiHomework[] = [
  {
    id: 'hw-math-1',
    groupName: 'ИЭ-11-26',
    discipline: 'Математический анализ',
    kind: 'practice',
    targetDate: rawOffset(0),
    lessonNumber: 1,
    timeStart: '09:00',
    text: 'Задачи 12–18 из методички, оформить в тетради.',
    authorName: 'Староста',
    createdAt: new Date(nowMs - 2 * DAY).toISOString(),
    files: [],
    canEdit: false,
    done: false,
  },
  {
    id: 'hw-phys-1',
    groupName: 'ИЭ-11-26',
    discipline: 'Физика',
    kind: 'lab',
    targetDate: rawOffset(2),
    lessonNumber: 2,
    timeStart: '10:40',
    text: 'Подготовить отчёт по лабораторной работе №2.',
    authorName: 'Петров П. П.',
    createdAt: new Date(nowMs - DAY).toISOString(),
    files: [],
    canEdit: true,
    done: false,
  },
  {
    id: 'hw-hist-1',
    groupName: 'ИЭ-11-26',
    discipline: 'История',
    kind: 'practice',
    targetDate: rawOffset(5),
    lessonNumber: 1,
    text: 'Эссе на тему «Реформы Александра II».',
    createdAt: new Date(nowMs - 3 * DAY).toISOString(),
    files: [],
    canEdit: false,
    done: true,
  },
  {
    id: 'hw-inf-1',
    groupName: 'ИЭ-11-26',
    discipline: 'Информатика',
    kind: 'practice',
    targetDate: rawOffset(-2),
    lessonNumber: 3,
    text: 'Доделать задачи на массивы.',
    createdAt: new Date(nowMs - 5 * DAY).toISOString(),
    files: [],
    canEdit: false,
    done: false,
  },
];

const important: ApiImportant[] = [
  {
    id: 'imp-1',
    groupName: 'ИЭ-11-26',
    title: 'Перенос консультации',
    text: 'Консультация по матану переносится на четверг, 16:00, ауд. Г-312.',
    authorName: 'Староста',
    createdAt: new Date(nowMs - DAY).toISOString(),
    files: [],
    canEdit: false,
  },
  {
    id: 'imp-2',
    groupName: 'ИЭ-11-26',
    title: 'Фото задания с доски',
    text: 'Кто не успел записать — во вложении.',
    authorName: 'Иванов И. И.',
    createdAt: new Date(nowMs - 2 * DAY).toISOString(),
    files: [],
    canEdit: false,
  },
];

/* ───────────────────────────── БАРС и почта ───────────────────────────── */

const grades: GradesResponse = {
  semesterName: 'Осенний семестр 2026/2027',
  overallAverage: 4.38,
  subjects: [
    {
      discipline: 'Математический анализ',
      controlType: 'экзамен',
      attestation: 'экзамен',
      currentAverage: 4,
      barsAverage: 4,
      gradedWeight: 90,
      totalWeight: 100,
      totalCount: 4,
      gradedCount: 3,
      pendingCount: 1,
      controlPoints: [
        { number: 1, title: 'КМ №1', weight: 30, score: 5, date: '15.09' },
        { number: 2, title: 'КМ №2', weight: 30, score: 2, date: '06.10' },
        { number: 3, title: 'КМ №3', weight: 30, score: 5, date: '20.10' },
        { number: 4, title: 'КМ №4', weight: 10, score: null, date: '10.11' },
      ],
    },
    {
      discipline: 'Физика',
      controlType: 'зачёт с оценкой',
      attestation: 'зачёт с оценкой',
      currentAverage: 4.43,
      barsAverage: 4.5,
      gradedWeight: 70,
      totalWeight: 100,
      totalCount: 3,
      gradedCount: 2,
      pendingCount: 1,
      controlPoints: [
        { number: 1, title: 'КМ №1', weight: 40, score: 4, date: '22.09' },
        { number: 2, title: 'КМ №2', weight: 30, score: 5, date: '13.10' },
        { number: 3, title: 'КМ №3', weight: 30, score: null, date: '17.11' },
      ],
    },
    {
      discipline: 'Информатика',
      controlType: 'зачёт',
      attestation: 'зачёт',
      currentAverage: 4.75,
      barsAverage: 5,
      gradedWeight: 80,
      totalWeight: 100,
      totalCount: 5,
      gradedCount: 4,
      pendingCount: 1,
      controlPoints: [
        { number: 1, title: 'КМ №1', weight: 20, score: 5, date: '11.09' },
        { number: 2, title: 'КМ №2', weight: 20, score: 5, date: '02.10' },
        { number: 3, title: 'КМ №3', weight: 20, score: 5, date: '16.10' },
        { number: 4, title: 'КМ №4', weight: 20, score: 4, date: '23.10' },
        { number: 5, title: 'КМ №5', weight: 20, score: null, date: '20.11' },
      ],
    },
  ],
};

const attendance: AttendanceResponse = {
  totalMissedLessons: 6,
  totalExcusedLessons: 2,
  totalUnexcusedLessons: 4,
  totalMissedHours: 12,
  totalExcusedHours: 4,
  totalUnexcusedHours: 8,
  bySubject: [
    { discipline: 'Математический анализ', missedLessons: 2, excusedLessons: 1, unexcusedLessons: 1, totalMissedHours: 4, excusedHours: 2, unexcusedHours: 2 },
    { discipline: 'Физика', missedLessons: 3, excusedLessons: 1, unexcusedLessons: 2, totalMissedHours: 6, excusedHours: 2, unexcusedHours: 4 },
    { discipline: 'История', missedLessons: 1, excusedLessons: 0, unexcusedLessons: 1, totalMissedHours: 2, excusedHours: 0, unexcusedHours: 2 },
  ],
};

const more: BarsMoreResponse = {
  orders: [
    { number: '123-С', date: '01.10.2026', title: 'О назначении академической стипендии', status: 'действует' },
    { number: '77-У', date: '15.09.2026', title: 'О зачислении в вуз', status: 'действует' },
  ],
  scholarship: {
    isAppointed: true,
    type: 'Академическая',
    period: 'сентябрь–декабрь 2026',
    amount: '3 000 ₽',
  },
  libraryBooks: [
    { title: 'Математический анализ', author: 'Ильин В. А.', issueDate: '10.09.2026', dueDate: '10.11.2026', isOverdue: false },
    { title: 'Курс физики', author: 'Савельев И. В.', issueDate: '12.09.2026', dueDate: '12.10.2026', isOverdue: true },
  ],
  rating: {
    period: '2025/2026',
    academicScore: 78,
    studyScore: 82,
    parts: [
      { key: 'study', title: 'Учебная деятельность', total: 82, semester: 27 },
      { key: 'science', title: 'Научная деятельность', total: 12, semester: 4 },
      { key: 'social', title: 'Общественная деятельность', total: 10, semester: 3 },
      { key: 'creative', title: 'Творчество', total: 6, semester: 2 },
      { key: 'sport', title: 'Спорт', total: 8, semester: 2 },
      { key: 'discipline', title: 'Дисциплина', total: 2, semester: 1 },
    ],
    comprehensive: { key: 'total', title: 'Совокупный', total: 120, semester: 40 },
    overall: 120,
  },
  academic: {
    debts: 1,
    closed: 9,
    total: 12,
    distribution: { fives: 6, fours: 2, threes: 0, twos: 1, total: 9 },
  },
};

const mail: MailResponse = {
  total: 42,
  unseen: 2,
};

/**
 * Юридический статус для тестовой страницы.
 *
 * Dissemination намеренно не принят: в «Кабинете» видно свёрнутый блок
 * «Документы и согласия» с бейджем «1». ConsentGate при этом не показывается —
 * missing пуст, иначе демо-стенд упёрся бы в экран согласий.
 */
const legal: LegalStatus = {
  consentRequired: false,
  missing: [],
  accepted: [
    { id: 'processing', version: '1.1', acceptedAt: new Date(nowMs - 10 * DAY).toISOString() },
    { id: 'terms', version: '1.1', acceptedAt: new Date(nowMs - 10 * DAY).toISOString() },
    { id: 'age', version: '1.1', acceptedAt: new Date(nowMs - 10 * DAY).toISOString() },
  ],
  documents: [
    {
      id: 'processing',
      version: '1.1',
      title: 'Согласие на обработку персональных данных',
      shortTitle: 'Обработка персональных данных',
      url: '/legal/consent-processing.html',
      required: true,
    },
    {
      id: 'dissemination',
      version: '1.1',
      title: 'Согласие на предоставление данных одногруппникам',
      shortTitle: 'Данные в материалах группы',
      url: '/legal/consent-dissemination.html',
      required: true,
    },
    {
      id: 'push',
      version: '1.1',
      title: 'Согласие на уведомления в приложении (Web Push)',
      shortTitle: 'Push-уведомления',
      url: '/legal/consent-push.html',
      required: false,
    },
    {
      id: 'terms',
      version: '1.1',
      title: 'Пользовательское соглашение',
      shortTitle: 'Пользовательское соглашение',
      url: '/legal/terms.html',
      required: true,
    },
    {
      id: 'age',
      version: '1.1',
      title: 'Подтверждение возраста 18+',
      shortTitle: 'Подтверждение 18+',
      url: '/legal/age-18.html',
      required: true,
    },
  ],
  policy: {
    id: 'privacy',
    version: '1.1',
    title: 'Политика обработки персональных данных',
    url: '/legal/privacy-policy.html',
  },
};

/** Четыре события в новых форматах для модалки и центра уведомлений. */
const notifications: AppNotification[] = [
  {
    id: 'test-notif-grade',
    kind: 'grade',
    createdAt: new Date(nowMs - 60_000).toISOString(),
    read: false,
    label: 'Новая оценка',
    details: ['Математический анализ · КМ3: 5'],
    data: {
      type: 'grade',
      items: [
        {
          discipline: 'Математический анализ',
          point: 3,
          title: 'КМ №3',
          weight: 30,
          score: 5,
          delta: null,
        },
      ],
    },
  },
  {
    id: 'test-notif-mail',
    kind: 'mail',
    createdAt: new Date(nowMs - 120_000).toISOString(),
    read: false,
    label: 'Новое письмо',
    details: ['Новых писем: 3'],
    data: { type: 'mail', count: 3 },
  },
  {
    id: 'test-notif-order',
    kind: 'order',
    createdAt: new Date(nowMs - 180_000).toISOString(),
    read: false,
    label: 'Новый приказ',
    details: ['Новых приказов: 1'],
    data: {
      type: 'order',
      items: [
        {
          number: '123-С',
          date: '01.11.2026',
          title: 'О назначении государственной академической стипендии',
        },
      ],
    },
  },
  {
    id: 'test-notif-scholarship',
    kind: 'scholarship',
    createdAt: new Date(nowMs - 240_000).toISOString(),
    read: false,
    label: 'Назначена стипендия',
    details: ['Назначена: Академическая, 2026/2027'],
    data: {
      type: 'scholarship',
      appointed: true,
      scholarshipType: 'Академическая',
      period: '2026/2027',
      amount: '3 000 ₽',
    },
  },
];

const readNotifications = new Set<string>();
/** Показывать ли уведомления: по умолчанию нет, чтобы не закрывать экраны. */
const showNotifications =
  new URLSearchParams(window.location.search).get('notif') === '1';

const bootstrap: BootstrapResponse = {
  profile: {
    userId: 'test-user',
    fullName: 'Иванов Иван Иванович',
    groupName: 'ИЭ-11-26',
    faculty: 'ИЭТЭ',
    recordBookNumber: '1020260000',
    groupId: 12345,
    pushEnabled: true,
    pushDevices: 1,
  },
  barsAuthorized: true,
  sessionValid: true,
  today: TODAY_RAW,
  weekNumber: 8,
  scheduleRange: { start: rawAt(nowMs - 14 * DAY), finish: rawAt(nowMs + 90 * DAY) },
  mailUnread: 2,
  legal,
};

const snapshot: BarsSnapshotResponse = {
  grades,
  attendance,
  more,
  mail,
  mailError: null,
  fetchedAt: new Date().toISOString(),
};

/* ───────────────────────────── объявления ───────────────────────────── */

const announcements = [
  {
    id: 'test-broadcast-1',
    text: 'В четверг в 18:00 общее собрание группы. Явка обязательна.',
    createdAt: new Date(nowMs - 5 * 60_000).toISOString(),
  },
  {
    id: 'test-broadcast-2',
    text: 'Напоминание: зачёт по физкультуре в пятницу, не забудьте форму.',
    createdAt: new Date(nowMs - DAY).toISOString(),
  },
];

const dismissed = new Set<string>();

/* ───────────────────────────── storage ───────────────────────────── */

function installTestStorage(): void {
  const map = new Map<string, string>();
  map.set('mood_pwa_token', 'dGVzdC11c2Vy.OTk5OTk5OTk5OTk5.c2ln');
  map.set('mood_pwa_token_expires', String(Date.now() + DAY));

  const shim = {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
  } as Storage;

  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
    return;
  } catch {
    // Браузер запретил подмену: перехватываем только ключи приложения, реальные
    // данные не трогаем.
  }

  const proto = Storage.prototype;
  const originalGet = proto.getItem;
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;

  proto.getItem = function (key: string): string | null {
    return key.startsWith('mood') ? (map.get(key) ?? null) : originalGet.call(this, key);
  };
  proto.setItem = function (key: string, value: string): void {
    if (key.startsWith('mood')) map.set(key, value);
    else originalSet.call(this, key, value);
  };
  proto.removeItem = function (key: string): void {
    if (key.startsWith('mood')) map.delete(key);
    else originalRemove.call(this, key);
  };
}

/* ───────────────────────────── fetch ───────────────────────────── */

const realFetch = window.fetch.bind(window);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loadAnnouncement(): unknown {
  for (const item of announcements) {
    if (!dismissed.has(item.id)) return item;
  }
  return null;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);

  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);

  const path = url.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();

  if (path === '/api/bootstrap') return json(bootstrap);
  if (path === '/api/auth/me') return json(bootstrap.profile);
  if (path === '/api/auth/config') return json({ tokenTtlMs: 90 * DAY, registrationOpen: true });

  if (path === '/api/schedule') return json(schedule);
  if (path.startsWith('/api/homework/') && path.endsWith('/done')) {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    const item = homework.find((hw) => hw.id === id);
    if (!item) return json({ error: 'not_found', message: 'Задание не найдено.' }, 404);
    if (item.targetDate < TODAY_RAW) {
      return json({ error: 'overdue', message: 'Просроченное задание нельзя отметить.' }, 409);
    }
    item.done = method === 'POST';
    return json({ id, done: item.done });
  }

  if (path === '/api/homework') return json({ items: homework });
  if (path === '/api/important') return json({ items: important });
  if (path === '/api/subjects') {
    return json({ items: [...new Set(schedule.days.flatMap((day) => day.slots.flatMap((slot) => slot.variants.map((v) => v.discipline))))] });
  }

  if (path === '/api/bars/grades') return json(grades);
  if (path === '/api/bars/attendance') return json(attendance);
  if (path === '/api/bars/more') return json(more);
  if (path === '/api/bars/refresh') return json(snapshot);
  if (path === '/api/mail') return json(mail);

  if (path === '/api/notifications/state') {
    return json({ pushEnabled: true, pushDevices: 1 });
  }
  if (path === '/api/notifications/toggle') {
    return json({ ok: true, enabled: true, pushEnabled: true, pushDevices: 1 });
  }

  if (path === '/api/notifications') {
    const items = notifications
      .map((item) => ({ ...item, read: readNotifications.has(item.id) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ items, unread: items.filter((item) => !item.read).length });
  }
  if (path === '/api/notifications/next') {
    if (!showNotifications) return json({ item: null });
    const item = [...notifications]
      .filter((entry) => !readNotifications.has(entry.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return json({ item: item ?? null });
  }
  if (path.startsWith('/api/notifications/') && path.endsWith('/read') && method === 'POST') {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    readNotifications.add(id);
    return json({ ok: true });
  }
  if (path === '/api/notifications/unread-count') {
    return json({
      unread: notifications.filter((item) => !readNotifications.has(item.id)).length,
      events: notifications.filter((item) => !readNotifications.has(item.id)).length,
      broadcasts: 0,
    });
  }

  if (path === '/api/announcements/next') return json({ item: loadAnnouncement() });
  if (path.startsWith('/api/announcements/') && path.endsWith('/dismiss') && method === 'POST') {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    dismissed.add(id);
    return json({ ok: true });
  }

  if (path.startsWith('/api/files/')) return json({ error: 'not_found' }, 404);

  return json({});
}) as typeof fetch;

installTestStorage();
