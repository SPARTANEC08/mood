#!/usr/bin/env bash
#
# Запуск локального стенда: бот + REST API + PWA через туннель Cloudflare.
#
#   ./run.sh
#
# Поднимает три процесса:
#   1. vite (pwa/)           — порт 5173, фронтенд
#   2. cloudflared quick tunnel — HTTPS-адрес trycloudflare.com для телефона
#   3. бот + API             — порт 3000, секреты из .env
#
# Туннель один и поднят на vite: vite проксирует /api на :3000. Так CORS не
# участвует вовсе — ровно как в проде на одном домене.
#
# Прошлый запуск сносится автоматически, поэтому повторный ./run.sh не оставит
# двух ботов, дерущихся за long polling Telegram.
#
# Остановка: Ctrl+C. В фоне — kill %1, либо pkill -f dev-tunnel.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/pwa/scripts/dev-tunnel.sh"