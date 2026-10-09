/**
 * Тесты фонового нотификатора: окно активности, диффы снимков, сетевые ошибки.
 * Сеть не используется — проверяется чистая логика.
 * Запуск: npx tsx scripts/test-notifier.ts
 */

import 'dotenv/config';

import type { SemesterGrades } from '../src/services/bars/parsers/gradesParser.js';
import type { UserSnapshot } from '../src/storage/snapshotStore.js';
import {
  buildGradesHash,
  buildScholarshipStatus,
  diffSnapshots,
  isTransientNetworkError,
  isWithinActiveWindow,
  renderNotification,
} from '../src/services/notifications/barsNotifier.js';
import { encrypt } from '../src/utils/crypto.js';
import { userStore } from '../src/storage/userStore.js';
import { snapshotStore } from '../src/storage/snapshotStore.js';

const TEST_ID = 998_777_666;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

const TZ = 'Europe/Moscow';

/** Текущий час по Москве — для проверки окна 08:00–23:00. */
function moscowHourNow(): number {
  return Number.parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(),
    ),
    10,
  );
}

function baseSnapshot(over: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    gradesHash: {},
    lastSeenMailUid: 0,
    ordersCount: 0,
    scholarshipStatus: 'нет',
    lastCheckedAt: new Date().toISOString(),
    ...over,
  };
}

