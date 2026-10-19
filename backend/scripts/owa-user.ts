/**
 * Живая проверка OWA по СОХРАНЁННЫМ кредам пользователя (userId).
 *
 * В отличие от `test-owa-mail.ts`, пароль не спрашивают: он расшифровывается из
 * записи `barsAuth` (креды OWA = креды БАРС). Скрипт не пишет в базу — ни
 * cookies, ни снимки, — поэтому безопасен как диагностика на боевом сервере:
 * уведомления и превью почты он не сдвигает.
 *
 * Запуск (на сервере, из сети МЭИ/VPN):
 *   OWA_DEBUG=1 npx tsx backend/scripts/owa-user.ts --user <userId>
 *
 * Печатает вход, число писем и последние письма; при отказе — подтип.
 */

import 'dotenv/config';

import { readOwaCredentials } from '../services/bars/barsServiceFactory.ts';
import {
  MAIL_AUTH_MESSAGES,
  MailAuthError,
  MailTimeoutError,
  MailUnreachableError,
} from '../services/mail/mailErrors.ts';
import { OwaMailClient } from '../services/mail/owaMailClient.ts';
import { userStore } from '../../db/storage/userStore.ts';

function maskLogin(login: string): string {
  const trimmed = login.trim();
  return trimmed.length <= 2 ? '***' : `${trimmed.slice(0, 2)}***`;
}

function argValue(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const userId = argValue('--user');
  if (!userId) {
    console.error('Использование: OWA_DEBUG=1 npx tsx backend/scripts/owa-user.ts --user <userId>');
    process.exit(1);
  }

  const user = userStore.getByUserId(userId);
  if (!user) {
    console.error(`❌ Пользователь ${userId} не найден.`);
    process.exit(1);
  }
  if (!user.barsAuth) {
    console.error('❌ У пользователя нет сохранённых кредов БАРС.');
    process.exit(1);
  }

  const { login, password } = readOwaCredentials(user);
  console.log(`Проверка OWA для ${maskLogin(login)} (${user.studentProfile?.fullName ?? 'без имени'})`);
  console.log(`Сохранённая сессия OWA: ${user.owaAuth ? 'есть' : 'нет'}`);

  const client = new OwaMailClient(
    { user: login, pass: password },
    { cookiesJson: user.owaAuth?.cookiesJson },
  );

  try {
    const status = await client.getInboxStatus();
    console.log(`\n✅ GetFolder: всего ${status.total}, непрочитанных ${status.unread}`);

    const briefs = await client.fetchMessageBriefs({ limit: 5, onlyUnread: false });
    console.log(`FindItem: последних писем ${briefs.length}`);
    for (const m of briefs) {
      console.log(`  ${m.isSeen ? ' ' : '•'} ${m.date.toISOString()} | ${m.from} | ${m.subject}`);
    }
  } catch (err: unknown) {
    if (err instanceof MailAuthError) {
      console.error(`\n❌ Отказ входа OWA. Подтип: ${err.reason}`);
      console.error(`   ${MAIL_AUTH_MESSAGES[err.reason]}`);
    } else if (err instanceof MailUnreachableError) {
      console.error(`\n❌ Почта недоступна: ${err.message}`);
    } else if (err instanceof MailTimeoutError) {
      console.error(`\n❌ Таймаут OWA: ${err.message}`);
    } else {
      console.error(`\n❌ Ошибка: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    process.exitCode = 1;
  }
}

void main();
