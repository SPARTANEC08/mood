/**
 * Проверка формата секретов на старте процесса.
 *
 * Зачем. Ключ неверной длины приводил к ошибке не при запуске, а в момент
 * первой операции шифрования или выдачи токена — то есть бот «успешно» стартовал,
 * а потом молча не мог сохранить креды или пустить пользователя. Дешевле упасть
 * сразу и внятно.
 *
 * Правила по-разному строгие:
 *  - не задан → предупреждение (по README процесс умеет жить без части секретов);
 *  - задан, но неверного формата → ошибка (лучше не стартовать, чем портить данные);
 *  - задан и короткий там, где длина не критична (DEV_STATS_TOKEN) → предупреждение.
 */

/** 64 hex-символа или ровно 32 байта UTF-8 — форматы AES-ключа и PWA-секрета. */
export function isValidKeyFormat(value: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  return Buffer.byteLength(value, 'utf-8') === 32;
}

export interface SecretsCheck {
  errors: string[];
  warnings: string[];
}

export function validateSecrets(env: NodeJS.ProcessEnv = process.env): SecretsCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  const encryption = (env.ENCRYPTION_SECRET_KEY ?? '').trim();
  if (!encryption) {
    warnings.push('ENCRYPTION_SECRET_KEY не задан — креды БАРС не сохранятся.');
  } else if (!isValidKeyFormat(encryption)) {
    errors.push('ENCRYPTION_SECRET_KEY неверной длины: нужно 64 hex-символа или ровно 32 символа.');
  }

  const pwaSecret = (env.PWA_AUTH_SECRET ?? '').trim();
  if (!pwaSecret) {
    warnings.push('PWA_AUTH_SECRET не задан — вход в приложение невозможен.');
  } else if (!isValidKeyFormat(pwaSecret)) {
    errors.push('PWA_AUTH_SECRET неверной длины: нужно 64 hex-символа или ровно 32 символа.');
  }

  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
    warnings.push('TELEGRAM_BOT_TOKEN не задан — бот не запустится (останется только API).');
  } else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    errors.push('TELEGRAM_BOT_TOKEN не похож на токен BotFather.');
  }

  const devToken = (env.DEV_STATS_TOKEN ?? '').trim();
  if (!devToken) {
    warnings.push('DEV_STATS_TOKEN не задан — страница /dev/ недоступна.');
  } else if (devToken.length < 16) {
    warnings.push('DEV_STATS_TOKEN короче 16 символов — слабый секрет.');
  }

  return { errors, warnings };
}
