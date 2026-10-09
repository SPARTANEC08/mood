/**
 * Проверочный CLI-скрипт для тестирования авторизации и получения статуса почты МЭИ (mail.mpei.ru).
 * Запуск: npx tsx scripts/test-mail-auth.ts
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OsepMailClient } from '../src/services/mail/osepMailClient.js';

async function main(): Promise<void> {
  console.log('=== Проверка IMAP-подключения к почте МЭИ (mail.mpei.ru) ===\n');

  const rl = readline.createInterface({ input, output });
  const it = rl[Symbol.asyncIterator]();

  async function ask(prompt: string): Promise<string> {
    if (process.stdin.isTTY) {
      return await rl.question(prompt);
    }
    process.stdout.write(prompt);
    const res = await it.next();
    return res.value ?? '';
  }

  let user = '';
  let pass = '';

  try {
    user = (await ask('Логин (с @mpei.ru или без): ')).trim();
    pass = (await ask('Пароль: ')).trim();
  } finally {
    rl.close();
  }

  if (!user || !pass) {
    console.error('❌ Ошибка: логин и пароль обязательны для заполнения!');
    process.exit(1);
  }

  const client = new OsepMailClient({ user, pass });
  console.log(`\n[1/2] Проверка авторизации для ${client.email}...`);

  const authResult = await client.checkAuth();
  if (!authResult.success) {
    console.error(`❌ Ошибка авторизации: ${authResult.error ?? 'Не удалось войти'}`);
    process.exit(1);
  }

  console.log('[2/2] Получение статуса папки INBOX...');
  const status = await client.getInboxStatus();

  console.log(`Авторизация успешна! Всего писем: ${status.total}, непрочитанных: ${status.unseen}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('❌ Непредвиденная ошибка при проверке почты:', message);
  process.exit(1);
});
