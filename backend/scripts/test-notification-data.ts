/**
 * Проверки структурированных данных уведомлений.
 *
 * Интерфейс рисует карточки по `data`, а `details` остаются текстовым fallback
 * для старых записей. Здесь проверяем, что дифф кладёт в `data` именно то, что
 * ждёт клиент: дисциплину, номер КМ, балл и дельту, число писем, приказы,
 * стипендию.
 *
 * Запуск: npm run test:notification-data
 */

import type { SemesterGrades } from '../services/bars/parsers/gradesParser.ts';
import type { OrderItem, ScholarshipInfo } from '../services/bars/parsers/studentInfoParser.ts';
import type { UserSnapshot } from '../../db/storage/snapshotStore.ts';
import { diffSnapshots } from '../services/notifications/notifier/diff.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function snapshot(over: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    gradesHash: {},
    lastSeenMailUid: 0,
    ordersCount: 0,
    ordersSeen: [],
    ordersInitialized: false,
    scholarshipStatus: 'нет',
    lastCheckedAt: new Date().toISOString(),
    ...over,
  };
}

function grades(subjects: SemesterGrades['subjects']): SemesterGrades {
  return { semesterName: '2026/2027, Осенний', isCurrent: true, subjects };
}

console.log('====================================================');
console.log('   ТЕСТЫ: СТРУКТУРА УВЕДОМЛЕНИЙ');
console.log('====================================================');

section('Оценки');
{
  const contextGrades = grades([
    {
      discipline: 'Математический анализ',
      controlType: 'Экзамен',
      controlPoints: [
        { number: 1, title: 'Пределы', weight: 25, score: 5 },
        { number: 2, title: 'Интегралы', weight: 25, score: null },
      ],
      weekScores: [],
      totalScore: null,
    },
  ]);

  const events = diffSnapshots(
    snapshot({ gradesHash: { 'Математический анализ_КТ1': 3 } }),
    snapshot({ gradesHash: { 'Математический анализ_КТ1': 5 } }),
    { grades: contextGrades },
  );
  const event = events.find((candidate) => candidate.kind === 'grade');
  const data = event?.data;

  check('событие оценки есть', Boolean(event));
  check('тип структуры — grade', data?.type === 'grade', JSON.stringify(data));
  if (data?.type === 'grade') {
    const item = data.items[0];
    check('дисциплина в структуре', item?.discipline === 'Математический анализ');
    check('номер КМ числом', item?.point === 1);
    check('название КМ из БАРС', item?.title === 'Пределы');
    check('вес КМ из БАРС', item?.weight === 25);
    check('балл в структуре', item?.score === 5);
    check('дельта посчитана', item?.delta === 2, String(item?.delta));
  }
}

section('Почта');
{
  const events = diffSnapshots(
    snapshot({ lastSeenMailUid: 100 }),
    snapshot({ lastSeenMailUid: 109 }),
    { newMailCount: 9 },
  );
  const data = events.find((event) => event.kind === 'mail')?.data;

  check('тип структуры — mail', data?.type === 'mail', JSON.stringify(data));
  check(
    'количество писем в структуре',
    data?.type === 'mail' && data.count === 9,
    JSON.stringify(data),
  );
}

section('Приказы');
{
  const order: OrderItem = {
    number: '123-С',
    date: '01.10.2026',
    title: 'О назначении стипендии',
  };

  const events = diffSnapshots(
    snapshot({ ordersInitialized: true, ordersSeen: ['n:1|01.09.2026'] }),
    snapshot({
      ordersInitialized: true,
      ordersSeen: ['n:1|01.09.2026', 'n:123-С|01.10.2026'],
    }),
    { orders: [order] },
  );
  const data = events.find((event) => event.kind === 'order')?.data;

  check('тип структуры — order', data?.type === 'order', JSON.stringify(data));
  if (data?.type === 'order') {
    check('приказ попал в структуру', data.items.length === 1);
    check('номер приказа', data.items[0]?.number === '123-С');
    check('дата приказа', data.items[0]?.date === '01.10.2026');
    check('название приказа', data.items[0]?.title === 'О назначении стипендии');
  }
}

section('Стипендия');
{
  const scholarship: ScholarshipInfo = {
    isAppointed: true,
    type: 'Академическая',
    period: '2026/2027',
    amount: '3 000 ₽',
  };

  const events = diffSnapshots(
    snapshot({ scholarshipStatus: 'нет' }),
    snapshot({ scholarshipStatus: 'Академическая, 2026/2027' }),
    { scholarship },
  );
  const data = events.find((event) => event.kind === 'scholarship')?.data;

  check('тип структуры — scholarship', data?.type === 'scholarship', JSON.stringify(data));
  if (data?.type === 'scholarship') {
    check('факт назначения', data.appointed === true);
    check('тип стипендии', data.scholarshipType === 'Академическая');
    check('период', data.period === '2026/2027');
    check('сумма', data.amount === '3 000 ₽');
  }
}

section('Обратная совместимость');
{
  const events = diffSnapshots(
    snapshot({ lastSeenMailUid: 1 }),
    snapshot({ lastSeenMailUid: 2 }),
    { newMailCount: 2 },
  );
  const event = events.find((candidate) => candidate.kind === 'mail');

  check('текстовые details остались', (event?.details.length ?? 0) > 0);
  check('data не обязательна для старых клиентов', event?.data?.type === 'mail');
}

section('Хранилище');
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-notif-data-'));
  fs.mkdirSync(path.join(workDir, 'db', 'data'), { recursive: true, mode: 0o700 });
  const previous = process.cwd();
  process.chdir(workDir);

  try {
    const { userEventStore } = await import('../../db/storage/userEventStore.ts');

    userEventStore.add({
      userId: 'test-user',
      key: 'grade:test',
      kind: 'grade',
      label: 'Новые оценки',
      details: ['Математический анализ · КМ1: 5 (+2)'],
      data: {
        type: 'grade',
        items: [
          {
            discipline: 'Математический анализ',
            point: 1,
            title: 'Пределы',
            weight: 25,
            score: 5,
            delta: 2,
          },
        ],
      },
      createdAt: new Date().toISOString(),
    });

    const stored = userEventStore.nextFor('test-user');
    check('событие сохранилось', stored !== null);
    check(
      'структура пережила JSON-сериализацию',
      stored?.data?.type === 'grade' && stored.data.items[0]?.point === 1,
      JSON.stringify(stored?.data),
    );
    check(
      'текстовые details тоже на месте',
      stored?.details[0]?.includes('КМ1') === true,
      JSON.stringify(stored?.details),
    );

    userEventStore.clearForUser('test-user');
  } finally {
    process.chdir(previous);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exit(1);
