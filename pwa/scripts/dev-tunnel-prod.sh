#!/usr/bin/env bash
#
# Проверка PWA на iPhone в СОБРАННОМ виде.
#
# Отличие от dev-tunnel.sh: раздаётся pwa/dist, а не dev-сервер vite. Для
# телефона это единственный честный замер — dev-сборка тянет сотни отдельных
# модулей через HMR, и на мобильном интернете она выглядит «вечно грузящимся
# сайтом», хотя production-сборка открывается за секунду.
#
# Что поднимает:
#   1. vite preview — раздаёт pwa/dist (тот же код, что уедет на nginx)
#   2. cloudflared  — HTTPS-адрес для Safari на телефоне
#   3. бот + API    — порт 3000
#
# Останавливается по Ctrl+C.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREVIEW_PORT=4173
API_PORT=3000

# Порт локального прокси. Отдельный и не 3000/4173: 3000 занят API, 4173 —
# самим preview. Туннель смотрит на прокси, а тот уже перенаправляет /api на
# 3000, а всё остальное — на 4173.
PROXY_PORT=4180

MOCK_ID="${MOCK_TELEGRAM_USER_ID:-100000001}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "Не найден cloudflared. Установите: brew install cloudflared"
  exit 1
}

PIDS=()

# Временный файл для лога. Именно make_log, а не `mktemp /tmp/имя-XXXXXX.log`:
# BSD-mktemp на macOS подставляет шаблон только в самом конце имени, а с
# суффиксом `.log` возвращает его дословно — и все логи писались бы в один файл.
make_log() {
  mktemp -t "$1"
}

cleanup() {
  echo ""
  echo "Останавливаю процессы..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  pkill -f 'tsx tg/bot.ts' 2>/dev/null || true
  pkill -f 'vite preview' 2>/dev/null || true
  pkill -f 'cloudflared tunnel --url' 2>/dev/null || true
  echo "Готово."
}
trap cleanup EXIT INT TERM

cd "$ROOT"

if [ ! -d pwa/dist ]; then
  echo "Сборки нет. Выполните: npm run pwa:build"
  exit 1
fi

# ── 1. Раздача собранной версии ────────────────────────────────────────────
PREVIEW_LOG=$(make_log mood-pwa-preview)
echo "▸ Раздаю pwa/dist на порту $PREVIEW_PORT, лог: $PREVIEW_LOG"

# preview не умеет проксировать /api (это делает dev-сервер), поэтому прокси
# поднимаем отдельным процессом через локальный http-сервер node. Он же решает
# вторую задачу: отдать API с того же origin, откуда открыта страница, — иначе
# на телефоне сработал бы CORS, а проверить мы хотим именно сборку, а не CORS.
(cd pwa && npx vite preview --port "$PREVIEW_PORT" --host 127.0.0.1) > "$PREVIEW_LOG" 2>&1 &
PIDS+=($!)

echo "  жду готовности..."
READY=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PREVIEW_PORT" || true)" = "200" ]; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "✗ preview не поднялся за 30 с. Лог:"
  cat "$PREVIEW_LOG"
  exit 1
fi

# ── 2. Прокси /api → :3000 ─────────────────────────────────────────────────
PROXY_LOG=$(make_log mood-pwa-proxy)
echo "▸ Поднимаю прокси /api → 127.0.0.1:$API_PORT..."
PROXY_JS="$(make_log mood-pwa-proxy-script).mjs"

# Прокси на голом node без зависимостей: preview-сервер проксировать не умеет,
# а ставить ради этого отдельный пакет незачем.
cat > "$PROXY_JS" <<'PROXY'
import http from 'node:http';

const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3000) };
const STATIC = { host: '127.0.0.1', port: Number(process.env.PREVIEW_PORT ?? 4173) };

// /api уходит на процесс бота, всё остальное — на статику собранной версии.
//
// Разделение обязательно: один и тот же origin для страницы и API — это ровно
// то, как всё устроено в проде за nginx. Если бы страница и API были на разных
// портах, проверка шла бы через CORS и ничего не сказала бы о самом приложении.
const upstream = (url) => (url.startsWith('/api/') || url === '/health' ? API : STATIC);