function grades(subjects: SemesterGrades['subjects']): SemesterGrades {
  return { semesterName: '2026/2027, Осенний', isCurrent: true, subjects };
}

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('   ТЕСТЫ ФОНОВОГО НОТИФИКАТОРА БАРС/ОСЭП   ');
  console.log('====================================================');

  section('Активное окно 08:00–23:00 МСК');
  const hour = moscowHourNow();
  const inWindow = isWithinActiveWindow();
  check('isWithinActiveWindow согласуется с текущим часом', inWindow === (hour >= 8 && hour < 23), `час=${hour}`);
  console.log(`     (сейчас ${hour}:00 МСК, в окне: ${inWindow ? 'да' : 'нет'})`);

  section('Хеш баллов');
  const hash = buildGradesHash(
    grades([
      {
        discipline: 'Математический анализ',
        controlType: 'Экзамен',
        controlPoints: [
          { number: 1, score: 25, weight: 50 },
          { number: 2, score: null, weight: 50 },
        ],
        weekScores: [],
        totalScore: 25,
      },
      {
        discipline: 'Линейная алгебра',
        controlType: 'Экзамен',
        controlPoints: [{ number: 1, score: 40, weight: 100 }],
        weekScores: [],
        totalScore: 40,
      },
    ]),
  );
  check('ключ по дисциплине и КТ', hash['Математический анализ_КТ1'] === 25);
  check('незакрытая КТ = null', hash['Математический анализ_КТ2'] === null);
  check('вторая дисциплина попала', hash['Линейная алгебра_КТ1'] === 40);

  section('Статус стипендии');
  check('нет стипендии -> "нет"', buildScholarshipStatus({ isAppointed: false }) === 'нет');
  check(
    'стипендия с типом и периодом',
    buildScholarshipStatus({ isAppointed: true, type: 'академическая', period: '01.09.2026 — 31.12.2026' }) ===
      'академическая, 01.09.2026 — 31.12.2026',
  );
  check('стипендия без деталей', buildScholarshipStatus({ isAppointed: true }) === 'назначена');

  section('Диффы снимков');
  const prev = baseSnapshot({
    gradesHash: { 'Математический анализ_КТ1': 25, 'Математический анализ_КТ2': null },
    lastSeenMailUid: 100,
    ordersCount: 5,
    scholarshipStatus: 'нет',
  });

  const baseline = diffSnapshots(undefined, baseSnapshot({ gradesHash: { A_КТ1: 1 } }));
  check('первый запуск (baseline) -> без уведомлений', baseline.length === 0);

  const noChanges = diffSnapshots(prev, { ...prev });
  check('без изменений -> пусто', noChanges.length === 0);

  const gradeEvent = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { 'Математический анализ_КТ1': 30, 'Математический анализ_КТ2': null },
      lastSeenMailUid: 100,
      ordersCount: 5,
      scholarshipStatus: 'нет',
    }),
  );
  check('изменение балла -> событие grade', gradeEvent.length === 1 && gradeEvent[0].kind === 'grade');
  check('в событии указан дельтa', gradeEvent[0]?.lines[0]?.includes('+5') === true);

  const mailEvent = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { ...prev.gradesHash },
      lastSeenMailUid: 150,
      ordersCount: 5,
      scholarshipStatus: 'нет',
    }),
  );
  check('новый mail UID -> событие mail', mailEvent.length === 1 && mailEvent[0].kind === 'mail');

  const orderEvent = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { ...prev.gradesHash },
      lastSeenMailUid: 100,
      ordersCount: 7,
      scholarshipStatus: 'нет',
    }),
  );
  check('рост числа приказов -> событие order', orderEvent.length === 1 && orderEvent[0].kind === 'order');
  check('в событии указано число новых', orderEvent[0]?.lines[0]?.includes('2') === true);

  const scholEvent = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { ...prev.gradesHash },
      lastSeenMailUid: 100,
      ordersCount: 5,
      scholarshipStatus: 'академическая, 01.09.2026 — 31.12.2026',
    }),
  );
  check('смена стипендии -> событие scholarship', scholEvent.length === 1 && scholEvent[0].kind === 'scholarship');

  const multi = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { 'Математический анализ_КТ1': 30 },
      lastSeenMailUid: 150,
      ordersCount: 6,
      scholarshipStatus: 'академическая',
    }),
  );
  check('несколько изменений -> несколько событий', multi.length === 4, `получено ${multi.length}`);

  const unclosed = diffSnapshots(
    prev,
    baseSnapshot({
      gradesHash: { 'Математический анализ_КТ1': 25, 'Математический анализ_КТ2': null },
      lastSeenMailUid: 100,
      ordersCount: 5,
      scholarshipStatus: 'нет',
    }),
  );
  check('null -> null не даёт события', unclosed.length === 0);

  section('Рендер уведомления');
  const text = renderNotification(multi);
  check('рендер содержит заголовок', text.includes('📊'));
  check('рендер не пустой', text.trim().length > 0);

  section('Классификация сетевых ошибок');
  check('ETIMEDOUT -> сетевая', isTransientNetworkError(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
  check('ECONNRESET -> сетевая', isTransientNetworkError(new Error('ECONNRESET')));
  check('HTTP 503 -> сетевая', isTransientNetworkError(new Error('HTTP error 503: Service Unavailable')));
  check('HTTP 429 -> сетевая', isTransientNetworkError(new Error('HTTP error 429: Too Many Requests')));
  check('socket hang up -> сетевая', isTransientNetworkError(new Error('socket hang up')));
  check('Ошибка логики -> не сетевая', !isTransientNetworkError(new Error('Группа не найдена')));

  section('Хранилище снимков');
  const encLogin = encrypt('st123456');
  const encPass = encrypt('pass');
  userStore.ensureUser(TEST_ID, { firstName: 'Тест' });
  userStore.patch(TEST_ID, {
    barsAuth: {
      encryptedLogin: encLogin.encryptedData,
      encryptedPass: encPass.encryptedData,
      iv: encLogin.iv,
      tag: encLogin.tag,
      cookiesJson: '{}',
    },
    studentProfile: { fullName: 'Тестов Тест Тестович' },
    groupName: 'ИЭ-11-26',
    groupId: 21985,
  });
  check('пользователь авторизован в тесте', Boolean(userStore.get(TEST_ID)?.barsAuth));

  snapshotStore.save(TEST_ID, baseSnapshot({ gradesHash: { A_КТ1: 1 } }));
  check('снимок сохранён', snapshotStore.get(TEST_ID)?.gradesHash['A_КТ1'] === 1);
  check('checked() включает пользователя', snapshotStore.checked().has(TEST_ID));
  snapshotStore.remove(TEST_ID);
  check('снимок удалён', snapshotStore.get(TEST_ID) === undefined);

  userStore.remove(TEST_ID);
  check('пользователь удалён', userStore.get(TEST_ID) === undefined);

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Тесты нотификатора упали:', err);
  process.exit(1);
});