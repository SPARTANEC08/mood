/**
 * Тесты краевых случаев бота: уборка сообщений, FSM (персистентность и TTL),
 * пагинация отчётов, классификация ошибок правки.
 *
 * Работает в отдельном каталоге: хранилища берут путь из process.cwd().
 * Запуск: npm run test:bot-edges
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-bot-edges-'));
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(WORK_DIR, 'db', 'data', 'reports'), { recursive: true });
process.chdir(WORK_DIR);
process.env.ADMIN_TELEGRAM_IDS = '111000111';

const { processTelegramCallback, processTelegramMessage } = await import('../../tg/botEngine.ts');
const { getFlow, resetFlows, setFlow, takeExpiredNotice, BOT_FLOW_TTL_MS } = await import('../../tg/botState.ts');
const { botFlowsStore } = await import('../../db/storage/botFlowsStore.ts');
const { classifyEditError } = await import('../../tg/editErrors.ts');
const { listReports, pageOfReports } = await import('../../tg/reports.ts');
const { buildBroadcastResultView } = await import('../../tg/adminView.ts');
const { userStore } = await import('../../db/storage/userStore.ts');

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

const ADMIN = { id: 111000111, firstName: 'Админ' };

console.log('====================================================');
console.log('   ТЕСТЫ БОТА: КРАЕВЫЕ СЛУЧАИ');
console.log('====================================================');

section('Уборка сообщений: «Скрыть» и «Закрыть»');
{
  const dismiss = await processTelegramCallback({ id: 909000111, firstName: 'X' }, 'notif_dismiss');
  check('notif_dismiss удаляет сообщение', dismiss.deleteCurrent === true && dismiss.view.text === '');

  const close = await processTelegramCallback({ id: 909000111, firstName: 'X' }, 'msg_close');
  check('msg_close удаляет сообщение', close.deleteCurrent === true && close.view.text === '');
}

section('«В главное меню» из уведомления');
{
  const user = userStore.create({ barsLoginHash: 'bot-edges-hash' });
  userStore.patchByUserId(user.userId, {
    telegramId: 555000111,
    notificationsEnabled: true,
    studentProfile: { fullName: 'Тест Тестович' },
  });

  const result = await processTelegramCallback({ id: 555000111, firstName: 'Тест' }, 'notif_menu');
  check('уведомление удаляется', result.deleteCurrent === true);
  check('меню отправляется новым сообщением', result.forceNewMessage === true);
  check('показано главное меню', result.view.text.includes('Главное меню'), result.view.text.split('\n')[0]);
}

section('FSM: персистентность на диске');
{
  resetFlows();
  setFlow(111000111, 'broadcast_text', 'черновик объявления');

  const file = path.join(WORK_DIR, 'db', 'data', 'bot_flows.json');
  check('файл состояния создан', fs.existsSync(file));

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { kind?: string; data?: string }>;
  const record = raw['111000111'];
  check('состояние записано с типом', record?.kind === 'broadcast_text', JSON.stringify(record));
  check('черновик сохранён', record?.data === 'черновик объявления', JSON.stringify(record));

  check('чтение возвращает состояние', getFlow(111000111)?.data === 'черновик объявления');
  resetFlows();
}

section('FSM: TTL и «сессия истекла»');
{
  resetFlows();
  // Кладём состояние с протухшим startedAt — так же выглядит рестарт спустя TTL.
  botFlowsStore.set({ telegramId: 111000111, kind: 'broadcast_text', startedAt: Date.now() - BOT_FLOW_TTL_MS - 1000 });

  check('протухшее состояние не отдаётся', getFlow(111000111) === null);
  check('запись протухшего удалена с диска', botFlowsStore.get(111000111) === undefined);

  const message = await processTelegramMessage(ADMIN, 'текст, который админ прислал после паузы');
  check('бот объясняет истечение сессии', message.view.text.includes('Сессия истекла'), message.view.text.split('\n')[0]);
  check('и снова просит ввести текст', message.view.text.includes('Рассылка'));

  const second = await processTelegramMessage(ADMIN, 'ещё текст');
  check('уведомление показывается один раз', !second.view.text.includes('Сессия истекла'), second.view.text.split('\n')[0]);

  resetFlows();
  check('takeExpiredNotice без протухания — null', takeExpiredNotice(111000111) === null);
}

section('Отчёты: пагинация и свежий файл');
{
  const dir = path.join(WORK_DIR, 'db', 'data', 'reports');
  // 12 отчётов, включая «сегодняшний»; имена — как их пишет сервис отчётов.
  for (let day = 1; day <= 12; day += 1) {
    const dd = String(day).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `stats-2026.09.${dd}.html`), '<html></html>');
  }
  fs.writeFileSync(path.join(dir, 'stats-2026.10.18.html'), '<html></html>');

  const reports = listReports(dir);
  check('все отчёты найдены', reports.length === 13, String(reports.length));
  check('свежий отчёт сверху', reports[0]?.key === '2026-10-18', reports[0]?.key);

  const page0 = pageOfReports(reports, 0);
  const page1 = pageOfReports(reports, 1);
  check('первая страница — 10', page0.items.length === 10, String(page0.items.length));
  check('страниц 2', page0.pages === 2, String(page0.pages));
  check('вторая страница — 3', page1.items.length === 3, String(page1.items.length));
  check('свежий на первой странице', page0.items[0]?.key === '2026-10-18');
}

section('Классификация ошибок правки сообщения');
{
  check('not modified', classifyEditError({ description: 'Bad Request: message is not modified: ...' }) === 'not_modified');
  check('документ без текста', classifyEditError({ description: 'Bad Request: there is no text in the message to edit' }) === 'not_editable');
  check('сообщение удалено', classifyEditError({ description: 'Bad Request: message to edit not found' }) === 'not_editable');
  check('прочее', classifyEditError(new Error('network')) === 'other');
}

section('Прогон почты: прогресс и итог');
{
  const progress: string[] = [];
  const result = await processTelegramCallback(ADMIN, 'admin_mail_yes', {
    runMailRefresh: async (onProgress) => {
      await onProgress?.(1, 3);
      await onProgress?.(3, 3);
      return { processed: 3, notified: 1, errors: 0 };
    },
    onMailProgress: (processed, total) => {
      progress.push(`${processed}/${total}`);
    },
  });

  check('прогресс дошёл до движка', progress.join(',') === '1/3,3/3', progress.join(','));
  check('показан итог прогона', result.view.text.includes('Обновление завершено'), result.view.text.split('\n')[0]);
  const plain = result.view.text.replace(/<[^>]*>/g, '');
  check('в итоге счётчики', plain.includes('Проверено: 3'), plain);
}

section('Итог рассылки показывает пропущенных');
{
  const view = buildBroadcastResultView(3, 1, 2);
  check('отправлено/ошибки', view.text.includes('Отправлено') && view.text.includes('Ошибок'), view.text);
  check('пропущено без Telegram', view.text.includes('Пропущено'));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`ИТОГО: ${failed === 0 ? '✅' : '❌'} ${passed} ok, ${failed} ошибок`);
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
