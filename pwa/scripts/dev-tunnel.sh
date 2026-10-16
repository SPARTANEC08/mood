#!/usr/bin/env bash
#
# Проверка PWA на настоящем iPhone.
#
# Что поднимает:
#   1. vite (папка pwa/) — порт 5173
#   2. cloudflared      — HTTPS-адрес, который откроет Safari на телефоне
#   3. бот + API        — порт 3000, в режиме разработки
#
# Сценарий A (по умолчанию): ОДИН туннель на vite, vite проксирует /api на
# :3000. Проще всего, CORS не участвует, PWA_URL совпадает с адресом туннеля —
# ровно то, как всё работает в проде на одном домене.
#
# Сценарий B (два туннеля — фронт и API отдельно) в README описан как способ
# проверить кросс-доменное поведение CORS. Дефолтом он не является намеренно:
# лишний туннель — лишняя переменная, которую надо не забыть выставить.
#
# Останавливается по Ctrl+C.

set -euo pipefail

# Скрипт лежит в pwa/scripts/, поэтому до корня проекта два уровня вверх.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VITE_PORT=5173
API_PORT=3000

# Telegram ID тестового пользователя: он уже есть в базе, и через него бот
# отдаёт приветственный экран без входа в БАРС. В PWA это ни на что не влияет —
# вход в приложение логином и паролем БАРС, а не через Telegram.
MOCK_ID="${MOCK_TELEGRAM_USER_ID:-757471228}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "Не найден cloudflared. Установите:"
  echo "  macOS:  brew install cloudflared"
  echo "  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}

command -v npx >/dev/null 2>&1 || {
  echo "Не найден npx. Проверьте установку Node.js."
  exit 1
}

if [ ! -d "$ROOT/node_modules/tsx" ]; then
  echo "В корне проекта нет tsx. Выполните: npm install"
  exit 1
fi

if [ ! -d "$ROOT/pwa/node_modules" ]; then
  echo "В pwa/ нет зависимостей. Выполните: cd pwa && npm install"
  exit 1
fi

PIDS=()

# ── 0. Уборка прошлого запуска ──────────────────────────────────────────────
# Скрипт запускают повторно, а старые vite/cloudflared/tsx остаются висеть:
# порт 5173 и 3000 уже заняты, второй cloudflared создаёт ЛИШНИЙ туннель, а два
# бота делят long polling Telegram. Поэтому перед стартом сносим всё, что
# осталось от прошлого запуска. Без этого повторный запуск молча даёт
# нерабочую связку из двух процессов.
echo "▸ Убираю возможные остатки прошлого запуска..."
pkill -f "cloudflared tunnel --url http://localhost:$VITE_PORT" 2>/dev/null || true
pkill -f "vite --port $VITE_PORT" 2>/dev/null || true
pkill -f "tsx bot.ts" 2>/dev/null || true
sleep 1

# Временный файл для лога процесса.
#
# Не `mktemp /tmp/имя-XXXXXX.log`: BSD-mktemp (macOS) подставляет шаблон
# ТОЛЬКО если он стоит в самом конце — с суффиксом `.log` он возвращает имя
# дословно, и все три лога писались бы в один и тот же файл, затирая друг
# друга. GNU-mktemp с такой формой справляется, поэтому Portable-вариант
# нужен именно ради macOS.
make_log() {
  mktemp -t "$1"
}

cleanup() {
  echo ""
  echo "Останавливаю процессы..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  pkill -f "cloudflared tunnel --url http://localhost:$VITE_PORT" 2>/dev/null || true
  pkill -f "vite --port $VITE_PORT" 2>/dev/null || true
  pkill -f "tsx bot.ts" 2>/dev/null || true
  echo "Готово."
}
trap cleanup EXIT INT TERM

cd "$ROOT"

# ── 1. Фронтенд ────────────────────────────────────────────────────────────
VITE_LOG=$(make_log hub-pwa-vite)
echo "▸ Запускаю vite (pwa/) на порту $VITE_PORT, лог: $VITE_LOG"
(
  cd pwa
  npx vite --port "$VITE_PORT" --host 127.0.0.1
) > "$VITE_LOG" 2>&1 &
PIDS+=($!)

# Ждём не фиксированное число секунд, а настоящую готовность: на медленном
# Mac Vite стартует дольше, чем на быстром, и фиксированный sleep давал бы
# туннель, указывающий в пустоту.
echo "  жду готовности..."
READY=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VITE_PORT" || true)" = "200" ]; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "✗ Vite не поднялся за 30 с. Лог:"
  cat "$VITE_LOG"
  exit 1
fi

# ── 2. Туннель ─────────────────────────────────────────────────────────────
TUNNEL_LOG=$(make_log hub-pwa-tunnel)
echo "▸ Поднимаю туннель..."
cloudflared tunnel --url "http://localhost:$VITE_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
PIDS+=($!)

TUNNEL_URL=""
for _ in $(seq 1 30); do
  sleep 1
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then break; fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "✗ Туннель не поднялся за 30 с. Лог:"
  cat "$TUNNEL_LOG"
  exit 1
fi

# ── 3. Бот + API ───────────────────────────────────────────────────────────
# Секреты (TELEGRAM_BOT_TOKEN и пр.) подхватываются из корневого .env через
# dotron — ниже только то, что нужно локально для проверки PWA.
echo "▸ Запускаю бота и API на порту $API_PORT..."
API_PORT="$API_PORT" \
API_HOST=127.0.0.1 \
MOCK_TELEGRAM_USER_ID="$MOCK_ID" \
PWA_URL="$TUNNEL_URL" \
  npx tsx bot.ts > "$(make_log hub-pwa-bot)" 2>&1 &
PIDS+=($!)

# Ждём живости API: пока бот поднимает БАРС и IMAP, /health может не отвечать
# сразу. Пользователь между «всё готово» и «не работает» никуда не уйдёт.
echo "  жду API..."
API_READY=0
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health" || true)" = "200" ]; then
    API_READY=1
    break
  fi
  sleep 1
done

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅ PWA доступен:  $TUNNEL_URL"
echo "  ✅ API:           http://127.0.0.1:$API_PORT/health${API_READY:+ (готов)}"
echo ""
echo "  📱 iPhone:"
echo "     открой ссылку в Safari"
echo "     → Поделиться → На экран Домой"
echo "     → запусти с домашнего экрана"
echo ""
echo "  🔑 Вход: логином и паролем от личного кабинета БАРС МЭИ."
echo "     Telegram для входа не нужен — это отдельный продукт."
echo ""
echo "  📋 Лог туннеля:   $TUNNEL_LOG"
echo "  📋 Лог vite:      $VITE_LOG"
echo ""
echo "  Ctrl+C — остановить всё."
echo "════════════════════════════════════════════════"
echo ""

# Держим скрипт живым и ловим падение любого из процессов: молча висящий
# скрипт с мёртвым туннелем хуже явной ошибки.
while true; do
  alive=0
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive=1
    fi
  done

  if [ "$alive" -eq 0 ]; then
    echo "✗ Все процессы завершились. Логи:"
    tail -30 "$VITE_LOG" 2>/dev/null || true
    tail -30 "$TUNNEL_LOG" 2>/dev/null || true
    exit 1
  fi

  sleep 5
done