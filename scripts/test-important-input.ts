/**
 * Тесты режима ввода «Важного»: нажатие кнопки, отправка текста, отмена,
 * выход по TTL. Покрывает правку Set -> Map с временем ожидания.
 *
 * Сеть не используется: тексты собираются чисто, хранилище — временный файл.
 *
 * Запуск: npx tsx scripts/test-important-input.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Бот работает с data/ относительно cwd; уводим его в отдельный каталог,
// чтобы тест не тронул настоящие данные бота.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-test-imp-'));
process.chdir(sandbox);
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const { processTelegramCallback, processTelegramMessage } = await import('../src/bot/botEngine.ts');
const { encrypt } = await import('../src/utils/crypto.ts');
const { userStore } = await import('../src/storage/userStore.ts');
const { importantStore } = await import('../src/storage/importantStore.ts');

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

const UID = 700_123_456;
const sender = { id: UID, firstName: 'Тест', lastName: 'Иванов', username: 'tester' };

const encLogin = encrypt('st123456');
const encPass = encrypt('pass');

userStore.ensureUser(UID, { firstName: 'Тест' });
userStore.patch(UID, {
  barsAuth: {
    encryptedLogin: encLogin.encryptedData,
    encryptedPass: encPass.encryptedData,
    iv: encLogin.iv,
    tag: encLogin.tag,
    ivPass: encPass.iv,
    tagPass: encPass.tag,
    cookiesJson: '{}',
  },
  studentProfile: { fullName: 'Тестов Тест Тестович' },
  groupName: 'ИЭ-11-26',
  groupId: 21985,
});

async function run(): Promise<void> {
  console.log('====================================================');
  console.log('ТЕСТЫ ВВОДА «ВАЖНОГО»');
  console.log('====================================================');

  section('Обычный сценарий: кнопка -> текст');
  const addView = await processTelegramCallback(sender, 'imp_add');
  check('кнопка «Добавить» просит ввести текст', addView.messageText.includes('введите') || addView.messageText.includes('Отправьте'));

  const saved = await processTelegramMessage(sender, 'Завтра консультация в 15:00');
  check('текст сохранён как важное', saved.newImportantCreated !== undefined);
  check('заголовок обрезан по длине', (saved.newImportantCreated?.title.length ?? 0) <= 38);
  check(
    'текст сохранён целиком',
    importantStore.all().some((m) => m.text === 'Завтра консультация в 15:00'),
  );

  section('Режим ввода снимается после текста');
  // Кнопка -> текст уже сохранён выше. Второе сообщение приходит без кнопки,
  // поэтому сохраняться уже не должно.
  const afterSave = await processTelegramMessage(sender, 'Ещё одно объявление');
  check('без нажатия кнопки текст не сохраняется', afterSave.newImportantCreated === undefined);
  check('всего важных сообщений: 1', importantStore.all().length === 1);

  section('Отмена словами снимает режим');
  await processTelegramCallback(sender, 'imp_add');
  const cancel = await processTelegramMessage(sender, 'отмена');
  check('отмена вернула список «Важного»', cancel.messageText.includes('Важное') || cancel.messageText.includes('📌'));
  const afterCancel = await processTelegramMessage(sender, 'Это не должно сохраниться');
  check('после отмены текст не сохраняется', afterCancel.newImportantCreated === undefined);
  check('всего важных сообщений: 1', importantStore.all().length === 1);

  section('Уход в другой раздел снимает режим');
  await processTelegramCallback(sender, 'imp_add');
  await processTelegramCallback(sender, 'nav_more');
  const afterNav = await processTelegramMessage(sender, 'Не должно сохраниться после перехода');
  check('после перехода текст не сохраняется', afterNav.newImportantCreated === undefined);
  check('всего важных сообщений: 1', importantStore.all().length === 1);

  section('Пустое сообщение не снимает режим ввода');
  await processTelegramCallback(sender, 'imp_add');
  await processTelegramMessage(sender, '');
  const afterEmpty = await processTelegramMessage(sender, 'Сообщение после пустого');
  check('режим ввода пережил пустое сообщение', afterEmpty.newImportantCreated !== undefined);
  check('всего важных сообщений: 2', importantStore.all().length === 2);

  section('TTL: брошенный ввод снимается через 30 минут');
  const realNow = Date.now;

  await processTelegramCallback(sender, 'imp_add');
  Date.now = () => realNow() + 10 * 60 * 1000;
  const alive = await processTelegramMessage(sender, 'Ввод десять минут назад');
  Date.now = realNow;
  check('через 10 минут режим ввода ещё действует', alive.newImportantCreated !== undefined);

  await processTelegramCallback(sender, 'imp_add');
  Date.now = () => realNow() + 31 * 60 * 1000;
  const expired = await processTelegramMessage(sender, 'Ввод полчаса назад');
  Date.now = realNow;
  check('через 31 минуту режим ввода истёк', expired.newImportantCreated === undefined);

  console.log('\n====================================================');
  console.log(`ИТОГО: ✅ ${passed} / ❌ ${failed}`);
  console.log('====================================================');

  fs.rmSync(sandbox, { recursive: true, force: true });

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  console.error('💥 Тесты «Важного» упали:', err);
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
});