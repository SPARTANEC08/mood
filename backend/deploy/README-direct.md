# Прямой деплой PWA на VPS (Nginx + Let's Encrypt, без Cloudflare)

Схема: пользователь идёт **напрямую на IP VPS**, системный nginx держит HTTPS и
отдаёт статику PWA, `/api/` проксируется на Fastify (`127.0.0.1:3000`), который
живёт в том же процессе, что и бот. Cloudflared quick-туннель не используется.

```
Браузер → nginx :443 (TLS, статика /var/www/mood-pwa, /api/ → 127.0.0.1:3000)
                    └── node dist/bot.js (Fastify API + grammY long polling)
```

Почему не туннель: при прямом подключении ТСПУ видит IP VPS, а не IP CDN, и
обхода лимита в 16 КБ нет. Обратная сторона — нет защиты Cloudflare от DDoS;
базовой защиты Aeza обычно хватает.

## 0. Предпосылки

- Ubuntu с системным nginx, Node 20+, certbot (в этом деплое — snap-certbot).
- Открыты входящие **80** и **443** (ufw и/или облачный firewall провайдера):
  ```bash
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
  ```
  Порт 80 обязателен: Let's Encrypt проверяет владение доменом по HTTP-01.
- **Публичный домен** с A-записью на IP VPS. Let's Encrypt не выдаёт сертификат
  на голый IP, а без HTTPS Service Worker (и установка PWA) не работают.
  Если домена ещё нет — временно годится `sslip.io`: имя `<IP-с-дефисами>.sslip.io`
  резолвится в сам IP (например `203-0-113-10.sslip.io`).

## 1. Статика PWA

Сборка (`npm run pwa:build`) кладёт результат в `pwa/dist`. На сервер её надо
именно скопировать **rsync-ом**: манифест сборки лежит в `pwa/dist/.vite/`,
скрыт от шаблона `*` и при `cp -r dist/*` на сервер не попадает — установленное
приложение на слабой сети открывается белым экраном.

```bash
sudo mkdir -p /var/www/mood-pwa
sudo rsync -a --delete <путь-к-репо>/pwa/dist/ /var/www/mood-pwa/
sudo chown -R root:root /var/www/mood-pwa
sudo find /var/www/mood-pwa -type d -exec chmod 755 {} +
sudo find /var/www/mood-pwa -type f -exec chmod 644 {} +
```

## 2. Nginx

Готовый server-блок — `pwa/nginx.conf.example` (домен `pwa.example.com` и пути к
сертификату заменить своими). Сначала ставим HTTP-вариант (без 443), чтобы
certbot смог пройти HTTP-01, затем добавляем 443-блок.

```bash
sudo cp pwa/nginx.conf.example /etc/nginx/sites-available/mood-pwa   # после правки server_name
sudo ln -sf /etc/nginx/sites-available/mood-pwa /etc/nginx/sites-enabled/mood-pwa
sudo nginx -t && sudo systemctl reload nginx
```

Ключевые места конфига:
- `client_max_body_size 22m` — иначе nginx отклонит файл >1 МБ (свой дефолт 1m)
  ещё до API, хотя приложение разрешает 20 МБ;
- `location = /sw.js` с `Cache-Control: no-cache` — без этого браузер месяц не
  увидит новый Service Worker;
- `location /api/` с `proxy_read_timeout 120s` (БАРС/почта живут дольше 60 с) и
  `proxy_request_buffering off` (большие загрузки не буферизуются целиком);
- статика отдаётся nginx, Node её не трогает.

## 3. Сертификат

```bash
sudo certbot certonly --webroot -w /var/www/html -d <домен> \
  --non-interactive --agree-tos --register-unsafely-without-email
```

Продление — автоматически (`snap.certbot.renew.timer` или системный таймер),
nginx перечитывается deploy-hook-ом:

```bash
printf '#!/bin/sh\nsystemctl reload nginx\n' | \
  sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run   # проверка
```

## 4. Сервис приложения (`/etc/systemd/system/mood.service`)

Бэкенд — один процесс (Fastify API + бот + нотификатор). Пример юнита под деплой
в домашнем каталоге пользователя:

```ini
[Unit]
Description=Mood - PWA API + Telegram bot (direct nginx)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=mood
Group=mood
WorkingDirectory=/home/mood/mood
UMask=0077
EnvironmentFile=/home/mood/mood/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --max-old-space-size=768 dist/bot.js
MemoryMax=1536M
Restart=always
RestartSec=10
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mood

[Install]
WantedBy=multi-user.target
```

Универсальный вариант под `/opt/mood` и отдельного пользователя `mood` — в
`backend/deploy/mood.service` (см. README.md).

В `.env`:

```env
PWA_URL=https://<домен>     # кнопка «Открыть приложение» в боте + CORS-источник
API_PORT=3000               # без него API не поднимается
API_HOST=127.0.0.1          # наружу отдаёт nginx
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mood
```

## 5. Важно при миграции с туннеля

Старую схему с CF-туннелем надо **выключить целиком**, иначе два процесса с одним
токеном бота дают `409 Conflict` в long polling:

```bash
systemctl --user disable --now mood.service   # если старая схема была user-юнитом
pkill -f cloudflared; pkill -f mood-user-stack.sh
```

Проверка, что остался один процесс:

```bash
pgrep -af 'dist/bot.js'          # ровно одна строка
ss -tlnp | grep -E ':(80|443|3000)\b'
```

## 6. Проверка

```bash
curl -sI https://<домен>/ | head -1                       # 200
curl -s  https://<домен>/.vite/manifest.json | head -c 40 # манифест есть (иначе белый экран)
curl -sI http://<домен>/ | head -1                        # 301 → https
sudo journalctl -u mood -n 20 --no-pager
```

С российского интернета без VPN открыть `https://<домен>` и убедиться, что
приложение ставится на домашний экран (для этого нужен настоящий HTTPS).

## 7. Обновление

```bash
# код: собрать бот и статику, затем на сервере
npm ci && npm run build
sudo rsync -a --delete pwa/dist/ /var/www/mood-pwa/
sudo systemctl restart mood
```

## Смена домена

Когда появится свой домен: поправить `server_name` в конфиге nginx, выпустить на
него сертификат (`certbot certonly --webroot ...`), обновить пути
`ssl_certificate`/`ssl_certificate_key` и `PWA_URL` в `.env`, затем
`sudo systemctl reload nginx && sudo systemctl restart mood`.
