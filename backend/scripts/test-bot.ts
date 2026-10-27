/**
 * Тесты бота: права админов, FSM с TTL, отчёты, решение о привязке, рассылка.
 *
 * Сеть не используется. Всё, что зависит от диска/времени, либо уводится в
 * временный каталог, либо принимает параметры (каталог отчётов, `now`, send/sleep
 * для рассылки) — иначе такие проверки были бы нестабильными.
 *
 * Запуск: npm run test:bot
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Хранилища берут каталог из process.cwd() при загрузке модуля.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-bot-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
process.chdir(WORK_DIR);

process.env.ADMIN_TELEGRAM_IDS = '111000111, 222000222 ,мусор';

const { addAdmin, isAdmin, isEnvAdmin, listAssignedAdmins, removeAdmin } = await import(
  '../../db/storage/adminsStore.ts'
);
const {
  BOT_FLOW_TTL_MS,
  clearFlow,
  getFlow,
  resetFlows,
  setFlow,
  setFlowData,
} = await import('../../tg/botState.ts');
const { findReport, listReports, pageOfReports } = await import('../../tg/reports.ts');
const { buildStatsUrl } = await import('../../tg/adminView.ts');
const { decideLink } = await import('../../tg/botEngine.ts');
const { broadcastText, recipientIds, validateBroadcastText } = await import('../../tg/broadcast.ts');
const { buildReportsView, buildBroadcastPreviewView } = await import('../../tg/adminView.ts');
const { processTelegramCallback, processTelegramMessage } = await import('../../tg/botEngine.ts');
const { isValidKeyFormat, validateSecrets } = await import('../utils/secretsCheck.ts');
import type { StoredUser } from '../../db/storage/userStore.ts';

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

function stubUser(over: Partial<StoredUser> = {}): StoredUser {
  return {
    userId: over.userId ?? '00000000-0000-4000-8000-000000000000',
    barsLoginHash: 'hash',
    firstName: 'Тест',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

console.log('====================================================');
console.log('   ТЕСТЫ БОТА: ПРАВА, FSM, ОТЧЁТЫ, РАССЫЛКА');
console.log('====================================================');

section('Права админов: env + назначенные');
{
  check('env-админ распознан', isAdmin(111000111));
  check('второй env-админ распознан', isAdmin(222000222));
  check('мусор в env не стал админом', !isAdmin(Number.NaN) && !isEnvAdmin(Number.NaN));
  check('случайный id не админ', !isAdmin(333000333));

  check('назначение нового админа', addAdmin(333000333, 111000111));
  check('назначенный стал админом', isAdmin(333000333));
  check('повторное назначение — false', !addAdmin(333000333, 111000111));
  check('список назначенных содержит его', listAssignedAdmins().some((a) => a.telegramId === 333000333));

  check('env-админа снять нельзя', !removeAdmin(111000111));
  check('env-админ остался', isAdmin(111000111));
  check('назначенного снять можно', removeAdmin(333000333));
  check('снятый больше не админ', !isAdmin(333000333));
  check('повторное снятие — false', !removeAdmin(333000333));
}

section('FSM: состояния с TTL');
{
  resetFlows();
  setFlow(111000111, 'broadcast_text');
  const flow = getFlow(111000111);
  check('состояние записано', flow?.kind === 'broadcast_text');

  setFlowData(111000111, 'текст рассылки');
  check('данные обновлены', getFlow(111000111)?.data === 'текст рассылки');

  const fresh = getFlow(111000111, Date.now() + BOT_FLOW_TTL_MS - 1000);
  check('в пределах TTL живо', fresh?.kind === 'broadcast_text');

  const expired = getFlow(111000111, Date.now() + BOT_FLOW_TTL_MS + 1000);
  check('после TTL протухло', expired === null);
  check('протухшее удалено', getFlow(111000111) === null);

  setFlow(222000222, 'admin_add_id', '42');
  clearFlow(222000222);
  check('clearFlow снимает состояние', getFlow(222000222) === null);
  resetFlows();
}

section('Отчёты: поиск и пагинация');
{
  const dir = path.join(WORK_DIR, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stats-2026.10.17.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'stats-2026.10.16.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, '2026-10-15.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'stats-не-дата.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

  const reports = listReports(dir);
  check('найдены только HTML-даты', reports.length === 3, String(reports.length));
  check('новые сверху', reports[0]?.key === '2026-10-17', reports[0]?.key);
  check('поддерживается формат YYYY-MM-DD', reports.some((r) => r.key === '2026-10-15'));
  check('подпись даты человеческая', reports[0]?.label === '17.10.2026', reports[0]?.label);
  check('поиск по ключу', findReport(reports, '2026-10-16')?.filename === 'stats-2026.10.16.html');

  const page0 = pageOfReports(reports, 0, 2);
  check('первая страница — 2 отчёта', page0.items.length === 2);
  check('страниц 2', page0.pages === 2);
  const page1 = pageOfReports(reports, 1, 2);
  check('вторая страница не пуста', page1.items.length === 1);
  const clamped = pageOfReports(reports, 99, 2);
  check('страница за границей зажимается', clamped.page === 1);

  const view = buildReportsView(reports, 0);
  check('кнопки-даты ведут на rep:', view.keyboard.flat().some((b) => b.callback_data === 'rep:2026-10-17'));

  const emptyView = buildReportsView([], 0);
  check('пустой список — понятный текст', emptyView.text.includes('Отчётов пока нет'));
}

section('Решение о привязке');
{
  const target = stubUser({ userId: 'aaaaaaaa-0000-4000-8000-000000000001' });

  check('нет записи → not_found', decideLink(1, undefined, undefined) === 'not_found');
  check('свободная запись → link', decideLink(1, target, undefined) === 'link');

  const sameUser = stubUser({
    userId: target.userId,
    telegramId: 1,
  });
  check('идемпотентно → link', decideLink(1, sameUser, sameUser) === 'link');

  const other = stubUser({ userId: 'bbbbbbbb-0000-4000-8000-000000000002', telegramId: 2 });
  check('TG уже привязан к другой → отказ', decideLink(3, other, stubUser({ userId: 'cccccccc-0000-4000-8000-000000000003', telegramId: 3 })) === 'tg_linked_elsewhere');
  check('аккаунт занят другим TG → отказ', decideLink(4, other, undefined) === 'target_linked_elsewhere');
}

section('Рассылка: проверка текста и подсчёт');
{
  check('пустой текст отклоняется', validateBroadcastText('   ') !== null);
  check('длинный текст отклоняется', validateBroadcastText('a'.repeat(4097)) !== null);
  check('нормальный текст проходит', validateBroadcastText('Привет, группа!') === null);

  const users = [
    { telegramId: 10 },
    { telegramId: 10 },
    { telegramId: 20 },
    { telegramId: null },
    {},
  ];
  const ids = recipientIds(users);
  check('дубли и пустые убраны', ids.length === 2 && ids.includes(10) && ids.includes(20));

  const delays: number[] = [];
  const result = await broadcastText(
    'Объявление',
    users,
    async (id) => {
      if (id === 20) throw new Error('403 blocked');
    },
    {
      delayMs: 10,
      jitterMs: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
    },
  );

  check('отправлено 1, ошибок 1', result.sent === 1 && result.failed === 1, JSON.stringify(result));
  check('пропущено без telegramId — 2', result.skipped === 2, String(result.skipped));
  check('пауза была между получателями', delays.length === 1 && delays[0]! >= 10, JSON.stringify(delays));
}

section('Секреты: формат ключей и стартовая проверка');
{
  check('64 hex — валидный ключ', isValidKeyFormat('a'.repeat(64)));
  check('ровно 32 символа — валиден', isValidKeyFormat('x'.repeat(32)));
  check('31 символ — невалиден', !isValidKeyFormat('x'.repeat(31)));
  check('случайная длинная строка — невалидна', !isValidKeyFormat('x'.repeat(40)));

  const bad = validateSecrets({
    ENCRYPTION_SECRET_KEY: 'короткий',
    PWA_AUTH_SECRET: 'a'.repeat(64),
    TELEGRAM_BOT_TOKEN: '123:abcdefghijklmnopqrstuvwx',
  });
  check('битый ENCRYPTION — ошибка', bad.errors.some((e) => e.includes('ENCRYPTION_SECRET_KEY')));

  const good = validateSecrets({
    ENCRYPTION_SECRET_KEY: 'a'.repeat(64),
    PWA_AUTH_SECRET: 'b'.repeat(64),
    TELEGRAM_BOT_TOKEN: '123:abcdefghijklmnopqrstuvwx',
  });
  check('корректные секреты без ошибок', good.errors.length === 0, JSON.stringify(good.errors));

  const empty = validateSecrets({});
  check('пустое окружение — предупреждения, не ошибки', empty.errors.length === 0 && empty.warnings.length >= 2);
}

section('FSM изолирован по telegramId');
{
  resetFlows();
  setFlow(111000111, 'broadcast_text', 'черновик админа A');
  check('чужой telegramId не видит состояние', getFlow(222000222) === null);
  check('свой видит', getFlow(111000111)?.data === 'черновик админа A');
  resetFlows();
}

section('Админ-действия недоступны не-админам');
{
  resetFlows();
  const denied = await processTelegramCallback({ id: 909090909, firstName: 'Чужой' }, 'admin');
  check('не-админ не получает админ-меню', !denied.view.text.includes('Администратор'));
  check('не-админу — отказ', denied.toast === 'Недостаточно прав');

  const deniedStats = await processTelegramCallback({ id: 909090909, firstName: 'Чужой' }, 'admin_stats');
  check('не-админ не получает статистику', !deniedStats.view.text.includes('Статистика'));

  const deniedBroadcast = await processTelegramCallback({ id: 909090909, firstName: 'Чужой' }, 'admin_broadcast');
  check('не-админ не запускает рассылку', !deniedBroadcast.view.text.includes('Рассылка'));
}

section('Рассылка: превью экранируется');
{
  const view = buildBroadcastPreviewView('<b>инъекция</b> & <script>alert(1)</script>');
  check('теги не интерпретируются в превью', view.text.includes('&lt;b&gt;') && !view.text.includes('<script>'));
}

section('Ссылка на статистику');
{
  const saved = process.env.PWA_URL;
  process.env.PWA_URL = 'https://example.test';
  const url = buildStatsUrl();
  check(
    'ссылка ведёт в админку PWA',
    url === 'https://example.test/?tab=profile&admin=stats',
    String(url),
  );

  if (saved === undefined) delete process.env.PWA_URL;
  else process.env.PWA_URL = saved;
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
