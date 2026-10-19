/**
 * Подготовка веб-версии (PWA): секрет, зависимости, иконки, сборка.
 *
 * Зачем отдельный скрипт, а не три команды в README. Пока не заданы сразу три
 * вещи, PWA не работает: PWA_AUTH_SECRET в .env, зависимости в pwa/node_modules
 * и иконки в pwa/public/icons. Забыть любую из них — обычное дело, и ошибка
 * проявится позже и не там (например, «PWA не настроена: не задан PWA_AUTH_SECRET»
 * приходит из API в момент нажатия кнопки в боте).
 *
 * Идемпотентен: повторный запуск не дублирует переменные в .env, не пересобирает
 * свежие иконки и не падает на уже существующих файлах.
 *
 * Запуск: npm run pwa:setup
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PWA_DIR = path.join(ROOT, 'pwa');
const ENV_FILE = path.join(ROOT, '.env');

/** Минимальная версия Node: 20 — ради base64url и стабильного ESM. */
const MIN_NODE_MAJOR = 20;

const log = (msg) => console.log(`[pwa:setup] ${msg}`);
const warn = (msg) => console.warn(`[pwa:setup] ВНИМАНИЕ: ${msg}`);

/** Запускает команду, наследуя stdio. Ничего не подавляет: видимый вывод честнее. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} завершилась с кодом ${result.status}`);
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`Требуется Node ${MIN_NODE_MAJOR} или новее, сейчас ${process.versions.node}`);
  }
}

/**
 * Дописывает переменные в .env, если их там нет.
 *
 * Ищется НЕПУСТОЕ значение, а не просто строка с именем. PWA_URL= оператор
 * оставляет пустым сознательно — это «домен ещё не выбран», и такой файл
 * считается уже подготовленным. Иначе повторный запуск дописывал бы вторую
 * такую же строку, третий — третью, и .env рос бы как снежный ком.
 *
 * Уже непустое значение не трогаем: перегенерация PWA_AUTH_SECRET разлогинила бы
 * всех, кто уже поставил приложение. Ключ меняется только руками и только
 * вместе с обнулением срока у всех пользователей.
 */
function ensureEnvVars() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      'Файл .env не найден. Скопируйте .env.example в .env и заполните TELEGRAM_BOT_TOKEN, ' +
        'ENCRYPTION_SECRET_KEY и остальное — без него бот не запустится.',
    );
  }

  const original = readFileSync(ENV_FILE, 'utf-8');
  const hasSecret = hasNonEmptyVar(original, 'PWA_AUTH_SECRET');
  const hasUrl = hasNonEmptyVar(original, 'PWA_URL');

  const additions = [];

  if (!hasSecret) {
    const secret = crypto.randomBytes(32).toString('hex');
    additions.push('', '# Секрет для PWA-токенов (64 hex). Сгенерирован backend/scripts/pwa-setup.mjs.', `PWA_AUTH_SECRET=${secret}`);
  }

  if (!hasUrl) {
    // Пустой PWA_URL дописываем только если строки нет вовсе. Если она уже
    // есть и пустая — это осознанный выбор оператора («домен ещё не выбран»),
    // и повторный запуск не должен её плодить. Поэтому проверяем наличие
    // строки, а не непустого значения.
    if (!/^PWA_URL=/m.test(original)) {
      additions.push('', '# Публичный HTTPS-адрес PWA. Пусто — кнопка «Открыть в браузере» в боте не появится.', 'PWA_URL=');
    }
  }

  if (additions.length === 0) {
    log('.env: PWA_AUTH_SECRET и PWA_URL уже заданы — не трогаю.');
    return;
  }

  const separator = original.endsWith('\n') ? '' : '\n';
  writeFileSync(ENV_FILE, `${original}${separator}${additions.join('\n')}\n`, { mode: 0o600 });
  log(`.env: дописано ${hasSecret ? 'только PWA_URL (пустым)' : 'PWA_AUTH_SECRET (сгенерирован) и PWA_URL (пустым)'}.`);
}

/** Есть ли в содержимом .env переменная с непустым значением. */
function hasNonEmptyVar(content, name) {
  return new RegExp(`^${name}=\\s*\\S+`, 'm').test(content);
}

function ensureDependencies() {
  if (!existsSync(path.join(PWA_DIR, 'package.json'))) {
    throw new Error('Не найдена pwa/package.json — сборка не на месте.');
  }

  // npm ci удаляет node_modules и ставит ровно по lock-файлу. Падать с ним нельзя
  // на свежей машине, где lock ещё не успели применить, поэтому при отсутствии
  // lock-файла откатываемся на install.
  const hasLock = existsSync(path.join(PWA_DIR, 'package-lock.json'));
  log(hasLock ? 'Ставлю зависимости pwa/ (npm ci)…' : 'Ставлю зависимости pwa/ (npm install, lock-файла нет)…');
  run('npm', hasLock ? ['ci'] : ['install'], PWA_DIR);
}

function main() {
  checkNode();

  ensureEnvVars();
  ensureDependencies();

  log('Генерирую иконки…');
  run('npm', ['run', 'icons'], PWA_DIR);

  log('Собираю PWA…');
  run('npm', ['run', 'build'], PWA_DIR);

  warn('PWA_URL в .env остался пустым — задайте его ДО перезапуска бота, иначе кнопки «Открыть в браузере» не будет.');

  console.log(`
Готово. Осталось:

  1. Задать PWA_URL в .env:
       PWA_URL=https://ваш-домен
     Этот же адрес попадает в CORS-белый список API — отдельного WEB_APP_URL
     больше нет, Mini App удалена (см. backend/server/index.ts).

  2. Перезапустить бота:  npm run build && systemctl restart mood

  3. Раздать pwa/dist через nginx (шаблон — pwa/nginx.conf.example):
       sudo mkdir -p /var/www/mood-pwa
       sudo cp -r pwa/dist/* /var/www/mood-pwa/

  4. Открыть бота → «🌐 В браузере» → перейти по ссылке в Safari
     → Поделиться → На экран Домой.

  Подробности: pwa/README.md
`);
}

try {
  main();
} catch (err) {
  console.error('[pwa:setup] Не удалось подготовить PWA:', err instanceof Error ? err.message : err);
  process.exit(1);
}