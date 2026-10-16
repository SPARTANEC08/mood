/**
 * Проверка снимка БАРС и почты в памяти.
 *
 * Модуль ходит в чужой сайт (bars.mpei.ru и IMAP МЭИ), поэтому проверяется он
 * подменой: и сервис БАРС, и почтовый клиент здесь фальшивые и считают свои
 * вызовы. Это единственный способ проверить кэш, дедупликацию и изоляцию
 * ошибок, не нагружая МЭИ настоящими запросами.
 *
 * Проверяется:
 *  - первый вызов действительно идёт в БАРС и IMAP, последующие — нет;
 *  - параллельные вызовы одного пользователя дедуплицируются;
 *  - force пробивает TTL и ЖДЁТ загрузку, а не отдаёт старый снимок;
 *  - падение почты не роняет снимок, падение БАРС — пробрасывается;
 *  - после неудачи промис сброшен: пользователь не остаётся без данных до
 *    перезапуска процесса.
 *
 * Сеть не используется. Запуск: npm run test:snapshot
 */

import {
  barsSnapshotStats,
  getBarsSnapshot,
  invalidateBarsSnapshot,
  peekBarsSnapshot,
  SNAPSHOT_TTL_MS,
} from '../src/services/bars/barsSnapshotCache.ts';

/** Счётчики вызовов подмены: по ним видно, ходили ли мы куда-нибудь. */
let barsCalls = 0;
let mailCalls = 0;

const scraper = {
  async getCurrentSemesterGrades() {
    barsCalls += 1;
    return {
      semesterName: '2026/2027, Осенний семестр',
      subjects: [
        {
          discipline: 'Математика',
          controlType: 'экзамен',
          controlPoints: [{ number: 1, score: 5, weight: 1 }],
        },
      ],
    };
  },
  async getAttendance() {
    barsCalls += 1;
    return {
      totalMissedLessons: 1,
      totalExcusedLessons: 0,
      totalUnexcusedLessons: 1,
      totalMissed: 2,
      totalExcused: 0,
      totalUnexcused: 2,
      bySubject: [],
    };
  },
  async getOrders() {
    barsCalls += 1;
    return [{ number: '1', date: '01.09.2026', title: 'О приёме' }];
  },
  async getScholarship() {
    barsCalls += 1;
    return { isAppointed: true };
  },
  async getLibraryBooks() {
    barsCalls += 1;
    return [];
  },
  async getRating() {
    barsCalls += 1;
    return {
      period: null,
      academicScore: null,
      studyScore: null,
      parts: [],
      comprehensive: null,
      overall: null,
    };
  },
};

/** Подмена BarsService: кэшу нужен только скрапер. */
const service = { getScraper: () => scraper } as unknown as Parameters<
  typeof getBarsSnapshot
>[1];

const mailClient = {
  async getInboxStatus() {
    mailCalls += 1;
    return { total: 3, unseen: 2 };
  },
  async fetchMessages() {
    mailCalls += 1;
    return [
      {
        uid: 1,
        from: 'dean@mpei.ru',
        subject: 'О приёме',
        date: new Date(),
        isSeen: false,
        hasAttachments: false,
      },
    ];
  },
} as unknown as Parameters<typeof getBarsSnapshot>[2];

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Сколько походов делает один полный обход: 6 разделов. Страница успеваемости
 * одна на оба потребителя — и на блок оценок, и на сводку задолженностей.
 */
const CALLS_PER_LOAD = 6;

console.log('\n=== Снимок БАРС и почты в памяти ===\n');

console.log('— Первая загрузка —');
{
  const snapshot = await getBarsSnapshot('u1', service, mailClient);

  check('сделан полный обход БАРС', barsCalls === CALLS_PER_LOAD, String(barsCalls));
  check('сделан поход в IMAP', mailCalls === 2, String(mailCalls));
  check('оценки посчитаны', snapshot.grades.overallAverage === 5);
  check(
    'задолженности и закрытые КМ посчитаны',
    snapshot.more.academic.debts === 0 && snapshot.more.academic.closed === 1,
    JSON.stringify(snapshot.more.academic),
  );
  check('приказы на месте', snapshot.more.orders.length === 1);
  check('почта внутри снимка', snapshot.mail?.unseen === 2 && snapshot.mailError === null);
  check('проставлено время загрузки', typeof snapshot.fetchedAt === 'string');
}

