/**
 * Ручной прогон фонового мониторинга для одного пользователя.
 * Позволяет проверить работу нотификатора без ожидания 20-минутного цикла.
 *
 * Запуск:
 *   npx tsx scripts/test-notifier-live.ts            — список кандидатов
 *   npx tsx scripts/test-notifier-live.ts <telegramId>
 */

import 'dotenv/config';

import { checkUserNow, isWithinActiveWindow } from '../src/services/notifications/barsNotifier.js';
import { isBarsAuthorized, userStore } from '../src/storage/userStore.js';
import { snapshotStore } from '../src/storage/snapshotStore.js';

function authorizedUsers(): number[] {
  return userStore.all().filter(isBarsAuthorized).map((u) => u.telegramId);
}

async function run(): Promise<void> {
  const rawId = process.argv[2];
  const ids = rawId ? [Number(rawId)] : authorizedUsers();

  if (ids.length === 0) {
    console.log('❌ Нет авторизованных в БАРС пользователей.');
    console.log('   Проверка входа: npm run test:auth');
    return;
  }

  console.log('====================================================');
  console.log('   РУЧНОЙ ПРОГОН НОТИФИКАТОРА   ');
  console.log('====================================================');
  console.log(`Активное окно 08:00–23:00 МСК сейчас: ${isWithinActiveWindow() ? 'открыто' : 'закрыто'}`);
  console.log(`Пользователей к проверке: ${ids.length}\n`);

  for (const id of ids) {
    const user = userStore.get(id);
    if (!user) {
      console.log(`⚠️  ${id}: записи в users.json нет.`);
      continue;
    }

    const snapshot = snapshotStore.get(id);
    console.log('------------------------------------------------------');
    console.log(`👤 ${user.studentProfile?.fullName ?? user.firstName} (${id})`);
    console.log(`   Группа: ${user.groupName ?? '—'}`);
    console.log(
      `   Снимок: ${snapshot ? `есть, от ${snapshot.lastCheckedAt}` : 'отсутствует (baseline)'}`,
    );

    const started = Date.now();
    try {
      const events = await checkUserNow(id);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      console.log(`   Проверено за ${seconds} с.`);

      if (!snapshot) {
        console.log('   📌 Первый запуск: снимок сохранён как baseline, уведомлений не будет.');
      } else if (events.length === 0) {
        console.log('   ✅ Изменений нет.');
      } else {
        console.log(`   🆕 События (${events.length}):`);
        for (const e of events) {
          console.log(`      ${e.title}`);
          for (const line of e.lines) console.log(`        ${line}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ Ошибка: ${msg}`);

      if (/сессия/i.test(msg)) {
        console.log('   💡 Сессия БАРС истекла — пользователю нужно войти заново.');
      }
    }
  }

  console.log('\n====================================================');
}

run().catch((err: unknown) => {
  console.error('💥 Ручной прогон не удался:', err);
  process.exit(1);
});