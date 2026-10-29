#!/usr/bin/env bash
#
# Запуск локального стенда: приложение (API + нотификатор) + PWA через туннель.
#
#   ./run.sh
#
# Поднимает три процесса:
#   1. vite (pwa/)           — порт 5173, фронтенд
#   2. cloudflared quick tunnel — HTTPS-адрес trycloudflare.com для телефона
#   3. приложение            — API + нотификатор, порт 3000, секреты из .env
#
# Бот в стенд не входит: он самостоятельный, для него `npm run dev:bot`.
#
# Туннель один и поднят на vite: vite проксирует /api на :3000. Так CORS не
# участвует вовсе — ровно как в проде на одном домене.
#
# Остановка: Ctrl+C. В фоне — kill %1, либо pkill -f dev-tunnel.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/pwa/scripts/dev-tunnel.sh"