http
  .createServer((req, res) => {
    const target = upstream(req.url ?? '/');

    const proxy = http.request(
      {
        host: target.host,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${target.host}:${target.port}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    // Ошибка соединения должна быть видна как 502, а не как «сайт не грузится
    // вечно»: иначе непонятно, упал бот или сломался туннель.
    proxy.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'proxy_error', message: `${target.port}: ${err.message}` }));
    });

    req.pipe(proxy);
  })
  .listen(Number(process.env.PROXY_PORT ?? 4180), '127.0.0.1', () => {
    console.log(`proxy: /api → ${API.host}:${API.port}, остальное → ${STATIC.host}:${STATIC.port}`);
  });
PROXY

API_PORT="$API_PORT" PREVIEW_PORT="$PREVIEW_PORT" PROXY_PORT="$PROXY_PORT" node "$PROXY_JS" > "$PROXY_LOG" 2>&1 &
PIDS+=($!)

# Прокси обязан быть готов до туннеля: иначе первая же проверка адреса увидит
# соединение refused и решит, что сборка не раздаётся.
for _ in $(seq 1 15); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/api/pwa/issue" || true)" != "000" ]; then
    break
  fi
  sleep 1
done

# ── 3. Туннель ─────────────────────────────────────────────────────────────
TUNNEL_LOG=$(make_log mood-pwa-tunnel)
echo "▸ Поднимаю туннель..."
cloudflared tunnel --url "http://localhost:$PROXY_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
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

# Туннель смотрит на прокси, а тот — на preview. Значит, прежде чем отдавать
# адрес, надо убедиться, что по нему действительно отдаётся приложение, а не
# ошибка прокси: иначе пользователь откроет ссылку и увидит 502.
for _ in $(seq 1 20); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL_URL" || true)" = "200" ]; then
    break
  fi
  sleep 1
done

# ── 4. Бот + API ───────────────────────────────────────────────────────────
echo "▸ Запускаю бота и API на порту $API_PORT..."
BOT_LOG=$(make_log mood-pwa-bot)

# ${MOCK_ID} в фигурных скобках: кириллическая кавычка » после голого $MOCK_ID
# попадает в имя переменной, и bash падает с «unbound variable».
API_PORT="$API_PORT" \
API_HOST=127.0.0.1 \
MOCK_TELEGRAM_USER_ID="$MOCK_ID" \
PWA_URL="$TUNNEL_URL" \
  npx tsx tg/bot.ts > "$BOT_LOG" 2>&1 &
PIDS+=($!)

echo "  жду API..."
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health" || true)" = "200" ]; then
    break
  fi
  sleep 1
done

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅ PWA (собранная версия):  $TUNNEL_URL"
echo "  ✅ API:                    http://127.0.0.1:$API_PORT/health"
echo ""
echo "  📱 iPhone:"
echo "     открой ссылку в Safari"
echo "     → Поделиться → На экран Домой"
echo "     → запусти с иконки"
echo ""
echo "  🔑 Вход: на экране входа войдите логином и паролем БАРС МЭИ"
echo "     ⚠️  В собранной версии кнопки нет — она только для dev."
echo "     Если её нет, открой бота в Telegram и нажми «🌐 В браузере»."
echo ""
echo "  📋 Лог бота:      $BOT_LOG"
echo "  📋 Лог preview:   $PREVIEW_LOG"
echo "  📋 Лог прокси:    $PROXY_LOG"
echo ""
echo "  Ctrl+C — остановить всё."
echo "════════════════════════════════════════════════"
echo ""

while true; do
  alive=0
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive=1
    fi
  done

  if [ "$alive" -eq 0 ]; then
    echo "✗ Все процессы завершились. Логи:"
    tail -20 "$PREVIEW_LOG" 2>/dev/null || true
    tail -20 "$PROXY_LOG" 2>/dev/null || true
    tail -20 "$BOT_LOG" 2>/dev/null || true
    exit 1
  fi

  sleep 5
done