#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${HOME}/hub"
STATE_DIR="${HOME}/.local/state/hub"
NGINX_PREFIX="${STATE_DIR}/nginx"
TUNNEL_LOG="${STATE_DIR}/cloudflared.log"
NGINX_BIN="${NGINX_BIN:-/usr/sbin/nginx}"
CLOUDFLARED="${HOME}/.local/bin/cloudflared"

mkdir -p "${NGINX_PREFIX}/proxy_temp" "${NGINX_PREFIX}/client_body_temp"
: > "${TUNNEL_LOG}"
umask 077

export API_HOST=127.0.0.1
export API_PORT=3000
export NODE_ENV=production

"${NGINX_BIN}" -p "${NGINX_PREFIX}/" -c "${APP_DIR}/deploy/hub-user-nginx.conf" -g 'daemon off;' &
NGINX_PID=$!

"${CLOUDFLARED}" tunnel --no-autoupdate --loglevel info --url http://127.0.0.1:8080 >"${TUNNEL_LOG}" 2>&1 &
TUNNEL_PID=$!
BOT_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in ${BOT_PID:-} "${TUNNEL_PID:-}" "${NGINX_PID:-}"; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
  for pid in ${BOT_PID:-} "${TUNNEL_PID:-}" "${NGINX_PID:-}"; do
    [[ -n "${pid}" ]] && wait "${pid}" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 0' INT TERM

PUBLIC_URL=""
for _ in $(seq 1 90); do
  PUBLIC_URL="$(python3 -c 'import re,sys; text=open(sys.argv[1], errors="replace").read(); m=re.findall(r"https://[a-z0-9-]+\.trycloudflare\.com", text); print(m[0] if m else "")' "${TUNNEL_LOG}")"
  [[ -n "${PUBLIC_URL}" ]] && break
  kill -0 "${TUNNEL_PID}" 2>/dev/null || break
  sleep 1
done

if [[ -z "${PUBLIC_URL}" ]]; then
  echo "[Hub] Cloudflare Quick Tunnel не выдал адрес; смотрите user journal и ${TUNNEL_LOG}." >&2
  exit 1
fi

# PWA_URL переопределяется только для процесса; .env копируется без правок.
export PWA_URL="${PUBLIC_URL}"
echo "[Hub] Публичный HTTPS-адрес: ${PWA_URL}"

node "${APP_DIR}/dist/bot.js" &
BOT_PID=$!

set +e
wait -n "${NGINX_PID}" "${TUNNEL_PID}" "${BOT_PID}"
STATUS=$?
set -e
exit "${STATUS}"
