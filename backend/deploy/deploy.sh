#!/usr/bin/env bash
#
# Деплой и обновление Mood на VPS (прямой nginx-деплой, без Cloudflare).
#
# Что делает одной командой:
#   1. собирает бэкенд (dist/bot.js) и PWA (pwa/dist);
#   2. выгружает проект в APP_DIR на сервере (без node_modules, данных и .env);
#   3. ставит зависимости (npm ci --omit=dev);
#   4. раскатывает статику PWA в WEB_ROOT и перезапускает сервис.
#
# .env и db/data НЕ трогаются: секреты и база живут только на сервере, деплой
# их не перезаписывает. Первичная настройка (.env, миграция БД, systemd-юнит
# mood.service, nginx-сайт mood-pwa) выполняется отдельно — см. backend/deploy/README-direct.md.
#
# Использование:
#   MOOD_HOST=user@your-server bash backend/deploy/deploy.sh
#   (sudo на сервере может спросить пароль — понадобится интерактивный терминал)
#
# Автозапуск и авто-перезапуск обеспечивает systemd: юнит mood.service включён
# (enable) и содержит Restart=always, поэтому падение не требует вмешательства.

set -Eeuo pipefail

HOST="${MOOD_HOST:?Задайте MOOD_HOST=user@your-server}"
APP_DIR="${MOOD_APP_DIR:-/home/mood/mood}"
WEB_ROOT="${MOOD_WEB_ROOT:-/var/www/mood-pwa}"
SERVICE="${MOOD_SERVICE:-mood}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 1/4 Сборка бэкенда и PWA =="
npm run build
npm run pwa:build

echo "== 2/4 Выгрузка приложения в ${HOST}:${APP_DIR} =="
rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules \
  --exclude .git \
  --exclude db/data \
  --exclude .env \
  --exclude pwa/node_modules \
  --exclude image_d \
  --exclude '*.log' \
  --exclude .DS_Store \
  ./ "${HOST}:${APP_DIR}/"

echo "== 3/4 Зависимости и статика на сервере =="
ssh -t -o StrictHostKeyChecking=accept-new "$HOST" bash -s <<REMOTE
set -Eeuo pipefail
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund
mkdir -p "${WEB_ROOT}"
sudo rsync -a --delete "${APP_DIR}/pwa/dist/" "${WEB_ROOT}/"
sudo chown -R root:root "${WEB_ROOT}"
sudo systemctl restart "${SERVICE}"
sudo systemctl reload nginx
REMOTE

echo "== 4/4 Проверка =="
ssh -o StrictHostKeyChecking=accept-new "$HOST" \
  "sleep 3; curl -fsS http://127.0.0.1:3000/health && echo; sudo systemctl is-active ${SERVICE}"
echo "Готово."
