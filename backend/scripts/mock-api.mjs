/**
 * Подставной сервер фронтенда: отдаёт собранный PWA и правдоподобные данные.
 *
 * Нужен для проверки вёрстки на настоящем телефоне: реальный API ходит в БАРС
 * и почту, а для проверки геометрии важна только форма ответа. Поэтому здесь
 * тот же контракт, что в backend/server/types.ts, но с выдуманными данными.
 *
 * Используется из backend/scripts/check-layout.mjs (автопроверки в браузере).
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'pwa', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const variant = (discipline, kindOfWork, kind, auditorium, lecturer) => ({
  discipline,
  kindOfWork,
  kind,
  auditorium,
  building: 'А',
  lecturerShort: lecturer,
  lecturerFullName: lecturer,
  onlineUrls: [],
});

const slot = (lessonNumber, timeStart, timeEnd, variants, homework = []) => ({
  lessonNumber,
  timeStart,
  timeEnd,
  variants,
  homework,
});

const day = (rawDate, dayOfWeek, dayShort, dayName, slots) => ({
  rawDate,
  dayOfWeek,
  dayShort,
  dayName,
  slots,
});

const HW = {
  id: 'hw-1',
  text: 'Прорешать задачи 3.4–3.9 из методички и сдать в систему до конца недели.',
  authorName: 'Иванов И.И.',
  createdAt: new Date().toISOString(),
  fileCount: 1,
};

/** Сегодня по Москве — расписание строится вокруг него, как в жизни. */
export const TODAY = (() => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}.${get('month')}.${get('day')}`;
})();

export function parseRawDate(raw) {
  const [y, m, d] = raw.split('.').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatRawDate(date) {
  return (
    `${date.getUTCFullYear()}.` +
    `${String(date.getUTCMonth() + 1).padStart(2, '0')}.` +
    `${String(date.getUTCDate()).padStart(2, '0')}`
  );
}

const LONG_DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const SHORT_DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/**
 * Выгрузка расписания: пять будних дней пяти недель вокруг сегодня.
 *
 * Выходных в выгрузке нет — как в БАРС. Сегодняшний день и понедельник
 * прошлой недели получают по пять пар, остальные — по одной или ни одной:
 * короткие дни нужны, чтобы проверить, что лента не растягивается под соседей.
 */
export const DAYS = (() => {
  const monday = parseRawDate(TODAY);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

  const result = [];

  for (let week = -2; week <= 2; week += 1) {
    for (let i = 0; i < 5; i += 1) {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + week * 7 + i);
      const rawDate = formatRawDate(date);

      const long = rawDate === TODAY || (week === -1 || week === 1) && i === 0;
      const slots = [];

      if (long) {
        slots.push(
          slot(1, '08:30', '10:00', [
            variant('Математический анализ', 'Лекционное занятие', 'lecture', 'Б-305', 'Петров П.П.'),
          ]),
          slot(
            2,
            '10:10',
            '11:40',
            [variant('Математический анализ', 'Практическое занятие', 'practice', 'Б-305', 'Петров П.П.')],
            [HW],
          ),
          slot(3, '12:45', '14:15', [variant('Физика', 'Лекционное занятие', 'lecture', 'А-101', 'Сидоров С.С.')]),
          slot(4, '14:25', '15:55', [variant('Физика', 'Лабораторная работа', 'lab', 'Л-7', 'Сидоров С.С.')]),
          slot(5, '16:05', '17:35', [
            variant('Программирование', 'Практическое занятие', 'practice', 'Д-204', 'Кузнецова А.А.'),
          ]),
        );
      } else if (i !== 2) {
        slots.push(
          slot(1, '08:30', '10:00', [variant('Физика', 'Практическое занятие', 'practice', 'А-101', 'Сидоров С.С.')]),
        );
      }

      result.push(day(rawDate, i + 1, SHORT_DAYS[i], LONG_DAYS[i], slots));
    }
  }

  return result;
})();

const API = {
  '/api/bootstrap': {
    profile: { telegramId: 1, fullName: 'Студентов Студент', groupName: 'А-19-1' },
    barsAuthorized: true,
    sessionValid: true,
    today: TODAY,
    weekNumber: 38,
    scheduleRange: { start: DAYS[0].rawDate, finish: DAYS[DAYS.length - 1].rawDate },
    mailUnread: 3,
  },
  '/api/schedule': { groupName: 'А-19-1', facultyName: 'ИТ', days: DAYS },
  '/api/homework': {
    items: [
      {
        id: 'hw-1',
        groupName: 'А-19-1',
        discipline: 'Математический анализ',
        kind: 'practice',
        targetDate: DAYS[1].rawDate,
        text: HW.text,
        authorName: HW.authorName,
        createdAt: HW.createdAt,
        files: [],
      },
    ],
  },
  '/api/important': { items: [] },
  '/api/subjects': { items: ['Математический анализ', 'Физика', 'Программирование'] },
  '/api/bars/grades': {
    semesterName: 'Осенний семестр 2026/27',
    overallAverage: 74.2,
    subjects: [
      {
        discipline: 'Математический анализ',
        controlType: 'Экзамен',
        currentAverage: 78,
        barsAverage: 75,
        gradedWeight: 40,
        totalWeight: 100,
        totalCount: 4,
        gradedCount: 3,
        pendingCount: 1,
        controlPoints: [
          { number: 1, title: 'КР-1', weight: 10, score: 82, week: '37', date: '20.09' },
          { number: 2, title: 'КР-2', weight: 10, score: 71, week: '39', date: '10.10' },
        ],
      },
    ],
  },
  '/api/bars/attendance': {
    totalMissedLessons: 7,
    totalExcusedLessons: 3,
    totalUnexcusedLessons: 4,
    totalMissedHours: 9.5,
    bySubject: [],
  },
  '/api/bars/more': {
    orders: [],
    scholarship: { isAppointed: false },
    libraryBooks: [],
    rating: {
      period: 'осенний семестр',
      academicScore: 78,
      studyScore: 82,
      parts: [],
      comprehensive: { key: 'c', title: 'Комплексный рейтинг', total: 84, semester: 84 },
      overall: 84,
    },
    academic: {
      debts: 2,
      closed: 6,
      total: 10,
      distribution: { fives: 14, fours: 9, threes: 3, twos: 2, total: 28 },
    },
  },
  '/api/mail': { total: 12, unseen: 3, messages: [] },
};

/**
 * Поднимает сервер со статикой и мок-данными.
 *
 * Запросы, изменяющие данные (удаление, отправка файла), намеренно отвечают
 * 501: на проверке вёрстки их не трогают, а молчаливый «успех» скрыл бы
 * рассинхрон интерфейса с данными.
 */
/**
 * Режимы проверки авторизации — выбираются параметром ?scenario= в адресе.
 *
 *  - normal     — всё работает (по умолчанию);
 *  - no-bars    — бот ответил, но студент не вошёл в БАРС: приложение должно
 *                 показать экран входа с кнопкой перехода в бота;
 *  - no-auth    — запросы без подписи Telegram: приложение должно сказать, что
 *                 его открыли не из Telegram, а не показать пустой интерфейс.
 */
function scenarioOf(url) {
  const raw = url.searchParams.get('scenario') ?? 'normal';
  return ['normal', 'no-bars', 'no-auth'].includes(raw) ? raw : 'normal';
}

export async function startMockServer(port = 5199) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Сценарий живёт в адресе страницы; на запросы API он не попадает, поэтому
    // берём его из Referer — иначе подставить режим проверки некуда.
    const scenario = scenarioOf(
      new URL(req.headers.referer ?? '/', 'http://localhost').pathname === '/'
        ? new URL(req.headers.referer ?? `http://x/?scenario=normal`, 'http://x')
        : url,
    );

    let body = API[url.pathname];

    if (scenario === 'no-bars' && url.pathname === '/api/bootstrap') {
      body = { ...API['/api/bootstrap'], barsAuthorized: false };
    }

    // Только для API: ассеты страницы тоже приходят с Referer на сценарий,
    // и без этой проверки режим отдавал бы 401 ещё и на скрипты — приложение
    // просто не запускалось, а проблема выглядела бы как «пропал вход».
    if (scenario === 'no-auth' && url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized', message: 'Требуется вход в приложение.', needBarsLogin: false }));
      return;
    }

    if (body) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'В проверочном режиме действие не выполняется.' }));
      return;
    }

    const rel =
      url.pathname === '/'
        ? 'index.html'
        : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1);

    try {
      const data = await readFile(join(DIST, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}
