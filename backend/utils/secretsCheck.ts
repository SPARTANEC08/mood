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

  /*
   * VAPID-ключи. Отсутствие обоих — штатный режим «только Telegram», поэтому
   * предупреждение, а не ошибка. А вот один ключ без второго или мусор вместо
   * base64url — ошибка: push-канал молча не заработает, и искать причину
   * придётся по логам каждой отправки.
   */
  const vapidPublic = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const vapidPrivate = (env.VAPID_PRIVATE_KEY ?? '').trim();
  const vapidSubject = (env.VAPID_SUBJECT ?? '').trim();

  if (!vapidPublic && !vapidPrivate) {
    warnings.push('VAPID-ключи не заданы — push-уведомления в PWA выключены.');
  } else if (!vapidPublic || !vapidPrivate) {
    errors.push('Задан только один VAPID-ключ: нужны и VAPID_PUBLIC_KEY, и VAPID_PRIVATE_KEY.');
  } else {
    if (!/^[A-Za-z0-9_-]{40,120}$/.test(vapidPublic)) {
      errors.push('VAPID_PUBLIC_KEY не похож на base64url-ключ.');
    }
    if (!/^[A-Za-z0-9_-]{40,120}$/.test(vapidPrivate)) {
      errors.push('VAPID_PRIVATE_KEY не похож на base64url-ключ.');
    }
    if (vapidSubject && !/^(mailto:|https:)/.test(vapidSubject)) {
      errors.push('VAPID_SUBJECT должен начинаться с mailto: или https:.');
    }
  }

  return { errors, warnings };
}
