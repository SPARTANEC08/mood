/**
 * Один круг нотификатора немедленно, для конкретного пользователя.
 *
 * Зачем: штатный цикл стартует через 30 секунд, идёт раз в 20 минут и молчит
 * ночью. Для разбора почты/уведомлений на живом аккаунте это неудобно.
 * Скрипт игнорирует активное окно и график частот (`checkUserNow` сбрасывает
 * расписание), печатает найденные события, отправленный текст и ошибки.
 *
 * Запуск:
 *   npm run notifier:once -- --user <userId>
 *
 * Внимание: как и настоящий круг, скрипт сдвигает снимок (`flushSnapshots`),
 * поэтому уже «замеченные» события повторно в Telegram не придут.
 */

import 'dotenv/config';

import { isBarsAuthorized, userStore } from '../../db/storage/userStore.ts';
import {
  checkUserNow,
  flushSnapshots,
  setNotificationSender,
} from '../services/notifications/barsNotifier.ts';

function usage(): never {
  console.error('Использование: npm run notifier:once -- --user <userId>');
  process.exit(1);
}

function parseUserId(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === '--user' || arg === '-u');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('-')) usage();
  return value;
}

async function main(): Promise<void> {
  const userId = parseUserId(process.argv.slice(2));
  const user = userStore.getByUserId(userId);

  if (!user) {
    console.error(`❌ Пользователь ${userId} не найден в users.json.`);
    process.exit(1);
  }
  if (!isBarsAuthorized(user)) {
    console.error('❌ Пользователь не авторизован в БАРС: нет barsAuth/профиля.');
    process.exit(1);
  }

  console.log(`[Notifier:once] пользователь ${userId} (${user.studentProfile?.fullName ?? 'без имени'})`);
  console.log(`[Notifier:once] Telegram: ${typeof user.telegramId === 'number' ? user.telegramId : 'не подключён'}`);

  // Перехватываем доставку, чтобы было видно, что именно ушло бы в Telegram.
  setNotificationSender(async (chatId, text) => {
    console.log(`\n[Notifier:once] → Telegram ${chatId}:`);
    console.log(text);
  });

  try {
    const events = await checkUserNow(userId);
    console.log(`\n[Notifier:once] событий: ${events.length}`);
    if (events.length === 0) {
      console.log('[Notifier:once] новых событий нет.');
    } else {
      console.log(`[Notifier:once] типы: ${events.map((event) => event.kind).join(', ')}`);
    }
  } catch (err: unknown) {
    console.error(
      '[Notifier:once] ошибка круга:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    process.exitCode = 1;
  } finally {
    // Как настоящий круг: снимок и график сбрасываются на диск.
    flushSnapshots();
    setNotificationSender(null);
  }
}

void main();
