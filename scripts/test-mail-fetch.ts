/**
 * Проверочный CLI-скрипт для выгрузки сообщений из почты МЭИ.
 * Запуск:
 *   npx tsx scripts/test-mail-fetch.ts         (только непрочитанные)
 *   npx tsx scripts/test-mail-fetch.ts --all   (последние сообщения)
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OsepMailClient } from '../src/services/mail/osepMailClient.js';

async function main(): Promise<void> {
  console.log('=== Выгрузка сообщений из почты МЭИ (mail.mpei.ru) ===\n');

  let user = process.env.OSEP_USER || process.env.MPEI_USER || '';
  let pass = process.env.OSEP_PASS || process.env.MPEI_PASS || '';

  if (!user || !pass) {
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

    try {
      if (!user) user = (await ask('Логин (с @mpei.ru или без): ')).trim();
      if (!pass) pass = (await ask('Пароль: ')).trim();
    } finally {
      rl.close();
    }
  }

  if (!user || !pass) {
    console.error('❌ Ошибка: логин и пароль обязательны для заполнения!');
    process.exit(1);
  }

  const client = new OsepMailClient({ user, pass });
  console.log(`\nПодключение к ящику ${client.email}...`);

  const onlyUnread = !process.argv.includes('--all');
  console.log(`Запрос последних 3 ${onlyUnread ? 'непрочитанных ' : ''}писем (readOnly: true)...`);
  const messages = await client.fetchMessages({ onlyUnread, limit: 3 });

  if (messages.length === 0) {
    console.log(`ℹ️ ${onlyUnread ? 'Непрочитанных писем' : 'Писем'} не найдено.`);
    return;
  }

  console.log(`\n✅ Найдено писем: ${messages.length}\n`);

  messages.forEach((msg, idx) => {
    const dateFormatted = msg.date.toLocaleString('ru-RU');
    console.log(`--------------------------------------------------`);
    console.log(`[${idx + 1}] UID: ${msg.uid} | 📅 ${dateFormatted} | ${msg.isSeen ? '👁️ Прочитано' : '✉️ Не прочитано'}`);
    console.log(`👤 Отправитель: ${msg.from} ${msg.fromAddress ? `<${msg.fromAddress}>` : ''}`);
    console.log(`📩 Тема: ${msg.subject}`);
    if (msg.hasAttachments) {
      console.log(`📎 Вложения (${msg.attachmentNames.length}): ${msg.attachmentNames.join(', ')}`);
    } else {
      console.log(`📎 Вложения: нет`);
    }
    console.log(`💬 Текст: ${msg.snippet || '(пустое сообщение)'}`);
  });
  console.log(`--------------------------------------------------\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('❌ Ошибка при выгрузке писем:', message);
  process.exit(1);
});
