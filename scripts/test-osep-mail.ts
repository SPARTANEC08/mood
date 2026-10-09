/**
 * Итоговый консольный инструмент для проверки и чтения почты ОСЭП МЭИ (mail.mpei.ru).
 * Запуск: npx tsx scripts/test-osep-mail.ts
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OsepMailClient } from '../src/services/mail/osepMailClient.js';
import type { OsepMessage } from '../src/services/mail/types.js';

/**
 * Форматирует дату сообщения в человекочитаемый вид: ДД.ММ.ГГГГ ЧЧ:ММ
 */
function formatDate(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Отрисовывает карточку сообщения в терминале
 */
function renderMessageCard(msg: OsepMessage): void {
  const fromStr =
    msg.fromAddress && !msg.from.includes(msg.fromAddress)
      ? `${msg.from} <${msg.fromAddress}>`
      : msg.from;

  const attachmentsStr =
    msg.hasAttachments && msg.attachmentNames.length > 0
      ? `[ ${msg.attachmentNames.join(', ')} ]`
      : 'нет';

  console.log('--------------------------------------------------');
  console.log(`📩 [UID: ${msg.uid}] ${formatDate(msg.date)}`);
  console.log(`От: ${fromStr}`);
  console.log(`Тема: ${msg.subject}`);
  console.log(`Текст: ${msg.snippet || '(пустое сообщение)'}`);
  console.log(`Вложения: ${attachmentsStr}`);
  console.log('--------------------------------------------------');
}

/**
 * Определяет, является ли ошибка ошибкой аутентификации
 */
function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as Record<string, unknown>;
  const text = `${anyErr.message ?? ''} ${anyErr.responseText ?? ''} ${anyErr.code ?? ''}`;
  return /AUTHENTICATE|Command failed|Invalid credentials|auth/i.test(text);
}

/**
 * Определяет, является ли ошибка сетевой или недоступностью сервера
 */
function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as Record<string, unknown>;
  const text = `${anyErr.message ?? ''} ${anyErr.code ?? ''}`;
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|socket|timeout|timed out|getaddrinfo/i.test(text);
}

async function main(): Promise<void> {
  let user = process.env.OSEP_USER?.trim() || '';
  let pass = process.env.OSEP_PASS?.trim() || '';

  const rl = readline.createInterface({ input, output });

  async function ask(query: string): Promise<string> {
    if (process.stdin.isTTY) {
      return (await rl.question(query)).trim();
    }
    process.stdout.write(query);
    const it = rl[Symbol.asyncIterator]();
    const res = await it.next();
    return (res.value ?? '').trim();
  }

  try {
    // 1. Проверяем переменные окружения OSEP_USER и OSEP_PASS
    if (!user || !pass) {
      console.log('=== Просмотрщик почты ОСЭП МЭИ (mail.mpei.ru) ===\n');
      if (!user) user = await ask('Логин ОСЭП: ');
      if (!pass) pass = await ask('Пароль ОСЭП: ');
      console.log('');
    }

    if (!user || !pass) {
      console.error('❌ Ошибка: Логин и пароль обязательны для заполнения.');
      return;
    }

    const client = new OsepMailClient({ user, pass });

    // 2. Подключение и получение сводки ящика
    let status;
    try {
      status = await client.getInboxStatus();
    } catch (err: unknown) {
      if (isAuthError(err)) {
        console.error('❌ Ошибка: Неверный логин или пароль ОСЭП');
      } else if (isNetworkError(err)) {
        console.error('❌ Ошибка: Сервер mail.mpei.ru недоступен');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Ошибка: ${msg}`);
      }
      return;
    }

    console.log(`📬 Почтовый ящик ОСЭП: ${client.email}`);
    console.log(`Всего писем: ${status.total} | Непрочитанных: ${status.unseen}\n`);

    // 3. Если есть непрочитанные письма — выгружаем их
    if (status.unseen > 0) {
      console.log(`Загрузка непрочитанных писем (${status.unseen})...\n`);
      const unreadMessages = await client.fetchMessages({
        onlyUnread: true,
        limit: Math.max(status.unseen, 10),
      });

      for (const msg of unreadMessages) {
        renderMessageCard(msg);
      }
      return;
    }

    // 4. Если непрочитанных писем нет
    console.log('✅ Все письма прочитаны.\n');
    const answer = await ask('Показать последние 3 письма? (y/n): ');

    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      console.log('\nЗагрузка последних 3 писем...\n');
      const recentMessages = await client.fetchMessages({
        onlyUnread: false,
        limit: 3,
      });

      if (recentMessages.length === 0) {
        console.log('ℹ️ В папке INBOX нет писем.');
      } else {
        for (const msg of recentMessages) {
          renderMessageCard(msg);
        }
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  if (isAuthError(err)) {
    console.error('❌ Ошибка: Неверный логин или пароль ОСЭП');
  } else if (isNetworkError(err)) {
    console.error('❌ Ошибка: Сервер mail.mpei.ru недоступен');
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Ошибка: ${msg}`);
  }
  process.exit(0);
});
