#!/usr/bin/env bash
#
# Деплой и обновление Mood на VPS (прямой nginx-деплой, без Cloudflare).
#
# Два независимых сервиса:
#   mood      — приложение: REST API + нотификатор + Web Push + отчёты (dist/app.js);
#   mood-bot  — Telegram-бот поддержки: только ссылки и APK (dist/bot.js).
#
# Что делает одной командой:
#   1. собирает оба бандла (dist/app.js, dist/bot.js) и PWA (pwa/dist);
#   2. кладёт свежий APK в tg/apk (из apk/);
#   3. выгружает проект в APP_DIR на сервере (без node_modules, данных и .env);
#   4. ставит зависимости, раскатывает статику PWA, перезапускает mood;
#   5. выкладывает бота в BOT_DIR (по умолчанию /opt/mood-bot) и перезапускает
#      mood-bot — на этом же сервере или на отдельном (MOOD_BOT_HOST).
#
# .env и db/data НЕ трогаются: секреты и база живут только на сервере, деплой
# их не перезаписывает. Для бота нужен отдельный bot.env — см.
# backend/deploy/mood-bot.service.
#
# Использование:
#   MOOD_HOST=user@your-server bash backend/deploy/deploy.sh
#   MOOD_HOST=user@app  MOOD_BOT_HOST=user@bot  bash backend/deploy/deploy.sh
#   MOOD_SKIP_BOT=1 MOOD_HOST=user@app bash backend/deploy/deploy.sh
#
# (sudo на сервере может спросить пароль — понадобится интерактивный терминал.)

set -Eeuo pipefail

HOST="${MOOD_HOST:?Задайте MOOD_HOST=user@your-server}"
BOT_HOST="${MOOD_BOT_HOST:-$HOST}"
APP_DIR="${MOOD_APP_DIR:-/home/mood/mood}"
WEB_ROOT="${MOOD_WEB_ROOT:-/var/www/mood-pwa}"
SERVICE="${MOOD_SERVICE:-mood}"
BOT_DIR="${MOOD_BOT_DIR:-/opt/mood-bot}"
BOT_SERVICE="${MOOD_BOT_SERVICE:-mood-bot}"
SKIP_BOT="${MOOD_SKIP_BOT:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 1/5 Сборка бэкенда, бота и PWA =="
npm run build
npm run apk:bot || echo "  (APK не найден — бот будет показывать инструкцию установки)"
npm run pwa:build

echo "== 2/5 Выгрузка приложения в ${HOST}:${APP_DIR} =="
rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules \
  --exclude .git \
  --exclude db/data \
  --exclude .env \
  --exclude pwa/node_modules \
  --exclude image_d \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  ./ "${HOST}:${APP_DIR}/"

echo "== 3/5 Зависимости и статика на сервере =="
ssh -t -o StrictHostKeyChecking=accept-new "$HOST" bash -s <<REMOTE
set -Eeuo pipefail
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund
mkdir -p "${WEB_ROOT}"
sudo rsync -a --delete "${APP_DIR}/pwa/dist/" "${WEB_ROOT}/"
sudo chown -R root:root "${WEB_ROOT}"
sudo systemctl restart ${SERVICE}
sudo systemctl reload nginx
REMOTE

if [[ "$SKIP_BOT" != "1" ]]; then
  echo "== 4/5 Бот в ${BOT_HOST}:${BOT_DIR} =="
  # Бот — один самодостаточный файл плюс APK. Ни node_modules, ни база ему не
  # нужны: на отдельном сервере достаточно Node 20.
  tar -C dist -cf - bot.js | ssh -o StrictHostKeyChecking=accept-new "$BOT_HOST" \
    "sudo mkdir -p '${BOT_DIR}/dist' && sudo tar -C '${BOT_DIR}/dist' -xf -"
  if compgen -G "tg/apk/*.apk" > /dev/null; then
    tar -C tg/apk -cf - . | ssh -o StrictHostKeyChecking=accept-new "$BOT_HOST" \
      "sudo mkdir -p '${BOT_DIR}/tg/apk' && sudo tar -C '${BOT_DIR}/tg/apk' -xf -"
  fi
  ssh -t -o StrictHostKeyChecking=accept-new "$BOT_HOST" bash -s <<REMOTE
set -Eeuo pipefail
if ! systemctl cat ${BOT_SERVICE} >/dev/null 2>&1; then
  echo "  Юнит ${BOT_SERVICE} не установлен. См. backend/deploy/mood-bot.service"
  exit 1
fi
sudo systemctl restart ${BOT_SERVICE}
REMOTE
else
  echo "== 4/5 Бот пропущен (MOOD_SKIP_BOT=1) =="
fi

echo "== 5/5 Проверка =="
ssh -o StrictHostKeyChecking=accept-new "$HOST" \
  "sleep 3; curl -fsS http://127.0.0.1:3000/health && echo; sudo systemctl is-active ${SERVICE}"
if [[ "$SKIP_BOT" != "1" ]]; then
  ssh -o StrictHostKeyChecking=accept-new "$BOT_HOST" "sudo systemctl is-active ${BOT_SERVICE}"
fi
echo "Готово."
