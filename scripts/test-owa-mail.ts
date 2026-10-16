/**
 * CLI-проверка почты ОСЭП через OWA-скрапинг (mail.mpei.ru/owa).
 *
 * Запуск:
 *   OWA_USER=st123456 OWA_PASS=... npx tsx scripts/test-owa-mail.ts
 *   (или OSEP_USER/OSEP_PASS; без переменных спросит интерактивно)
 *
 * Печатает число писем и непрочитанных, затем — превью непрочитанных.
 * Для диагностики контракта OWA включите `OWA_DEBUG=1` — в лог пойдут запросы
 * и ответы (пароль и cookie редактируются).
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { OwaMailClient } from '../src/services/mail/owaMailClient.ts';
import {
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
} from '../src/services/mail/mailErrors.ts';

function formatDate(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reportError(err: unknown): void {
  if (err instanceof MailUnreachableError) {
    console.error('❌ Почта недоступна (403/TMG). Возможно, нужен VPN МЭИ.');
  } else if (err instanceof MailAuthError) {
    console.error('❌ Не удалось войти в почту. Проверьте логин/пароль БАРС.');
  } else if (err instanceof MailTimeoutError) {
    console.error('❌ Почта не ответила вовремя.');
  } else {
    console.error(`❌ Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
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

    const client = new OwaMailClient({ user, pass });

    const status = await client.getInboxStatus();
    console.log(`📬 ${user}@mpei.ru`);
    console.log(`Всего писем: ${status.total} | Непрочитанных: ${status.unread}\n`);

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
  process.exit(1);
});
