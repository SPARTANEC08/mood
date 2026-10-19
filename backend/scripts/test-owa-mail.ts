/**
 * CLI-проверка почты ОСЭП через OWA-скрапинг (mail.mpei.ru/owa).
 *
 * Запуск:
 *   OWA_USER=st123456 OWA_PASS=... npx tsx backend/scripts/test-owa-mail.ts
 *   (или OSEP_USER/OSEP_PASS; без переменных спросит интерактивно)
 *
 * `--verbose` включает `OWA_DEBUG=1`, печатает каждый шаг входа/GetFolder с
 * маскированным логином и в конце — однозначный итог: успех или подтип отказа.
 * Один прогон, один вход, один GetFolder — ровно то, что нужно для разбора
 * живой ошибки без чтения кода.
 *
 * Работает из сети МЭИ/VPN: снаружи mail.mpei.ru отдаёт страницу Forefront TMG.
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { OwaMailClient } from '../services/mail/owaMailClient.ts';
import {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
} from '../services/mail/mailErrors.ts';

/** Логин в выводе: первые два символа, остальное — звёздочки. */
function maskLogin(login: string): string {
  const trimmed = login.trim();
  return trimmed.length <= 2 ? '***' : `${trimmed.slice(0, 2)}***`;
}

function formatDate(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reportError(err: unknown): void {
  if (err instanceof MailUnreachableError) {
    console.error('❌ Почта недоступна (403/TMG). Возможно, нужен VPN МЭИ.');
  } else if (err instanceof MailAuthError) {
    console.error(`❌ Не удалось войти в почту. Подтип: ${err.reason}`);
    console.error(`   ${MAIL_AUTH_MESSAGES[err.reason]}`);
  } else if (err instanceof MailTimeoutError) {
    console.error('❌ Почта не ответила вовремя.');
  } else {
    console.error(`❌ Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose');
  if (verbose) process.env.OWA_DEBUG = '1';

  let user = (process.env.OWA_USER ?? process.env.OSEP_USER ?? '').trim();
  let pass = (process.env.OWA_PASS ?? process.env.OSEP_PASS ?? '').trim();

  const rl = readline.createInterface({ input, output });
  const ask = async (q: string): Promise<string> => {
    if (process.stdin.isTTY) return (await rl.question(q)).trim();
    process.stdout.write(q);
    const it = rl[Symbol.asyncIterator]();
    const res = await it.next();
    return (res.value ?? '').trim();
  };

  try {
    if (!user || !pass) {
      console.log('=== Проверка почты ОСЭП через OWA (mail.mpei.ru/owa) ===\n');
      if (!user) user = await ask('Логин ОСЭП: ');
      if (!pass) pass = await ask('Пароль ОСЭП: ');
    }

    if (!user || !pass) {
      console.error('❌ Логин и пароль обязательны.');
      return;
    }

    if (verbose) {
      console.log(`=== OWA verbose: ${maskLogin(user)} ===`);
      console.log('Шаги ниже печатает сам клиент (OWA_DEBUG=1): GET формы, POST, GetFolder.\n');
    }

    const client = new OwaMailClient({ user, pass });

    let status: { total: number; unread: number };
    try {
      status = await client.getInboxStatus();
    } catch (err: unknown) {
      reportError(err);
      if (verbose) {
        console.log('\n=== Итог ===');
        console.log(`Логин: ${maskLogin(user)}`);
        console.log('Вход: ОШИБКА');
      }
      process.exitCode = 1;
      return;
    }

    console.log(`\n📬 ${maskLogin(user)}@mpei.ru`);
    console.log(`Всего писем: ${status.total} | Непрочитанных: ${status.unread}`);

    if (verbose) {
      // В verbose-режиме — ровно один GetFolder, без лишнего FindItem.
      console.log('\n=== Итог ===');
      console.log(`Логин: ${maskLogin(user)}`);
      console.log('Вход и GetFolder: OK');
      return;
    }

    const briefs = await client.fetchMessageBriefs({ limit: 10, onlyUnread: true });
    if (briefs.length === 0) {
      console.log('✅ Непрочитанных писем нет.');
      return;
    }

    console.log(`Непрочитанные (${briefs.length}):`);
    for (const m of briefs) {
      console.log('--------------------------------------------------');
      console.log(`📩 [uid ${m.uid}] ${formatDate(m.date)}`);
      console.log(`От: ${m.from}`);
      console.log(`Тема: ${m.subject}`);
      console.log(`Вложения: ${m.hasAttachments ? 'да' : 'нет'}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  reportError(err);
  process.exitCode = 1;
});