console.log('\n— Повторный запрос читает кэш —');
{
  const again = await getBarsSnapshot('u1', service, mailClient);

  check('в сеть не сходили', barsCalls === CALLS_PER_LOAD && mailCalls === 2);
  check('отдан тот же объект снимка', again === (peekBarsSnapshot('u1') ?? null));
}

console.log('\n— Дедупликация параллельных запросов —');
{
  invalidateBarsSnapshot('u1');
  const before = barsCalls;

  const [first, second] = await Promise.all([
    getBarsSnapshot('u1', service, mailClient),
    getBarsSnapshot('u1', service, mailClient),
  ]);

  check('оба вызова получили один промис', first === second);
  check('поход в БАРС один, а не два', barsCalls - before === CALLS_PER_LOAD, String(barsCalls - before));
}

console.log('\n— force пробивает TTL —');
{
  const warm = await getBarsSnapshot('u1', service, mailClient);
  const before = barsCalls;

  const forced = await getBarsSnapshot('u1', service, mailClient, { force: true });

  check('force ушёл в сеть', barsCalls - before === CALLS_PER_LOAD, String(barsCalls - before));
  // Ключевое: stale-while-revalidate не должен срабатывать на форсированном
  // запросе — иначе кнопка «Обновить» возвращала бы то, что было до неё.
  check('force дождался свежего снимка', forced !== warm);
}

console.log('\n— peek не вызывает загрузку —');
{
  const before = barsCalls;
  const peeked = peekBarsSnapshot('u1');

  check('peek отдаёт снимок', peeked?.grades.semesterName === '2026/2027, Осенний семестр');
  check('peek не ходит в БАРС', barsCalls === before);
  check('peek неизвестного — null', peekBarsSnapshot('нет-такого') === null);
}

console.log('\n— Изоляция ошибок —');
{
  invalidateBarsSnapshot('u2');

  const brokenMail = {
    getInboxStatus: async () => {
      throw new Error('imap недоступен');
    },
    fetchMessages: async () => [],
  } as unknown as Parameters<typeof getBarsSnapshot>[2];

  const snapshot = await getBarsSnapshot('u2', service, brokenMail);
  check('упавшая почта не роняет снимок', snapshot.grades.subjects.length === 1);
  check('почта помечена недоступной', snapshot.mail === null && snapshot.mailError !== null);

  invalidateBarsSnapshot('u3');

  const brokenBars = {
    getScraper: () => ({
      ...scraper,
      getCurrentSemesterGrades: async () => {
        throw new Error('Сессия истекла');
      },
    }),
  } as unknown as Parameters<typeof getBarsSnapshot>[1];

  let caught: unknown = null;
  try {
    await getBarsSnapshot('u3', brokenBars, mailClient);
  } catch (err: unknown) {
    caught = err;
  }

  check('отказ БАРС пробрасывается вызывающему', caught instanceof Error);
  check(
    'текст ошибки не потерян',
    caught instanceof Error && caught.message === 'Сессия истекла',
  );
  check(
    'промис сброшен: следующий запрос сможет повторить',
    barsSnapshotStats().inflight === 0,
  );
}

console.log('\n— Снимок без почтового клиента —');
{
  invalidateBarsSnapshot('u4');
  const snapshot = await getBarsSnapshot('u4', service, null);

  check('снимок собран', snapshot.grades.subjects.length === 1);
  check('почты нет', snapshot.mail === null);
}

console.log('\n— Счётчики и вытеснение —');
{
  const stats = barsSnapshotStats();
  // u3 не сохранялся: его загрузка упала, и именно это проверялось выше.
  check('счётчики живы', stats.users === 3 && stats.inflight === 0, JSON.stringify(stats));
  check('TTL совпадает с периодом нотификатора', SNAPSHOT_TTL_MS === 20 * 60 * 1000);
}

console.log(
  `\n${failures === 0 ? '✅' : '❌'} Снимок БАРС: ${checks - failures} ok, ${failures} ошибок\n`,
);
process.exit(failures === 0 ? 0 : 1);