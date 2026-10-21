/**
 * Тесты краевых случаев нотификатора.
 *
 * Самое важное здесь — `snapshotAfterDelivery`: именно на нём терялись
 * уведомления (снимок сдвигался, даже если отправка упала). Плюс проверки
 * диффа (лимит писем, «+N за неделю») и границ активного окна.
 *
 * Запуск: npm run test:notifier-edges
 */

import type { SemesterGrades } from '../services/bars/parsers/gradesParser.ts';
import type { UserSnapshot } from '../../db/storage/snapshotStore.ts';
import { diffSnapshots, renderNotification } from '../services/notifications/notifier/diff.ts';
import {
  isNotifierCycleRunning,
  isWithinActiveWindow,
  snapshotAfterDelivery,
} from '../services/notifications/notifier/run.ts';

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
    scholarshipStatus: 'нет',
    lastCheckedAt: new Date().toISOString(),
    ...over,
  };
}

function grades(subjects: SemesterGrades['subjects']): SemesterGrades {
  return { semesterName: '2026/2027, Осенний', isCurrent: true, subjects };
}

console.log('====================================================');
console.log('   ТЕСТЫ НОТИФИКАТОРА: КРАЕВЫЕ СЛУЧАИ');
console.log('====================================================');

section('Снимок после доставки (защита от потери уведомлений)');
{
  const prev = snapshot({ lastSeenMailUid: 100 });
  const next = snapshot({ lastSeenMailUid: 200 });

  const delivered = snapshotAfterDelivery(prev, next, true, true);
  check('отправлено → снимок сдвигается', delivered.lastSeenMailUid === 200, String(delivered.lastSeenMailUid));

  const failedSend = snapshotAfterDelivery(prev, next, true, false);
  check('отправка упала → прежний снимок (повтор)', failedSend.lastSeenMailUid === 100, String(failedSend.lastSeenMailUid));

  const nothingToSend = snapshotAfterDelivery(prev, next, false, false);
  check('отправлять было нечего → снимок двигается', nothingToSend.lastSeenMailUid === 200, String(nothingToSend.lastSeenMailUid));

  const noPrev = snapshotAfterDelivery(undefined, next, true, false);
  check('нет прежнего снимка → берём новый (базовая линия)', noPrev.lastSeenMailUid === 200);
}

section('Дифф: лимит писем и «+N за неделю»');
{
  const mailIds = Array.from({ length: 9 }, (_, index) => ({
    uid: 101 + index,
    date: new Date(),
  }));

  const mailEvents = diffSnapshots(
    snapshot({ lastSeenMailUid: 100 }),
    snapshot({ lastSeenMailUid: 109 }),
    { mailIds },
  );
  const mailEvent = mailEvents.find((event) => event.kind === 'mail');
  check('событие почты есть', Boolean(mailEvent));
  check(
    'в заголовке девять новых писем',
    mailEvent?.title.includes('9 новых писем') === true,
    String(mailEvent?.title),
  );
  check('списка писем в уведомлении нет', (mailEvent?.lines.length ?? -1) === 0);
  check('emoji письма — 📧', mailEvent?.title.includes('📧') === true, String(mailEvent?.title));

  const gradeEvents = diffSnapshots(
    snapshot({ gradesHash: { 'Матан_КТ1': 10, 'Физика_КТ1': 20 } }),
    snapshot({ gradesHash: { 'Матан_КТ1': 25, 'Физика_КТ1': 20 } }),
    {
      grades: grades([
        {
          discipline: 'Матан',
          controlType: 'Экзамен',
          controlPoints: [{ number: 1, score: 25, weight: 100 }],
          weekScores: [],
          totalScore: 25,
        },
      ]),
    },
  );
  const gradeEvent = gradeEvents.find((event) => event.kind === 'grade');
  const gainedLine = gradeEvent?.lines.find((line) => line.includes('За неделю'));
  check('есть прирост за неделю', Boolean(gainedLine), JSON.stringify(gradeEvent?.lines));
  check('прирост = +15 (только рост)', gainedLine?.includes('+15') === true, String(gainedLine));
  check('emoji баллов — 🎓', gradeEvent?.title.includes('🎓') === true, String(gradeEvent?.title));
}

section('Базовая линия и подпись');
{
  const baseline = diffSnapshots(undefined, snapshot({ lastSeenMailUid: 5 }), {});
  check('без прежнего снимка событий нет', baseline.length === 0);

  const text = renderNotification([
    { kind: 'order', title: '📄 Приказы', lines: ['• №1'] },
  ]);
  check('подпись про кнопки', text.includes('кнопками ниже'));
}

section('Границы окна и состояние цикла');
{
  check('08:00 МСК — внутри', isWithinActiveWindow(new Date('2026-10-18T05:00:00Z')));
  check('23:00 МСК — снаружи', !isWithinActiveWindow(new Date('2026-10-18T20:00:00Z')));
  check('цикл по умолчанию не идёт', isNotifierCycleRunning() === false);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
