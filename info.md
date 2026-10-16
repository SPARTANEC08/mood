# Hub — полная техническая и функциональная документация

**Hub** — веб-приложение (PWA) для студентов НИУ МЭИ и тонкий Telegram-бот к нему.
Приложение даёт расписание группы, домашние задания, объявления группы («Важное»),
личный кабинет БАРС МЭИ (оценки, пропуски, приказы, стипендия, книги, рейтинг) и
превью корпоративной почты ОСЭП. Бот больше не интерфейс: он привязывает Telegram
к записи приложения и присылает фоновые уведомления о новых баллах, письмах,
приказах и смене стипендии.

Документ описывает состояние рабочего дерева на **15.10.2026**. Проект переименован
в **Hub** (пакеты, ключи `localStorage`, systemd-юнит, SW-кэши — везде `hub*`).
Основной сдвиг относительно прежней версии: **бот стал тонким push-каналом**, весь
интерфейс переехал в PWA, вход идёт логином и паролем БАРС (Telegram не нужен),
**почту обновляет только фоновый цикл уведомлений**; фото открываются во встроенном
просмотрщике, PDF — в системном браузерном просмотрщике, прочие файлы отдаются
системе (share/сохранение).

---

## Содержание

1. [Назначение и границы](#1-назначение-и-границы)
2. [Архитектура и процессы](#2-архитектура-и-процессы)
3. [Стек](#3-стек)
4. [Структура проекта](#4-структура-проекта)
5. [Telegram-бот как push-канал](#5-telegram-бот-как-push-канал)
6. [Форматирование текста](#6-форматирование-текста)
7. [Авторизация в БАРС и вход в PWA](#7-авторизация-в-барс-и-вход-в-pwa)
8. [Антибрутфорс-лимитер входа](#8-антибрутфорс-лимитер-входа)
9. [Расписание МЭИ](#9-расписание-мэи)
10. [Кэш расписания](#10-кэш-расписания)
11. [Домашние задания](#11-домашние-задания)
12. [«Важное» (объявления группы)](#12-важное-объявления-группы)
13. [Сервисы личного кабинета БАРС](#13-сервисы-личного-кабинета-барс)
14. [Файлы на сервере](#14-файлы-на-сервере)
15. [Хранилище данных](#15-хранилище-данных)
16. [Шифрование кредов](#16-шифрование-кредов)
17. [Почта ОСЭП](#17-почта-осэп)
18. [Фоновые уведомления](#18-фоновые-уведомления)
19. [REST API для PWA (Fastify)](#19-rest-api-для-pwa-fastify)
20. [Авторизация API (PWA-токен)](#20-авторизация-api-pwa-токен)
21. [Типы API](#21-типы-api)
22. [Веб-приложение (React)](#22-веб-приложение-react)
23. [Переменные окружения](#23-переменные-окружения)
24. [Запуск и разработка](#24-запуск-и-разработка)
25. [Тесты и проверки](#25-тесты-и-проверки)
26. [Деплой](#26-деплой)
27. [Известные риски и техдолг](#27-известные-риски-и-техдолг)
28. [Быстрый ориентир по файлам](#28-быстрый-ориентир-по-файлам)

---

## 1. Назначение и границы

**Что делает приложение (PWA, ставится на домашний экран):**
- показывает расписание группы с официального портала `ts.mpei.ru` с недельной
  сеткой Пн–Вс и свайпом;
- принимает домашние задания и «Важное» в формах, привязывает ДЗ к будущей паре;
- хранит прикреплённые файлы на сервере (фото, pdf, txt, docx) и показывает фото
  во встроенном просмотрщике (`InAppBrowser`), а pdf/word/прочее по тапу отдаёт
  системе (системный шит «Поделиться»/сохранение) — «Скачать»;
- по единой учётной записи МЭИ входит в личный кабинет БАРС и отдаёт успеваемость,
  пропуски, приказы, стипендию, книги НТБ, рейтинг;
- показывает превью непрочитанных писем ОСЭП;
- входит самостоятельно логином и паролем БАРС — Telegram для входа не нужен;
- при первом открытии в браузере показывает инструкцию по установке;
- в «Кабинете» управляет подпиской на Telegram-уведомления (включить/выключить,
  подключить через бота).

**Что делает бот (Telegram) — только три вещи:**
- приветствует и даёт ссылку на приложение (`/start`, `/app`);
- привязывает Telegram к существующей записи приложения по `/start <userId>`
  (как это делает кнопка «Подключить уведомления» в профиле);
- включает и выключает уведомления (`notif_on` / `notif_off`);
- присылает фоновые уведомления новым сообщением с кнопкой
  `✕ Скрыть уведомление` (`notif_dismiss`).

**Чего больше нет в боте:** расписания, ДЗ, «Важного», карточек пар, хаба
«Остальное», экранов оценок/пропусков/книг/приказов/почты, воронки входа в БАРС,
приёма файлов и нижней клавиатуры. Всё это переехало в PWA.

**Ключевая связь двух клиентов.** Идентификатор человека — `userId` (UUID),
общая точка входа — `barsLoginHash` (sha256 от нормализованного логина БАРС).
Один человек — одна запись, поэтому один и тот же аккаунт БАРС можно
использовать одновременно в боте и PWA; привязка Telegram **не** блокирует вход
в веб-приложение (проверка `account_conflict` удалена).

**Чего приложение не делает:**
- не отдаёт веб-почту ОСЭП целиком: только превью писем, чтение — на `mail.mpei.ru`;
- не входит в аккаунт через Telegram: Telegram — только канал доставки уведомлений.

---

## 2. Архитектура и процессы

Проект — **один процесс Node.js**, внутри которого крутится всё сразу:

```text
                 ┌────────────────────── один процесс node dist/bot.js ───────────────────────┐
                 │                                                                         │
  Telegram ──────► grammY long polling ──► botEngine ──► pwaView (HTML) ──► reply/editMessage │
  (long polling)        │                                                                   │
                        │                                                                   │
                        ├──► barsNotifier (таймер 20 мин) ──► БАРС + OWA ──► уведомления  │
                        │                                                                   │
  PWA ─────► nginx/Vite ──► Fastify /api/* ──────────────┐                                  │
  (X-PWA-Token)              │                           │                                  │
                             ├──► userStore / fileStore  │                                  │
                             ├──► scheduleCache ──► mpeiApi ──► ts.mpei.ru                  │
                             ├──► BarsService ──► bars.mpei.ru                              │
                             ├──► OwaMailClient ──► mail.mpei.ru/owa (HTTPS, FBA)           │
                             └──► barsSnapshotCache (20 мин, stale-while-revalidate)        │
                 └─────────────────────────────────────────────────────────────────────────┘
```

Ключевые архитектурные решения:

- **API и бот — один процесс и одни сервисы.** `src/server/` обращается к тем же
  `userStore`, `scheduleCache`, `BarsService`, `OwaMailClient`, что и нотификатор.
  API поднимается только если задан `API_PORT` (ленивый `await import` в
  `telegramService.ts`), ошибка старта API не роняет бота.
- **Статику раздаёт не сервер.** В `src/server` нет `@fastify/static`: фронтенд
  живёт на nginx/Vercel, в dev — Vite.
- **Авторизация PWA — собственный токен в заголовке `X-PWA-Token`** (HMAC-SHA256 +
  проверка хэша токена в записи). Ни JWT, ни OAuth, ни cookie, ни `initData`.
- **Снимок БАРС в памяти** (`barsSnapshotCache`) обслуживает разделы БАРС
  (оценки/пропуски/приказы/стипендия/книги/рейтинг): один поход в МЭИ на
  пользователя, TTL 20 минут, stale-while-revalidate. **Почта в этот снимок не
  входит** — её превью живёт отдельно (`mailPreviewCache`) и заполняется только
  нотификатором.
- **Всё время — `Europe/Moscow`** независимо от TZ сервера (`src/utils/time.ts`).

---

## 3. Стек

### Бэкенд (корень репозитория)

| Слой | Технология | Версия |
|---|---|---|
| Рантайм | Node.js | 20+ (target esbuild `node20`) |
| Язык | TypeScript | ^5.6.0, `strict: true` |
| Модули | ESM (`"type": "module"`) | — |
| Прод-сборка | esbuild | ^0.28.2 |
| Запуск в dev | tsx | ^4.21.0 |
| Telegram | grammY | ^1.46.0 |
| HTTP | axios + axios-cookiejar-support + tough-cookie | ^1.20 / ^6.0.5 / ^6.0.2 |
| HTML-разбор | cheerio | ^1.2.0 |
| Почта | axios + tough-cookie (OWA-скрапинг); imapflow/mailparser — deprecated | — |
| Изображения | sharp | ^0.35.5 (лениво, превью) |
| API | fastify + @fastify/cors + @fastify/multipart | ^5.12.5 / ^11.3.1 / ^10.1.3 |
| Конфиг | dotenv | ^17.2.3 |

`tsconfig.json`: `strict`, `noEmit`, `moduleResolution: bundler`,
`allowImportingTsExtensions`. В проде рантайм — esbuild-бандл `dist/bot.js`, не `tsx`.

### Фронтенд (`pwa/`)

| Слой | Технология | Версия |
|---|---|---|
| UI | react / react-dom | 18.3.1 |
| Анимации | framer-motion | 14.0.0 |
| Иконки | lucide-react | 1.54.0 |
| Классы | clsx + tailwind-merge | 2.1.1 / 3.7.0 |
| Сборка | vite | 8.3.4 (Rolldown) |
| Стили | tailwindcss + @tailwindcss/vite | 4.3.3 |
| TS | typescript | 7.0.2 |
| React-типы | @types/react | ^19.3.0 (**при react 18**) |

Особенности сборки:
- `vite.config.ts` — alias `@` → `./src`; `server.allowedHosts` для туннелей;
  dev-прокси `/api` → `VITE_API_TARGET` (по умолчанию `http://127.0.0.1:3000`);
  `manualChunks` для `react` и `icons`.
- Tailwind 4 подключён **только плагином Vite**: `tailwind.config.js` и
  `postcss.config` отсутствуют, дизайн-система — в `src/index.css`.
- `build` = `tsc --noEmit && vite build && inject-sw-version`.

### Внешние сервисы

| Сервис | Адрес | Назначение |
|---|---|---|
| РУЗ / расписание МЭИ | `https://ts.mpei.ru/api` | поиск группы, выгрузка расписания |
| Личный кабинет БАРС | `https://bars.mpei.ru/bars_web/` | авторизация, оценки, пропуски, приказы, стипендия, НТБ, рейтинг |
| Почта ОСЭП (OWA) | `https://mail.mpei.ru/owa` (HTTPS, FBA) | вход формой и скрапинг писем |
| Почта ОСЭП (IMAP) | `mail.mpei.ru:993` | НЕ используется: режется TMG (RST) |
| Веб-почта ОСЭП | `https://mail.mpei.ru` | ссылка из бота (в PWA кнопка web-почты убрана) |
| Веб-версия (PWA) | `PWA_URL` (HTTPS) | React-приложение |

---

## 4. Структура проекта

```text
Hub/
├── bot.ts                      # dotenv + initTelegramBot()
├── package.json                # зависимости и npm-скрипты
├── tsconfig.json               # строгая конфигурация TS
├── info.md                     # этот документ
├── run.sh                      # локальный запуск
├── .env                        # секреты (в git не попадает)
├── data/                       # «база» (JSON, атомарная запись, права 0600)
│   ├── users.json              # пользователи по userId, профили, креды, куки, PWA-токены
│   ├── homework.json           # домашние задания
│   ├── important.json          # объявления группы
│   ├── bars_snapshots.json     # снимки БАРС для фоновых уведомлений (ключ — userId)
│   ├── files/<userId>/         # файлы: <fileId>.bin, <fileId>.meta.json, <fileId>.preview-<w>.jpg
│   └── backup/<метка>/         # копии перед сбросом базы (npm run reset:db)
├── deploy/                     # systemd-юнит и journald.conf
├── dist/bot.js                 # esbuild-бандл (прод)
├── scratch/                    # HTML-дампы БАРС, schedule_raw.json для тестов
├── scripts/                    # тестовые и отладочные скрипты (37 файлов)
├── src/
│   ├── bot/                    # 1 285 строк — Telegram-слой (тонкий)
│   │   ├── telegramService.ts  #   grammY: запуск, 4 обработчика, нотификатор, API, deep link
│   │   ├── botEngine.ts        #   маршрутизация: /start, /start <userId>, /app, callbacks
│   │   ├── pwaView.ts          #   экраны: приветствие/привязка/уведомления/«аккаунт не найден»
│   │   ├── format.ts           #   HTML-разметка, esc/b/i/link, RULE, safeErrorMessage
│   │   ├── scheduleCache.ts    #   двухуровневый кэш расписания с дедупликацией
│   │   ├── homeworkManager.ts  #   поиск будущей пары для ДЗ (findNextLesson)
│   │   ├── gradeCalculator.ts  #   средневзвешенный балл по КМ (buildSubjectReport)
│   │   └── telegramFileDownload.ts # санный file_id → буфер (для fileStore)
│   ├── parser/                 #   735 строк — расписание МЭИ
│   │   ├── types.ts            #     интерфейсы сырого API и разобранного расписания
│   │   ├── mpeiApi.ts          #     HTTP-клиент к ts.mpei.ru, поиск группы
│   │   └── scheduleParser.ts   #     группировка сырых пар по дням и слотам
│   ├── server/                 # 3 120 строк — REST API для PWA
│   │   ├── index.ts            #     сборка Fastify, CORS, multipart, хук авторизации, /health, замеры
│   │   ├── types.ts            #     контракты API (источник правды для клиента)
│   │   ├── middleware/auth.ts  #     проверка X-PWA-Token, requireBars, requireUser, requireUserId
│   │   └── routes/
│   │       ├── auth.ts             #   login/register/2fa/logout/refresh/me/config, /api/bootstrap
│   │       ├── schedule.ts         #   /api/schedule, /api/subjects
│   │       ├── bars.ts             #   оценки, пропуски, /api/bars/more, /api/bars/refresh
│   │       ├── mail.ts             #   превью почты из mailPreviewCache (без IMAP)
│   │       ├── homework.ts         #   CRUD ДЗ
│   │       ├── important.ts        #   CRUD объявлений
│   │       ├── notifications.ts    #   /api/notifications/toggle, /state
│   │       ├── recordFiles.ts      #   привязка файлов: только свои, дедуп, потолки
│   │       ├── studentContext.ts   #   группа студента, GroupNotReadyError
│   │       └── scheduleCacheBridge.ts # мост к кэшу расписания
│   ├── services/               # 3 915 строк — внешние системы
│   │   ├── bars/
│   │   │   ├── barsClient.ts   #     HTTP+cookiejar клиент, живость сессии
│   │   │   ├── barsAuth.ts     #     вход: логин → пароль → 2FA, сохранение сессии
│   │   │   ├── barsScraper.ts  #     загрузка разделов ЛК
│   │   │   ├── barsService.ts  #     фасад с изоляцией ошибок
│   │   │   ├── barsServiceFactory.ts # кэш клиентов в памяти, readBarsCredentials
│   │   │   ├── barsSnapshotCache.ts # снимок БАРС в памяти, SWR, summarizeAcademic
│   │   │   ├── index.ts
│   │   │   └── parsers/        #     grades, attendance, studentInfo, rating
│   │   ├── mail/
│   │   │   ├── owaMailClient.ts #   OWA-скрапинг (axios+tough-cookie), вход FBA, canary
│   │   │   ├── mailErrors.ts    #   MailUnreachable/Auth/Timeout
│   │   │   ├── mailPreviewCache.ts # превью почты в памяти (пишет нотификатор/маршрут)
│   │   │   ├── osepMailClient.ts #   @deprecated IMAP-клиент (не используется)
│   │   │   ├── types.ts, index.ts
│   │   └── notifications/
│   │       ├── barsNotifier.ts #     фоновый опрос + диффы + уведомления
│   │       └── pollSchedule.ts #     график частот опроса по источникам
│   ├── storage/                #   1 338 строк
│   │   ├── userStore.ts        #     пользователи по userId, индексы, PWA-токены
│   │   ├── fileStore.ts        #     файлы на диске: сохранение, чтение, квоты, MIME
│   │   ├── filePreview.ts      #     превью изображений через ленивый sharp
│   │   ├── homeworkStore.ts    #     ДЗ, выборка по слотам, изоляция по группам
│   │   ├── importantStore.ts   #     объявления
│   │   └── snapshotStore.ts    #     снимки для уведомлений (stage/flush), ключ — userId
│   └── utils/                  #   801 строка
│       ├── jsonStore.ts        #     JsonStore + JsonDocument, атомарная запись, права 0600
│       ├── crypto.ts           #     AES-256-GCM для кредов БАРС
│       ├── time.ts             #     московское время, конвертация дат
│       ├── pwaAuth.ts          #     выпуск и проверка PWA-токена (base64url + HMAC)
│       ├── barsLoginHash.ts    #     sha256 от нормализованного логина БАРС
│       └── loginLimiter.ts     #     антибрутфорс по адресу клиента и по логину БАРС
├── pwa/                        # 10 384 строки — веб-приложение (React + PWA)
│   ├── package.json, vite.config.ts, tsconfig.json, index.html
│   ├── README.md, nginx.conf.example
│   ├── scripts/                # gen-icons, inject-sw-version, dev-tunnel
│   ├── public/                 # sw.js, offline.html, robots.txt, manifest
│   └── src/
│       ├── main.tsx, App.tsx, index.css, styles.css
│       ├── auth.ts             #   хранение токена, вход, 2FA, выход
│       ├── sw-register.ts      #   регистрация Service Worker и тост обновления
│       ├── diagnostics.ts, DiagnosticsScreen.tsx #  fps/long tasks за ?debug=1
│       ├── app/ScheduleApp.tsx #   оболочка: вкладки, bootstrap, диалог добавления
│       ├── lib/     api/ (http, files, index), env.ts, dataContext.tsx + data/ (context, tier1, tier2),
│       │            fileCache.ts, lastDay.ts, perf.ts, viewport.ts, dates.ts, cn.ts, format.ts
│       ├── components/  InstallPrompt, TabBar, WeekStrip, ui, Page, Pager,
│       │                AddRecordSheet, FileAttachmentList, FilePreview (только миниатюра),
│       │                InAppBrowser (просмотр фото), RecordDetailScreen, profile/, schedule/, tasks/
│       ├── pages/       SchedulePage, SubjectScreen, GradesPage, TasksPage, ProfilePage
│       └── types/       api.ts, vite-env.d.ts, assets.d.ts
└── scripts/                    # тесты и отладка
```

### Объём кода

| Раздел | Строк |
|---|---|
| `pwa/src` | 10 384 |
| `src/services` | 3 915 |
| `src/server` | 3 120 |
| `src/storage` | 1 338 |
| `src/bot` | 1 285 |
| `src/utils` | 801 |
| `src/parser` | 735 |
| **Итого backend** | **11 194** |

Самые большие файлы: `InAppBrowser.tsx` (876), `SchedulePage.tsx` (632),
`AddRecordSheet.tsx` (615), `userStore.ts` (521), `ProfilePage.tsx` (385),
`TasksPage.tsx` (352), `data/context.tsx` (352), `data/tier1.ts` (334),
`WeekStrip.tsx` (392). Крупные модули сервера разложены на подмодули
(`barsSnapshot/`, `notifier/`, `userStore/`), поэтому «толстые» файлы-фасады
короткие.

---

## 5. Telegram-бот как push-канал

### 5.1 `telegramService.ts` (276 строк)

`initTelegramBot()`:
1. Читает `TELEGRAM_BOT_TOKEN`; при пустом/заглушке — пишет сообщение и
   **возвращается без исключения** (процесс продолжает жить ради API).
2. `new Bot(token)`, `botInstance = bot`.
3. `setNotificationSender(...)` — регистрирует отправителя фоновых уведомлений
   (новое сообщение с кнопкой `notif_dismiss`).
4. `bot.catch(...)` — последняя защита необработанных апдейтов.
5. `bot.command('app')` → `buildPwaOpenView` (регистрируется **до** общего текста).
6. `bot.on('message:text')` → `processTelegramMessage`.
7. `bot.on('callback_query:data')` → `notif_dismiss` (удалить сообщение),
   `app_back_to_menu` (удалить сообщение с кнопкой), иначе
   `processTelegramCallback` + `editMessageText`.
8. Если задан `API_PORT` — ленивый `await import('../server/index.ts')` +
   `startServer()`; ошибка ловится и не роняет бота.
9. `bot.api.getMe()` → `botUsername`.
10. `startNotifier()` — фоновый воркер.
11. `SIGTERM`/`SIGINT` → `flushSnapshots()` + `exit(0)`.
12. `bot.start({ onStart })` — long polling.

Экспорты: `getBotInstance()` (нужен `telegramFileDownload`), `getBotUsername()`,
`botDeepLink(userId)` — собирает `https://t.me/<bot>?start=<userId>` из
`TELEGRAM_BOT_USERNAME` или из `getMe()`.

### 5.2 `botEngine.ts` (148 строк)

Маршрутизация. Четыре исхода — приветствие, привязка, включение/выключение
уведомлений.

`processTelegramMessage`:
- `/start <userId>` (UUID проверяется строго) → если запись есть, `linkTelegram`,
  иначе `buildAccountNotFoundView`;
- любой другой текст (`/start` без аргумента, `/app`, мусор) → `buildAlreadyLinkedView`
  для привязанного, иначе `buildWelcomeView`.

`processTelegramCallback`:
- `notif_on` / `notif_off` → `patchByUserId(userId, { notificationsEnabled })`;
- `pwa_open`, `app_back_to_menu`, всё прочее → тот же экран приветствия.

`linkTelegram(telegramId, userId)` обрабатывает переезд: если этот Telegram уже
привязан к другой записи, старая отвязывается и её уведомления выключаются
(`telegramId: null`, `notificationsEnabled: false`).

**Бот не создаёт записи в базе:** её заводит PWA при входе логином БАРС. `/start`
без адреса не создаёт пользователя — иначе любой случайный человек попал бы в
`users.json` без авторизации.

### 5.3 `pwaView.ts` (213 строк)

Экраны: `buildWelcomeView`, `buildAlreadyLinkedView`, `buildNotificationsOnView`,
`buildNotificationsOffView`, `buildAccountNotFoundView`, `buildPwaOpenView`.
`getPwaUrl()` — корень `PWA_URL` без хвостового слэша или `null`.
Кнопки собираются здесь же (`InlineButton`), стиль — `danger` / `success` /
`primary` (палитра сокращена с 17 тонов до трёх).

### 5.4 `telegramFileDownload.ts` (47 строк)

`downloadTelegramFile(fileId)` — `getFile` + содержимое по
`https://api.telegram.org/file/bot<token>/<file_path>`. Остался только для
`fileStore.saveTelegramFile`; приём файлов из чата как сценарий удалён.

---

## 6. Форматирование текста

`src/bot/format.ts` (184 строки). Всё сообщение — HTML-режим.

| Экспорт | Что делает |
|---|---|
| `esc(value)` | `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` |
| `b` / `i` / `code` | `<b>` / `<i>` / `<code>` |
| `link(url, text)` | `<a href>`; href не экранируется, из него вырезаются `["'\s<>]` |
| `quote` / `expandableQuote` | `<blockquote>` / `<blockquote expandable>` |
| `joinBlocks(blocks)` | фильтрует пустые строки, склеивает `\n\n` |
| `makeRecordId(prefix)` | `` `${prefix}_${randomUUID()}` `` (`hw_`/`imp_`) |
| `collapseWhitespace` / `truncate` | схлопывание пробелов, обрезка с `…` |
| `safeErrorMessage(err, max=200)` | URL/host:port/пути/email → «адрес»/«путь», длинные токены → `…` |
| `fmtNum(value)` | `'—'` для null, иначе `String(value).replace('.', ',')` |
| `RULE` | 12 `━`, склеенных WORD JOINER (U+2060) |
| `RULE_CELL_WIDTH` | `RULE_LENGTH * 2` = 24 |

RULE сокращён до 14 ячеек и склеен неразрывными WORD JOINER, чтобы не переносился
на узком экране Telegram. `npm run test:html` проверяет баланс тегов во всех
экранах.

---

## 7. Авторизация в БАРС и вход в PWA

### 7.1 Вход в PWA (`src/server/routes/auth.ts`, `pwa/src/auth.ts`)

Единственный способ входа — **логин и пароль БАРС**. Отдельного шага
«регистрация» нет: `POST /api/auth/login` заводит запись, если её ещё нет.
`/api/auth/register` оставлен алиасом на `login` (для развёрнутых сборок в кэше SW).

`performLogin` (сервер):
1. Антибрутфорс до сети: `checkLoginAllowed` — при блокировке в БАРС не ходим.
2. `existing = userStore.getByBarsLoginHash(hash)`. **Проверка `account_conflict`
   удалена**: вход в аккаунт, привязанный к Telegram, разрешён, запись переиспользуется.
3. `startLoginAttempt` — `new BarsClient()` + `login({ on2FACodeNeeded })` в фоне,
   гонка трёх исходов (`done` / `two_factor` / таймаут `LOGIN_ATTEMPT_TIMEOUT_MS` = 45 с).
4. Ошибка/неверный пароль → `registerLoginFailure` + 401 `invalid_credentials`.
5. Успех → `registerLoginSuccess` + `completeRegistration`.

`completeRegistration`:
- ФИО, зачётка, группа; `searchGroupOnMpei` находит `groupId`;
- логин и пароль шифруются AES-256-GCM **раздельно** (свои IV/tag у каждого);
- `barsAuth = { encryptedLogin, encryptedPass, iv, tag, ivPass, tagPass, cookiesJson, savedAt }`;
- `studentProfile = { fullName, recordBookNumber, groupName }`, `authState = null`;
- `forgetBarsClient` — новый вход вытесняет старый клиент;
- `userId` при повторном входе **не меняется**.

`2FA`: `POST /api/auth/2fa` доносит код до того же висящего промиса входа
(`pendingLogins`, TTL 10 минут). Ожидание на клиенте — 5 минут
(`TWO_FA_WAIT_MS` в `App.tsx`): по истечении экран сам возвращается к логину.

Токен PWA — `base64url(userId).base64url(expiresAt).base64url(HMAC-SHA256)`,
TTL 90 дней (`PWA_TOKEN_TTL_MS`). Сервер хранит **только `sha256(token)`** в
`user.pwaTokens`. `POST /api/auth/logout` отзывает ровно текущий токен;
`POST /api/auth/refresh` выпускает новый (старый хэш удаляется).

`AuthError` несёт HTTP-код, машинное имя и (для брутфорса) `retryAfterMs`.
Клиент различает `invalid_credentials`, `need_2fa`, `too_many_attempts` по имени.

### 7.2 Полный вход БАРС (`barsAuth.ts`) — пять шагов

| Шаг | Действие |
|---|---|
| `[1/5]` | `GET /bars_web/`; если уже дашборд — извлечь профиль и вернуть успех |
| `[2/5]` | `POST` формы: скрытые поля + `Account` + `Password` + `RememberMe=false` |
| `[3/5]` | разбор `af2_code_send`, затем `GET .../JSON_SendAF2_Code?tid=…` |
| `[3a/5]` | проверка `{success: true}` |
| `[4/5]` | `await on2FACodeNeeded(...)` — бот/приложение спрашивают код |
| `[5/5]` | `POST` кода; проверка, что страница стала дашбордом |

Сохранение сессии — `writeFile` с `mode: 0o600, flag: 'wx'` (O_EXCL).

### 7.3 Контроль живости сессии

`BarsClient.assertSessionAlive(finalUrl, $)` бросает `SessionExpiredError`, если URL
содержит `/auth/login`, `/account/login`, `returnurl=`, `/auth/logincode`; разметка
содержит `input[name=Password]`, `input#Password`, `input[name=AF2_Code]`,
`input#AF2_Code`; `title` — «авторизация»/«вход в систему»/«вход».

Последствия: в API — 401 `session_expired` + `userStore.clearAuth`; в нотификаторе —
`clearAuth` + `snapshotStore.remove` + `forgetBarsClient`.

### 7.4 Кэш `BarsClient` в памяти (`barsServiceFactory.ts`)

`CachedBarsClient = { service, sessionKey, usedAt, inflight }`, TTL 30 минут,
потолок 60 клиентов, LRU. `sessionFingerprint` — первые 512 символов
`${savedAt}:${cookiesJson.length}:${cookiesJson}`: смена сессии вытесняет клиент.
Дедупликация: параллельные вызовы получают один `inflight`, второй temp-файл не
пишется. `readBarsCredentials(user)` расшифровывает логин и пароль (fallback
`iv`/`tag` → `ivPass`/`tagPass` для старых записей).

---

## 8. Антибрутфорс-лимитер входа

`src/utils/loginLimiter.ts` (184 строки). Используется в API (`routes/auth.ts`).

| Константа | Значение |
|---|---|
| `MAX_FAILURES` | 5 |
| `WINDOW_MS` | 15 мин |
| `BLOCK_MS` | 15 мин |
| `MAX_BLOCK_MS` | 6 ч |
| `MAX_TRACKED` | 10 000 ключей |

**Две оси:** `byOwner` (в боте — Telegram ID, в PWA — адрес клиента) и `byLogin`
(нормализованный логин БАРС). Алгоритм: `checkLoginAllowed` — только чтение;
`registerLoginFailure` при `failures >= 5` даёт блокировку `BLOCK_MS·2^(strikes-1)`
с потолком 6 ч (15→30→60→120→240→360 мин); `registerLoginSuccess` удаляет оба
бакета. `formatRetryAfter` — `max(1, ceil(ms/60000))` с русской плюрализацией.
Состояние только в памяти процесса; уборка раз в 5 минут.

---

## 9. Расписание МЭИ

### 9.1 Поиск группы (`mpeiApi.searchGroupOnMpei`)

1. Пустой ввод → ошибка.
2. `GET /api/search?term={query}&type=group` (`AbortSignal.timeout(MPEI_TIMEOUT_MS=20s)`).
3. Если пусто — повтор с латиница→кириллица (`latinToCyrillicLookalikes`, 12 букв,
   `a b e k m h o p c t y x` → `а в е к м н о р с т у х`).
4. Точное совпадение (два варианта) → ровно одна группа → совпадение после
   удаления не-буквенно-цифровых → иначе ошибка + до 10 подсказок.

`normalizeGroupString` — trim и длинные тире (`— – −`) → `-`.

### 9.2 Загрузка

`fetchScheduleFromMpei(groupId, {start, finish})`:
`GET /api/schedule/group/{groupId}?start=YYYY.MM.DD&finish=YYYY.MM.DD&lng=1`,
тот же таймаут 20 с. Окно дат — **−14 … +90 дней** (`scheduleCache.getScheduleDateRange`).

### 9.3 Разбор (`scheduleParser.parseSchedule`)

- Сырые записи сортируются **на месте** по `date` → `lessonNumberStart` → `beginLesson` → `subGroup`.
- Группировка по `date`, внутри дня — по ключу слота
  `${lessonNumberStart}_${beginLesson}_${endLesson}`.
- Вариант содержит: `discipline`, `kindOfWork`, `auditorium`, `building`,
  `auditoriumCapacity` (>0), `lecturerShort/FullName/Rank`, `allLecturers`,
  `subgroup`, `stream`, `jointGroups` (исключая свою группу), `onlineUrls` (до двух
  из `url1`/`url2`), `note`, `replaces`, `duration`, `timetableName`.
- `cleanString` → заглушки `!Не определена`/`!Вакансия` — `undefined`.
- `extractLecturers` — из `listOfLecturers` с fallback на `lecturer`/`lecturer_title`/`lecturer_rank`.

`ParsedSchedule = { groupName, groupId, facultyName, parentScheduleName, courseNumber?, totalLessons, dateRange, days[] }`.

---

## 10. Кэш расписания

`src/bot/scheduleCache.ts` (243 строки). Используется и API (`/api/schedule`,
`/api/subjects`, bootstrap), и другими сервисами.

| Константа | Значение |
|---|---|
| `HOT_TTL_MS` | 3 мин |
| `COLD_TTL_MS` | 45 мин |
| `MAX_GROUPS` | 50 (≈12 МБ при 0.24 МБ/группу) |

Две карты по `groupId`: `byHot` (`CacheEntry { schedule, hotAt, coldAt, bytes }`) и
`loadState` (`{ fetchedAt, bytes, inflight }`).

- `getGroupSchedule` — горячий слой → возврат; холодный (данные свежие, страницу
  давно не открывали) → `hotAt = now` **без повторного разбора**; иначе `load`.
- `load` — **дедупликация in-flight**: параллельные запросы получают один промис;
  в `catch` `inflight` обязательно сбрасывается.
- `evict` — сначала просроченные по холодному TTL, затем LRU до `MAX_GROUPS`.
- `clearScheduleCache(groupId?)` — с аргументом одну группу, без — всё.
- `scheduleCacheStats()` — только для тестов.

Кэш чистится при `force` в `/api/schedule`; персистентности нет.

---

## 11. Домашние задания

### 11.1 Поиск пары (`homeworkManager.findNextLesson`)

Разбор свободного текста «предмет л/п/лаб текст» **удалён** вместе с ботом-интерфейсом.
Осталось только то, что нужно API: поиск ближайшей пары.

- Время приводится к Москве (`toMoscow().rawDate`).
- Дни с `rawDate <= сегодня` пропускаются: ДЗ цепляется к **следующей** паре.
- `matchesKind`: `lecture` — только лекции; `lab` — только лабораторные;
  `practice` — всё, что не лекция, не лабораторная и не
  `экзам|консульт|зач[её]т|аттестац`.
- Возвращает `{ day, slot, variant }` или `null`.

### 11.2 Хранилище (`homeworkStore.ts`)

`HomeworkRecord = { id, groupName, discipline, kind: 'lecture'|'practice'|'lab',
targetDate, lessonNumber?, timeStart?, text, files: ServerFileRef[], authorId?, authorName?, createdAt }`.

Методы: `get`, `getForGroupAndId(groupName, id)`, `deleteForGroupAndId`,
`save`, `delete`, `all`, `getForGroup(groupName)`, `getUpcoming(groupName, fromRawDate)`,
`getForSlot(groupName, rawDate, lessonNumber, disciplines[])`. Изоляция по группе —
`sameGroup` = `trim().toLowerCase()`; пустая группа не видит ничего.

---

## 12. «Важное» (объявления группы)

`ImportantMessage = { id, groupName, title, text, files, authorName?, authorId?, createdAt }`.

`importantStore`: `get`, `getForGroupAndId`, `deleteForGroupAndId`, `getForGroup`
(новые сверху), `all`, `save`, `delete`. Та же изоляция по группе, что и в ДЗ.

Формы ввода/заголовки/удаление теперь живут в PWA (`TasksPage` + `AddRecordSheet`),
в боте объявлений нет.

---

## 13. Сервисы личного кабинета БАРС

### 13.1 Скрапер (`barsScraper.ts`)

`BarsScraper` грузит разделы ЛК и парсит их:
- `getCurrentSemesterGrades()` — `session.finalUrl` или `/bars_web/ST_Study/Main/Main`;
- `getAttendance()` — `/bars_web/ST_Study/Main/Summary?studentID=…`;
- `getOrders()` — `/bars_web/ST_LK/Order/ListStudent__Order`;
- `getScholarship()` — `/bars_web/ST_LK/ScholarshipEvent/ListStudent__ScholarshipEvent`;
- `getLibraryBooks()` — `/bars_web/ST_LIB/BookCopy/ListStudent__BookCopy`;
- `getRating()` — `/bars_web/ST_LK/Score/ListScore` (разделы `ST_PartN1…N6` давали
  один и тот же общий балл, поэтому источник сменён на страницу «Оценки»).

### 13.2 Парсеры

- **grades** (`gradesParser.parseGradesPage`): семестр из
  `select#ddl_StudyFilterSemester`; дисциплины — `[id^="s_ss_"]` кроме `s_ss_All`;
  **строки КМ = `tds.length === 4`** (название/вес/срок/оценка); `Балл текущего
  контроля:` → `totalScore`; `Контрольная неделя №` → `weekScores`;
  `Итоговая оценка:` → `finalGrade`. `parseControlType` →
  `Зачет | Диф. зачет | Экзамен | Неизвестно`.
- **attendance** (`attendanceParser.parseAttendancePage`):
  `ACADEMIC_HOURS_PER_LESSON = 2` (БАРС отдаёт количество ЗАНЯТИЙ, не часов);
  таблица `#tableSkipSummary` или первая с «Дисциплина»; сводка из карточек.
- **studentInfo** (`studentInfoParser`): `parseOrders`, `parseScholarship`,
  `parseLibrary` — каждая с таблицей по id и текстовым резервом.
- **rating** (`ratingParser.parseScorePage`): колонки «Период | Учебная
  деятельность | Учеба, прочее |» + семь разделов по паре значений; `PART_KEYS`
  фиксирует порядок (academic, research, public, creative, sport, disciplinary,
  comprehensive).

### 13.3 Фасад (`barsService.ts`)

`getFullStudentProfile()` — `Promise.allSettled` по пяти разделам; каждый отказ даёт
`warnings.push(...)` и заглушку (оценки — пустые, пропуски — нули, приказы — `[]`,
стипендия — `{ isAppointed: false }`, книги — `[]`).

### 13.4 Калькулятор (`gradeCalculator.ts`)

- `weightedAverage(points)`: `null`-оценки исключаются полностью; сумма весов
  нормализуется на `weightSum`; если весов нет у всех закрытых КМ — обычное
  среднее; округление до 2 знаков.
- `buildSubjectReport(subject)` → `currentAverage`, `barsAverage` (= `totalScore`),
  `gradedWeight`, `totalWeight`, `totalCount`, `gradedCount`, `pendingCount`,
  `controlPoints`, `finalGrade`.
- `buildSemesterReport(subjects)` — от худшего среднего к лучшему.

### 13.5 Снимок БАРС (`barsSnapshotCache.ts`)

`SNAPSHOT_TTL_MS = 20 мин`, `MAX_SNAPSHOTS = 500`, `MAIL_PREVIEW_LIMIT = 8`.
`getBarsSnapshot(userId, barsService, mailClient, { force })`:
свежий снимок → сразу; протухший → сразу + фоновое обновление
(stale-while-revalidate); при `force` ждёт свежий; дедупликация in-flight.

`loadSnapshot` собирает `grades`, `attendance`, `more` (обязательные, ошибка
пробрасывается). **Почта в снимок не входит**: `mailClient` теперь всегда `null`
(её собирает нотификатор в `mailPreviewCache`), `snapshot.mail` = `null`,
`snapshot.mailError` = `null`. `summarizeAcademic`: задолженность — **только
двойки** (`raw <= 2`), незакрытые КМ (`score === null`) не считаются ни
задолженностью, ни распределением; дробные округляются `Math.floor` вниз.
`peekBarsSnapshot(userId)` — из памяти без загрузки.
`invalidateBarsSnapshot(userId)` — при истечении сессии.

---

## 14. Файлы на сервере

### 14.1 Хранилище (`fileStore.ts`, 307 строк)

```text
data/files/<userId>/                 # права 0700
├── <fileId>.bin                     # содержимое, 0600
├── <fileId>.meta.json               # ServerFileRef, 0600
└── <fileId>.preview-<width>.jpg     # превью изображения (по требованию)
```

| Константа | Значение |
|---|---|
| `MAX_FILE_SIZE_BYTES` | 20 МБ |
| `MAX_FILES_PER_RECORD` | 10 |
| `MAX_USER_STORAGE_BYTES` | 500 МБ |
| `ALLOWED_MIME_TYPES` | jpeg, png, webp, gif, heic, heif, pdf, txt |

`ServerFileRef = { fileId, originalName, mimeType, size, sha256, uploadedBy, uploadedAt }`.
Проверяются обе стороны типа (MIME и расширение). `sanitizeFileName` срезает путь и
управляющие символы; на диск имя не идёт — там UUID. Запись через tmp + `rename`.
Функции: `saveFile`, `getFile`, `deleteFile`, `deleteAllFiles`,
`getUserStorageUsage`, `enforceQuota`, `saveTelegramFile` (Bot API → буфер → `saveFile`),
`FILES_ROOT`.

### 14.2 Превью (`filePreview.ts`, 165 строк)

`getPreview(userId, fileId, width)` — `<fileId>.preview-<w>.jpg` рядом с оригиналом;
`sharp` грузится **лениво** (тяжёлый бинарник), при отсутствии — `PreviewUnavailableError`.
`DEFAULT_PREVIEW_WIDTH = 800`, границы 128…2000, JPEG quality 80. Квота
пользователя на превью не растёт. `isPreviewable`, `normalizePreviewWidth`.

### 14.3 Маршруты (`routes/files.ts`, ~470 строк)

- `POST /api/files/upload` — multipart, один файл. Квота проверяется до чтения
  потока; превышение размера (>20 МБ, включая ошибку `@fastify/multipart`
  `FST_REQ_FILE_TOO_LARGE`), квоты или недопустимый тип → 413 `file_rejected`.
- `GET /api/files/:fileId` — `requireUser` (не `requireBars`: файл адресуется по
  `userId` и не зависит от сессии БАРС), `Content-Type`/`Length`/`Disposition`
  (RFC 6261), `Cache-Control: private, max-age=31536000, immutable`,
  `X-Content-Type-Options: nosniff`, поддержка `Range` (206) и 416.
- `GET /api/files/:fileId/preview?w=800` — превью (415 не-изображение, 503 sharp).
- `GET /api/files/:fileId/meta`, `DELETE /api/files/:fileId` (409 `file_in_use`).
- `POST /api/files/:fileId/share` → `GET /api/files/share/:token` — короткоживущая
  share-ссылка (inline) для открытия файла в системном браузере. PWA заранее
  создаёт ссылки для PDF и открывает их в отдельной вкладке.

Файлы и превью отдаются через `streamFile()`: у read-stream обязательно висит
слушатель `error`. Без него обрыв скачивания клиентом (уход со страницы) даёт
`EPIPE`/`ERR_STREAM_PREMATURE_CLOSE` вне обработчика — это uncaught и падение
всего процесса (бот+API вместе).

### 14.4 Выдача файлов в PWA

Клиент получает файлы через API. **Фото** открываются во встроенном
`InAppBrowser` (превью-первый кадр, зум, свайп по соседям). **PDF** открываются
в отдельной вкладке браузерным PDF-просмотрщиком через короткоживущую inline
share-ссылку; ссылки готовятся заранее, чтобы Safari не блокировал открытие как
popup после сетевого запроса. Исходная вкладка PWA остаётся на месте. Word и
прочее отдаются системе через системное «Поделиться»/сохранение. Схема «файл в
Telegram-канале» удалена полностью.

---

## 15. Хранилище данных

### 15.1 Движок (`utils/jsonStore.ts`, 194 строки)

Два класса:

- `JsonStore<T>` — плоская карта «ключ → запись» для `homework.json`,
  `important.json`, `bars_snapshots.json`. `set`/`delete` пишут сразу, `stage`/`remove`
  — только в кэш (батчинг), сброс — `save()`.
- `JsonDocument<T>` — документ с произвольной формой и разделами для `users.json`.
  `read()`, `stage(doc)`, `save()`, `replace(doc)`, `drop()`, `path`.

Оба: `DIR_MODE = 0o700`, `FILE_MODE = 0o600`, `hardenPermissions()`,
`mkdirSync` → запись в `${file}.tmp` → `fs.renameSync(tmp, file)`. Нет `fsync`, нет
межпроцессных блокировок (процесс один).

### 15.2 `data/users.json`

Документ `{ users: Record<userId, StoredUser>, index: { byTelegramId, byBarsLoginHash } }`.

`StoredUser`: `userId`, `barsLoginHash`, `telegramId?: number | null`,
`notificationsEnabled?: boolean`, `firstName`, `lastName?`, `username?`, `groupName?`,
`groupId?`, `faculty?`, `createdAt`, `updatedAt`, `mainMessageId?` (наследие),
`replyKeyboardSent?` (наследие), `barsAuth?`, `studentProfile?`, `authState?`,
`tempAuthData?`, `barsAuthedAt?`, `pwaTokens?`, `pushSubscriptions?`.

Методы `userStore`: `getByUserId`, `get`, `getByBarsLoginHash`, `getByBarsLogin`,
`all`, `create`, `save`, `patch(key: number|string, ...)`, `patchByUserId`,
`findUserByTelegramId`, `ensureByTelegramId`/`ensureUser`, `remove`,
`clearAuth` (убирает БАРС-данные, ставит `AWAIT_LOGIN`), `logoutBarsAccount` (то же
+ снимает `telegramId`), методы главного сообщения, работа с `pwaTokens`
(`addToken`/`revokeToken`/`hasToken`/`touchToken`/`pruneTokens`), `reset`, `filePath`.

`reindex(doc)` пересобирает оба индекса после любой операции, меняющей ключи.
`isBarsAuthorized` — `barsAuth` и `studentProfile.fullName`; `isScheduleReady` —
плюс `groupId` > 0.

### 15.3 `data/homework.json`, `data/important.json`

См. §11.2 и §12.

### 15.4 `data/bars_snapshots.json`

Ключ — `userId`. `UserSnapshot = { gradesHash, lastSeenMailUid, ordersCount,
scholarshipStatus, lastCheckedAt }`. `isBaselineSnapshot` — `true`, если снимка нет
или пуст `lastCheckedAt` (первый снимок не порождает уведомлений). `stage` — только
в память + `dirty`; `flush` — **один** `save()` в конце круга.

### 15.5 Сброс базы

`npm run reset:db` — `scripts/reset-db.ts`: копия в `data/backup/<метка>/`,
перезапись пустой формой новой схемы, очистка `data/files`.
`npm run reset:users` — только `users.json` с бэкапом `data/users.backup.json`.

---

## 16. Шифрование кредов

`src/utils/crypto.ts` (147 строк). Шифруется **только** учётка БАРС.

| Параметр | Значение |
|---|---|
| Алгоритм | `aes-256-gcm` |
| Ключ | ровно 32 байта |
| IV | 12 байт, новый на каждое шифрование |
| Auth tag | 16 байт |
| Кодирование | base64 |

Ключ (`normalizeKey`) из `ENCRYPTION_SECRET_KEY`: 64 hex-символа **или** ровно 32
байта UTF-8. **KDF нет** — ключ обязан быть высокоэнтропийным; ротация без миграции
невозможна. Логин и пароль шифруются **раздельно** (свой IV/tag), при чтении —
fallback `iv`/`tag` → `ivPass`/`tagPass`. API: `getEncryptionKey`,
`isEncryptionConfigured`, `encrypt`, `encryptOrThrow`, `decrypt`,
`EncryptionConfigError`.

---

## 17. Почта ОСЭП (OWA-скрапинг)

### 17.1 Почему OWA, а не IMAP

IMAP `mail.mpei.ru:993` режется Forefront TMG: TCP устанавливается, но сервер рвёт
TLS-рукопожатие (`RST` на ClientHello), сертификат не отдаётся; порт 143 не отдаёт
приветствие; `openssl s_client` (TLS 1.2/1.3, `SECLEVEL=0`) — то же. Наружу почта
доступна только как «мёртвый» порт.

Веб-интерфейс `https://mail.mpei.ru/owa` при этом работает: TMG пропускает HTTPS,
вход — обычная форма FBA («частный компьютер»). Поэтому почта читается **OWA-
скрапингом** (`src/services/mail/owaMailClient.ts`). Старый IMAP-клиент
`osepMailClient.ts` помечен `@deprecated` и нигде не используется (оставлен как
историческая реализация). `MAIL_TLS_PIN`/`DEFAULT_TLS_PIN` относятся только к IMAP
и на работу почты больше не влияют.

### 17.2 Клиент OWA (`owaMailClient.ts`)

Стек как у `barsClient.ts`: `axios` + `axios-cookiejar-support` + `tough-cookie`
(НЕ `imapflow`). **Вход проверен на живом сервере** (`GET /owa/` отдаёт форму
`CookieAuth.dll?Logon`). Контракт списка писем (`service.svc` JSON, OWA 2013-стиль)
сверяется с реальными кредами через `OWA_DEBUG=1` — точные action/тело могут
отличаться у сборки МЭИ:

| Шаг | Запрос |
|---|---|
| вход | `GET /owa/` (200, форма `POST /CookieAuth.dll?Logon`; скрытые поля `curl`, `flags`, `forcedownlevel`, `formdir`, `isUtf8`, `chpwd`, `chkBsc`) → `POST /CookieAuth.dll?Logon` (form-urlencoded: скрытые поля + `username`, `password`, `trusted=4` — «частный компьютер») |
| canary | все запросы после входа шлют заголовок `X-OWA-CANARY` со значением одноимённой cookie (иначе 401) |
| счётчики | `POST /owa/service.svc?action=GetFolder&AC=1` (JSON: `folder:UnreadCount`, `folder:TotalCount`) |
| список | `POST /owa/service.svc?action=FindItem&AC=1` (JSON: `Subject`/`DateTimeReceived`/`From`/`HasAttachments`/`IsRead`, `IndexedPageView`) |

Методы: `getInboxStatus() → { total, unread }`;
`fetchMessageBriefs({ limit, onlyUnread? }) → OsepMessageBrief[]`
(`{ uid, date, from, subject, hasAttachments, isSeen }`). `uid` — время получения в
миллисекундах: OWA ItemId сессионный и как ключ диффа «новых писем» не годится.
`serializeCookies()` сохраняет сессию; конструктор принимает `cookiesJson`, чтобы
её переиспользовать. При 401 клиент один раз перелогинивается сам. TLS — строго по
умолчанию; `OWA_TLS_INSECURE=1` отключает проверку (самоподписанный сертификат).

### 17.3 Сессия, креды, маршрут

Сессия OWA хранится **отдельно** от БАРС — `StoredUser.owaAuth = { cookiesJson,
savedAt }` (НЕ смешивается с `barsAuth`; сброс БАРС чистит и её). Креды те же (логин
БАРС): `readOwaCredentials(user)` в `barsServiceFactory.ts`.

Почту обновляет фоновый нотификатор (в `collectState`): переиспользует/поднимает
`owaAuth`, кладёт превью непрочитанных в `mailPreviewCache`, сохраняет свежие
cookies. `GET /api/mail` отдаёт превью; если его ещё нет — делает одноразовый
заход через `OwaMailClient`. Контракт ответа (`MailResponse`) не менялся; ручного
обновления в UI нет.

Ошибки: `MailUnreachableError` (403/TMG) → 503 `mail_unreachable` («Почта
недоступна. Возможно, нужен VPN МЭИ.»); `MailAuthError` (401/неверный пароль) → 401
`mail_session_expired` (+ `clearOwaAuth`, БАРС не трогаем); `MailTimeoutError` → 504.

---

## 18. Фоновые уведомления

`src/services/notifications/barsNotifier.ts` (577 строк).

| Константа | Значение |
|---|---|
| `POLL_INTERVAL_MS` | 20 мин |
| `ACTIVE_FROM_HOUR` / `ACTIVE_TO_HOUR` | 8 / 23 (МСК) |
| `USER_DELAY_MS` / `USER_DELAY_JITTER_MS` | 2 500 / 500 мс |
| `MAX_CONSECUTIVE_FAILURES` | 5 |
| `PER_USER_TIMEOUT_MS` | 60 000 мс |

Первый прогон — через 30 секунд после старта; таймер `unref()`. Обход
последовательный с паузой (anti-ban для МЭИ). 5 сетевых сбоев подряд прерывают
круг. Сервис не знает про grammY: получатель — `NotificationSender`, который
регистрирует `telegramService`.

В круг берутся все авторизованные в БАРС, у кого есть Telegram **или** PWA-токены
(`telegramId !== undefined || pwaTokens.length > 0`) — PWA-пользователю без бота
почту/снимок тоже обновляем, но уведомление шлём только при `telegramId` +
`notificationsEnabled`.

### 18.1 График частот (`pollSchedule.ts`)

`Source = 'mail' | 'grades' | 'info'`. Текущие интервалы — 20 минут каждый
(дефолты дают экономию 0%); `ACTIVE_WITHIN_MS = 48 ч`, `DORMANT_MULTIPLIER = 18`.
Состояние `lastChecked` / `lastActivity` в памяти, не персистится.

### 18.2 Сбор состояния и диффы

`collectState(user, now)`:
- `dueSources` пуст → выход;
- БАРС-джобы по `grades` и `info`; почта — **только если `mail` due**: логин/сессия
  OWA (`readOwaCredentials` + `owaAuth`), затем `fetchMessageBriefs({ onlyUnread:
  false, limit: 15 })`; свежие cookies пишутся обратно в `owaAuth`;
- любая ошибка БАРС пробрасывается — снимок не обновляется;
- **неуспешный OWA не помечается как проверенный**: `fetched` не включает `mail`,
  если `state.mails === null`, поэтому следующий цикл повторит попытку; при
  `MailAuthError` сессия OWA забывается (`clearOwaAuth`) для повторного входа.

`checkUser`: незапрошенные источники сохраняют прежние значения;
`lastSeenMailUid = max(prev, max uid)`; `snapshotStore.stage(...)` вызывается
**всегда**; `markChecked(userId, fetched, now)`. Здесь же из `state.mails`
собирается и кладётся в `mailPreviewCache` превью непрочитанных писем
(`!isSeen`, до `MAIL_PREVIEW_LIMIT`) — это единственный источник почты для
интерфейса. Уведомление отправляется только если `telegramId` — число и
`notificationsEnabled !== false`.

Обработка истечения сессии в `runCycle`: `clearAuth` + `snapshotStore.remove` +
`clearMailPreview` + `forget` + `forgetBarsClient`.

`diffSnapshots` — четыре события: `grade` (ключи `${discipline}_КТ${n}`, дельта
курсивом), `mail` (письма с `uid > prev`, до 5), `order` (рост `ordersCount`),
`scholarship` (смена нормализованного статуса). `renderNotification` собирает
`[title, RULE, ...lines]`.

`isTransientNetworkError` — regex по `ETIMEDOUT|ECONNRESET|…`, HTTP 429/5xx,
«Too Many Requests» и т. п.

Обработка ошибок `runCycle`: при `/сессия/i` или `SessionExpiredError` —
`clearAuth` + `snapshotStore.remove` + `forget` + `forgetBarsClient`; в `finally`
один `snapshotStore.flush()`.

`checkUserNow(key)` — ручной прогон одного пользователя (тесты/диагностика).

---

## 19. REST API для PWA (Fastify)

### 19.1 Сборка (`src/server/index.ts`, 241 строка)

`buildServer()`:
1. `Fastify({ logger: false, bodyLimit: 256 * 1024 })`;
2. `@fastify/multipart` (`fileSize: 20 МБ, files: 1, fields: 4`);
3. `@fastify/cors` (см. ниже);
4. `setupRequestTiming` — замеры (`> 1 с` или `API_PERF_LOG=1`);
5. хук `onRequest` на `/api` → `authHook`, кроме `isPublicApiPath`;
6. `setupErrorHandler`;
7. `GET /health`;
8. роуты: auth → schedule → bars → mail → homework → important → files → notifications.

CORS: `origin` из `PWA_URL` (и `APP_URL`, исторически) + `localhost:5173` /
`127.0.0.1:5173`; запросы без `Origin` пропускаются. `credentials: false`,
`methods: ['GET','POST','PATCH','DELETE','OPTIONS']`,
`allowedHeaders: ['Content-Type','X-PWA-Token']`.

**Открытые маршруты** (`isPublicApiPath`) — ровно `POST /api/auth/login`,
`/api/auth/register`, `/api/auth/2fa`.

Error handler: `AuthError` → `error.code` + `{ error, message, needBarsLogin,
retryAfterMs? }`; `GroupNotReadyError` → 409 `group_not_ready`; `statusCode 400` →
400 `bad_request`; иначе → 500 `internal_error` без деталей.

`startServer()` — `API_PORT ?? 3000`, `API_HOST ?? 127.0.0.1`.

### 19.2 Эндпоинты

| Метод | Путь | Авторизация | Файл |
|---|---|---|---|
| GET | `/health` | — | `index.ts` |
| POST | `/api/auth/login` | — | `routes/auth.ts` |
| POST | `/api/auth/register` | — | `routes/auth.ts` |
| POST | `/api/auth/2fa` | — | `routes/auth.ts` |
| POST | `/api/auth/logout` | токен | `routes/auth.ts` |
| POST | `/api/auth/refresh` | токен | `routes/auth.ts` |
| GET | `/api/auth/me` | токен | `routes/auth.ts` |
| GET | `/api/auth/config` | токен | `routes/auth.ts` |
| GET | `/api/bootstrap` | токен | `routes/auth.ts` |
| GET | `/api/subjects` | токен + БАРС + группа | `routes/schedule.ts` |
| GET | `/api/schedule` | токен + БАРС + группа | `routes/schedule.ts` |
| GET | `/api/bars/grades` | токен + БАРС | `routes/bars.ts` |
| GET | `/api/bars/attendance` | токен + БАРС | `routes/bars.ts` |
| GET | `/api/bars/more` | токен + БАРС | `routes/bars.ts` |
| POST | `/api/bars/refresh` | токен + БАРС | `routes/bars.ts` |
| GET | `/api/mail` | токен + БАРС | `routes/mail.ts` |
| GET | `/api/homework` | токен + БАРС + группа | `routes/homework.ts` |
| POST | `/api/homework` | токен + БАРС + группа + антифлуд | `routes/homework.ts` |
| PATCH | `/api/homework/:id` | токен + БАРС + группа | `routes/homework.ts` |
| DELETE | `/api/homework/:id` | токен + БАРС + группа | `routes/homework.ts` |
| GET | `/api/important` | токен + БАРС + группа | `routes/important.ts` |
| POST | `/api/important` | токен + БАРС + группа + антифлуд | `routes/important.ts` |
| PATCH | `/api/important/:id` | токен + БАРС + группа | `routes/important.ts` |
| DELETE | `/api/important/:id` | токен + БАРС + группа | `routes/important.ts` |
| POST | `/api/files/upload` | токен + БАРС | `routes/files.ts` |
| GET | `/api/files/:fileId` | токен | `routes/files.ts` |
| GET | `/api/files/:fileId/preview` | токен | `routes/files.ts` |
| GET | `/api/files/:fileId/meta` | токен | `routes/files.ts` |
| POST | `/api/files/:fileId/share` | токен | `routes/files.ts` |
| GET | `/api/files/share/:token` | — (токен в URL) | `routes/files.ts` |
| DELETE | `/api/files/:fileId` | токен + БАРС + группа | `routes/files.ts` |
| POST | `/api/notifications/toggle` | токен | `routes/notifications.ts` |
| GET | `/api/notifications/state` | токен | `routes/notifications.ts` |

`GET /api/bootstrap` — `requireUser`; при `barsAuthorized` параллельно
(`Promise.all`, таймаут 2.5 с) проверяются сессия и диапазон расписания; значок
непрочитанных (`mailUnread`) берётся из уже собранного превью (`peekMailPreview`),
а не грузится.

`GET /api/schedule` — `force` включает `clearScheduleCache(groupId)`; даты
фильтруются только при `YYYY.MM.DD`; ДЗ приклеиваются к паре метаданными
(`id, text, authorName, createdAt, fileCount`).

`POST /api/bars/refresh` — `loadBarsSnapshot(student, { force: true })`, возвращает
весь снимок.

`GET /api/bars/more` — пять источников; обязательные `orders/scholarship/books`
пробрасывают причину, необязательные `rating/academic` логируются и заполняются
пустыми структурами. Ошибка БАРС: `SessionExpiredError` → 401 `session_expired`
(+`clearAuth`, `invalidateBarsSnapshot`), иначе 502 `bars_unavailable`.

Антифлуд записи (`homework`/`important`) — **общий** счётчик
`MAX_RECORDS_PER_HOUR = 30` на пользователя в памяти (окно час; ДЗ и «Важное»
вместе, `recordShared.ts`). При превышении — 429 `too_many_requests` с заголовком
`Retry-After` (секунды) и `retryAfterMs` в теле. Лимиты тел: ДЗ 4000,
объявление 120/8000.

Файлы: жёсткий потолок одного файла `MAX_FILE_SIZE_BYTES = 20 МБ` применяется и
на разборе `@fastify/multipart` (лимит берётся из `fileStore`), и в `saveFile`;
превышение → 413 `file_rejected`. Квота пользователя 500 МБ проверяется
**до чтения потока** (`enforceQuota` в начале `POST /api/files/upload`), чтобы
отклонить загрузку сразу.

`requireStudentGroup` бросает `GroupNotReadyError` при пустой группе.
Привязка файлов — `recordFiles.resolveOwnedFiles` (только свои, ≤10, дедуп).

---

## 20. Авторизация API (PWA-токен)

`src/server/middleware/auth.ts` (187 строк).

**Формат токена:** `base64url(userId).base64url(expiresAtMs).base64url(HMAC-SHA256)`.
`utils/pwaAuth.ts`, TTL 90 дней, `PWA_AUTH_SECRET` — отдельный ключ (64 hex или 32
байта UTF-8).

`verifyPwaToken`: формат → декодирование → **подпись** (`timingSafeEqual`) → срок.
Обратный порядок дал бы утечку по времени ответа. Любая неудача — `null`.

`authHook`:
1. извлечь `X-PWA-Token` (префиксы `Bearer`/`Token` отбрасываются);
2. нет токена → 401 `unauthorized`;
3. `verifyPwaToken` → `null` → 401;
4. нет записи пользователя → 401;
5. `sha256(токена)` не в `user.pwaTokens` → 401 («сессия завершена на устройстве»);
6. `req.userId = user.userId; req.student = user`;
7. `touchToken` — не чаще раза в час.

Заголовок, а не query: токен — это пароль.

Помощники: `requireUser` (только сессия), `requireUserId`, `requireBars` (сессия +
зашифрованные креды БАРС), `requireStudentGroup` (непустая группа).

---

## 21. Типы API

`src/server/types.ts` (383 строки) — источник правды; фронтенд импортирует копию
`pwa/src/types/api.ts`.

Основные: `BootstrapProfile`, `BootstrapResponse` (profile, barsAuthorized,
sessionValid, today, weekNumber, scheduleRange, mailUnread), `ApiLessonVariant`,
`ApiLessonHomework`, `ApiLessonSlot`, `ApiScheduleDay`, `ScheduleResponse`,
`ApiControlPoint`, `ApiSubjectGrade`, `GradesResponse`, `ApiSubjectAttendance`,
`AttendanceResponse`, `ApiRatingPart`, `GradeDistribution`, `BarsMoreResponse`,
`ApiMailMessage`, `MailResponse`, `BarsSnapshotResponse`, `ApiHomework`,
`CreateHomeworkBody`, `UpdateHomeworkBody`, `ApiImportant`, `CreateImportantBody`,
`UpdateImportantBody`, `LoginBody`, `PwaTokenResponse`, `ApiError`.

Файлы в типах — `ServerFileRef`, а не telegram `file_id`.

---

## 22. Веб-приложение (React)

### 22.1 Корень и вход (`App.tsx`)

`App` решает, что показать:

| Состояние | Экран |
|---|---|
| `?debug=1` | `DiagnosticsScreen` (fps/long tasks) |
| нужно показать установку | `InstallPrompt` |
| нет рабочего токена | `LoginScreen` (логин/пароль БАРС, шаг 2FA) |
| токен есть | `ScheduleApp` |

Истёкший токен стирается сразу; событие `hub:signed-out` (`SIGNED_OUT_EVENT`)
возвращает на экран входа. Ожидание кода 2FA — 5 минут с обратным отсчётом.
Отдельной фазы «обмен кода» нет.

`auth.ts` — токен в `localStorage` (`hub_pwa_token` + `hub_pwa_token_expires`),
`loginWithPassword`, `confirmTwoFactor`, `logout` (отзывает ровно текущий токен,
ошибка сети игнорируется). `need_2fa` — вторая страница входа, не ошибка.

### 22.2 Оболочка (`app/ScheduleApp.tsx`)

Порядок загрузки: первым показывается расписание (не зависит от БАРС), bootstrap
идёт параллельно и не блокирует его; до прихода профиля используется заглушка
`EMPTY_BOOTSTRAP` и поднимается `DataProvider`. Роутера нет: `TabId =
'schedule'|'grades'|'tasks'|'profile'`, `Shell` условно рендерит одну страницу,
`Tier2Gate` сообщает провайдеру о смене вкладки. Диалог добавления (`AddRecordSheet`)
живёт в `Shell`, поэтому доступен из любой вкладки; после сохранения переключает на
«Задания» и поднимает `listsRevision`.

### 22.3 `lib/env.ts`

Среда браузера: `haptic`, `notify` (no-op), `hapticSelection`, `isTelegram` (false),
`getInitData` (''), `initTelegramApp`, `syncColorScheme`, `closeApp`, `openLink`,
`viewportHeight`, `isDataSaver` (Save-Data / 2G). `initTelegramApp` дополнительно
запрещает масштабирование интерфейса щипком (гашение `gesturestart`/`gesturechange`
и Ctrl+wheel) — кроме вьюера (`data-hub-file-viewer`).

`openLink(url)`: в **standalone-PWA** переходит через `window.location.href`
(выносит пользователя из установленного приложения в Safari); в обычном браузере —
`window.open(url, '_blank', 'noopener')`.

### 22.4 `lib/api.ts` → `lib/api/*`

Базовый URL — относительный `'/api'`. `ApiError` несёт `status`, `needBarsLogin`,
`kind: 'unauthorized' | 'cooldown' | 'conflict' | 'server' | 'network'`.
`request<T>()` — `AbortController`, дефолтный таймаут 20 с, маппинг
401/429/409/server.

Файлы (модуль `lib/api/files.ts`): `fetchFile(fileId)` → `{ url, blob, revoke }`
(объектный URL создаётся на каждое действие); `prefetchFile(fileId, size)` —
прогрев соседей; `createFileShareLink(fileId)` и `openFileInSystemViewer(fileId)` —
inline-просмотр PDF в отдельной вкладке; `downloadFile(fileId, name, mimeType?)` —
share-шит/`<a download>` для остальных документов; `uploadFile` (XHR с прогрессом);
`deleteFile`; `previewUrl(fileId)` — превью с кэшем и фолбэком на оригинал.
`openFile` и `fileObjectUrl` **удалены**: просмотр фото идёт во встроенном
`InAppBrowser`, прочие файлы скачиваются; `window.open` с blob-URL больше нет.

### 22.5 `lib/dataContext.tsx` + `lib/data/*`

Провайдер разложен на `data/context.tsx` (состояние, эффекты, экшены),
`data/tier1.ts` (расписание/ДЗ/«Важное», localStorage SWR) и `data/tier2.ts`
(оценки/пропуски/снимок БАРС/почта).

Два уровня данных:
- **Tier 1** (критический путь): расписание, ДЗ, «Важное» — грузятся сразу;
  мгновенный старт из `localStorage` (`hub_cache_*:<userId>`, SWR). Профиль
  (`hub_cache_profile`) пишется первым, до сети; после усыновления реального
  `userId` кэш перезаписывается под его ключом (иначе второе открытие ждало бы сеть).
- **Tier 2** (ленивый): оценки, пропуски, снимок БАРС (приказы/стипендия/рейтинг/
  книги), почта — при открытии вкладки, TTL 20 минут. Почта — дешёвое чтение
  превью (память сервера), поэтому обновляется при каждом заходе на «Кабинет»
  (`loadTab` → `refreshMailOnly`), но НЕ по кнопке пользователя.

Экшены: `refresh`, `refreshBars`, `loadTab`, `reloadLists` (кнопки/фоновое
обновление). Фоновое обновление (visibilitychange, throttle 15 минут) **никогда
не ставит loading**. Ошибка расписания — фатальная (`error`); ошибка БАРС —
мягкая (`barsError`); почта — своя `mailError`. Предзагрузка превью файлов
(`warmFiles`) — без await после применения списков. Выбранный день расписания
хранится в `hub_last_day:<userId>` (`lib/lastDay.ts`) и восстанавливается до
первого рендера.

Замеры (`lib/perf.ts`, `?perf=1`): `cache-read`, `bootstrap-done`,
`schedule-mount`, `first-schedule-paint`.

### 22.6 `lib/fileCache.ts` (196 строк)

Предзагрузка файлов в память. `MAX_CACHED_FILE_BYTES = 20 МБ`,
`MAX_TOTAL_CACHED_BYTES = 80 МБ` (вытеснение по порядку), `MAX_PREFETCH_PER_LIST = 20`,
`DEFAULT_PREFETCH_CONCURRENCY = 2`. Загрузчик регистрируется из `api.ts` через
`setFileFetcher` (иначе цикл импортов). Уважает `Save-Data`/`slow-2g`.

### 22.7 Компоненты

- **`FilePreview.tsx`** — только `FileThumbnail` (миниатюра из `/preview?w=800`,
  фолбэк на оригинал). Прежний `FileViewer` удалён.
- **`InAppBrowser.tsx`** — встроенный просмотрщик **фото** (портал в
  `document.body`). Шапка: крестик, название файла по центру, одна кнопка
  («Поделиться» → системный шит с файлом, иначе скачивание). Псевдо-URL и
  копирование ссылки убраны. Просмотр: свайп по соседям, зум щипком, двойной тап,
  свайп вниз/от края — закрыть. Портал обязателен: `position: fixed` ломается
  внутри `transform`-трека `SwipePager`.
- **`FileAttachmentList.tsx`** — список файлов. Тап по фото открывает
  `InAppBrowser`; PDF открывается inline в отдельной вкладке; другие документы
  вызывают `api.downloadFile` (share/сохранение). Есть кнопка удаления.
- **`AddRecordSheet.tsx`**, **`RecordDetailScreen.tsx`** — формы и детальный
  экран ДЗ/«Важного»; открытие записи хранится по идентификатору.
- **`TabBar.tsx`**, **`WeekStrip.tsx`**, **`ui.tsx`**, **`Page.tsx`**,
  **`Pager.tsx`**, **`InstallPrompt.tsx`** — навигация, календарная сетка,
  примитивы, экран установки. `Pager` (SwipePager) ставит позицию мгновенно на
  монтировании/смене числа страниц — анимируется только смена индекса от жеста.

#### 22.7.1 iOS-гайд установки (`IosInstallGuide.tsx`)

Отдельный от `InstallPrompt` экран, потому что на iOS страница чаще всего
открыта во встроенном WebView Telegram, а оттуда PWA не поставить: сначала нужно
выйти в настоящий Safari. `InstallPrompt` этого шага не знал, запоминал отказ на
30 дней и предлагал «Продолжить в браузере».

Правила:

- показывается **только** на iOS и **только** вне установленного приложения
  (`isIOS() && !isStandalone()` из `lib/env.ts`); на Android и десктопе — никогда,
  их поведение не меняется (`InstallPrompt` на iOS не показывается: в `App.tsx`
  ветка `installOpen` теперь под `!isIOS()`);
- при **каждой** загрузке страницы, пока приложение не установлено — нет
  «запомнить, что закрыл»;
- две независимые точки показа в `App.tsx`: до авторизации (поверх экрана входа,
  но **не** поверх ввода кода 2FA — `LoginScreen` сообщает `onTwoFactorChange`) и
  после авторизации (поверх `ScheduleApp`);
- четыре шага: «Открыть в Safari» → «Поделиться» → «На экран “Домой”» →
  «Добавить»; кнопки «остаться в браузере» нет, только «Понятно»;
- на каждом шаге — анимированный палец (CSS `transform`/`opacity`, без
  framer-motion), позиция зависит от шага;
- картинки шагов — опциональны (`pwa/public/install/ios-step-N.png`): если файла
  нет, шаг показывает иконку, компонент не падает;
- портал в `document.body`, фиолетовый акцент `#8B5CF6`.

`detectPlatform()`/`isStandalone()` в `InstallPrompt.tsx` при этом не тронуты —
Android-ветка остаётся ровно такой, как была.

### 22.8 Страницы

- **`SchedulePage.tsx`** — расписание из кэша, недельная календарная сетка,
  свайп, «Перерыв», карточка пары с ДЗ; файлы ДЗ открываются `InAppBrowser`
  (фото) или скачиваются.
- **`SubjectScreen.tsx`** (358) — предмет: пары за семестр, оценка, список ДЗ.
- **`GradesPage.tsx`** (408) — успеваемость из кэша: задолженности, рейтинг, полоса
  распределения 5/4/3/2, раскрывающиеся КМ.
- **`TasksPage.tsx`** (611) — задания и «Важное»: один список с двумя секциями,
  фильтр по предмету, открытие записи по id.
- **`ProfilePage.tsx`** (520) — кабинет. Порядок блоков: **Профиль → Почта ОСЭП →
  Уведомления → Стипендия → Приказы → Библиотека → Выйти**. Блок уведомлений
  компактный (одна строка + кнопка «Выключить»/«Включить»/«Подключить»).
  `NeedLoginScreen` — когда токен PWA жив, а сессия БАРС истекла.

---

## 23. Переменные окружения

```env
# Токен бота от @BotFather
TELEGRAM_BOT_TOKEN=replace-with-token-from-BotFather

# Ключ AES-256-GCM для кредов БАРС: 64 hex-символа
ENCRYPTION_SECRET_KEY=<64 hex-символа>

# Секрет для PWA-токенов: 64 hex-символа (npm run pwa:setup). Отдельный ключ.
PWA_AUTH_SECRET=

# Публичный HTTPS-адрес веб-версии (PWA): кнопка «🌐 Открыть приложение»,
# CORS-источник, deep link.
PWA_URL=

# Включает REST API в процессе бота. Без него API не поднимается.
API_PORT=3000

# Хост API. По умолчанию 127.0.0.1 — наружу отдаёт nginx.
API_HOST=127.0.0.1

# Отпечаток SPKI сертификата mail.mpei.ru — ТОЛЬКО для старого IMAP-клиента
# (deprecated, не используется). На OWA-скрапинг не влияет.
MAIL_TLS_PIN=PkoOagvOh1G5kxqLLL9Jc4TfQWoWXx5OtV0lozzRGhg=
```

**Почта OWA (в шелле/для скрипта):** `OWA_DEBUG=1` — подробный лог запросов/ответов
OWA (пароль и cookie редактируются); `OWA_TLS_INSECURE=1` — отключить проверку TLS
(самоподписанный сертификат TMG); `OWA_USER`/`OWA_PASS` (или `OSEP_USER`/`OSEP_PASS`)
— креды для `npm run test:owa`.

**Отладка (в шелле):** `API_PERF_LOG=1` (все запросы API), `?perf=1` /
`hub_perf` (клиентские замеры), `?debug=1` (диагностика).
**Только для веб-пака:** `VITE_API_TARGET` (dev-прокси), `VITE_TELEGRAM_BOT_USERNAME`.

Поведение при отсутствии:

| Нет | Что будет |
|---|---|
| `TELEGRAM_BOT_TOKEN` | бот не стартует (без исключения), процесс живёт ради API |
| `ENCRYPTION_SECRET_KEY` | бот стартует, но не сохранит креды БАРС |
| `PWA_URL` | кнопки «Открыть приложение» нет, CORS origin не включает |
| `PWA_AUTH_SECRET` | вход в приложение невозможен (`PwaAuthConfigError`) |
| `API_PORT` | API не поднимается |
| `API_HOST` | `127.0.0.1` |
| `MAIL_TLS_PIN` | только IMAP (deprecated); OWA работает по HTTPS без него |
| `OWA_TLS_INSECURE` | TLS проверяется строго (при самоподписанном сертификате — 403/ошибка) |

`TELEGRAM_STORAGE_CHANNEL_ID`/`WEB_APP_URL` больше не читаются.

---

## 24. Запуск и разработка

### 24.1 npm-скрипты (корень)

| Скрипт | Назначение |
|---|---|
| `build` | esbuild-бандл `dist/bot.js` (включая API) |
| `start` / `bot` | `node dist/bot.js` |
| `dev` | `tsx watch bot.ts` |
| `tsx` | разовый запуск из исходников |
| `lint` | `tsc --noEmit` |
| `api` | `tsx src/server/index.ts` — только API |
| `reset:db` / `reset:users` | сброс базы |
| `check:files` | целостность файлов |
| `test:*` | тесты (см. §25) |
| `pwa:setup` | секрет PWA, зависимости, иконки, сборка |
| `pwa:build` | сборка веб-версии |
| `pwa:dev` | vite в dev-режиме |
| `check:layout` | сборка PWA + прогон вёрстки в Chromium (Playwright): панель, документ, свайпы, вкладки |

### 24.2 Проверка на iPhone

`bash pwa/scripts/dev-tunnel.sh` — vite + туннель cloudflared (нужен HTTPS для
Service Worker) + бот с `API_PORT=3000` и `PWA_URL=$TUNNEL_URL`. Туннель один (на
vite), vite проксирует `/api` на `:3000`. Целевой локальный бот — `@hub_mpei_bot`.

### 24.3 Проверка качества

`npm run lint` (корень) и `npm run build` в `pwa/` (`tsc --noEmit && vite build`).

---

## 25. Тесты и проверки

Тесты не на framework: `tsx`-скрипты с проверками и `console.log`, падение через
`process.exit(1)`.

### 25.1 Подключены к npm-скриптам

| Файл | Скрипт | Что проверяет |
|---|---|---|
| `test-bars-login-hash.ts` | `test:bars-login-hash` | нормализация, стабильность, формат хэша |
| `test-pwa-auth.ts` | `test:pwa-auth` | формат, срок, подделка payload/подписи |
| `test-pwa-routes.ts` | `test:pwa-routes` | живой Fastify: хук, открытые маршруты, отзыв токена, CORS, вход в Telegram-связанный аккаунт |
| `test-bars-snapshot.ts` | `test:snapshot` | снимок БАРС на подделках (почта в снимок не входит) |
| `test-group-isolation.ts` | `test:isolation` | изоляция по группам и пользователям |
| `test-notifier.ts` | `test:notifier` | окно активности, диффы (три письма, дельта), сетевые ошибки — без сети |
| `test-grades-calc.ts` | `test:grades-calc` | калькулятор среднего, конверсия пропусков |
| `test-html-views.ts` | `test:html` | баланс HTML-тегов в экранах |
| `test-file-roundtrip.ts` | `test:files` | загрузка/скачивание файлов |
| `test-notifications-toggle.ts` | `test:notifications` | включение/выключение уведомлений |
| `test-owa-mail.ts` | `test:owa` | вход в OWA, печать числа непрочитанных (нужны креды/сеть МЭИ) |
| `check-files.ts` | `check:files` | целостность файлов (наличие, размер, `sha256`) |

`test:all` собирает часть из них и не ходит в сеть.

### 25.2 Не подключены — `npx tsx scripts/<файл>`

`bars-live.ts`, `test-bars-auth.ts`, `test-bars-client.ts`, `test-bars-scraper.ts`,
`test-grades.ts`, `test-attendance.ts`, `test-info.ts`, `test-mail-auth.ts`,
`test-mail-fetch.ts` (IMAP, deprecated), `test-notifier-live.ts`,
`test-schedule-cache.ts` (требует `scratch/schedule_raw.json`), а также CDP- и
measure-скрипты фронтенда (`check-layout`, `measure-*`, `debug-*`, `shoot-swipe`,
`preview-layout`).

### 25.3 Прочее

`test-notifier.ts` принципиально не ходит в сеть. `test-group-isolation.ts` и
`test-pwa-routes.ts` меняют `process.cwd()` на временный каталог **до** импорта
хранилищ. `test-grades-calc.ts` работает на HTML-дампах из `scratch/`.

---

## 26. Деплой

### 26.1 systemd

Готовые файлы: `deploy/hub.service`, `deploy/journald.conf`.

```bash
npm ci && npm run build
cp deploy/hub.service /etc/systemd/system/hub.service
mkdir -p /etc/systemd/journald.conf.d
cp deploy/journald.conf /etc/systemd/journald.conf.d/hub.conf
systemctl daemon-reload && systemctl enable --now hub
```

Ключевое для VPS 512 МБ: `--max-old-space-size=256`, `MemoryMax=400M`,
`StartLimitIntervalSec=300`/`StartLimitBurst=5`, `Restart=always`, `User=hub`,
`UMask=0077`, journald `SystemMaxUse=200M`. Юнит для PWA менять не нужно: API
поднимается тем же процессом.

### 26.2 Первый деплой

1. `npm run build`; 2. `npm run pwa:setup` + раздача `pwa/dist`; 3. задать
`PWA_URL`, `PWA_AUTH_SECRET`, `API_PORT`; 4. проксировать `/api/` на
`127.0.0.1:API_PORT`; 5. `chmod 700 /opt/hub/data`, `chmod 600 /opt/hub/.env`;
6. создать `data/files` (юнит работает от `hub`).

Статика: `rsync -a --delete pwa/dist/ /var/www/hub-pwa/` (шаблон `*` не копирует
`.vite/manifest.json`, нужный Service Worker'у), `try_files $uri $uri/ /index.html`.

---

## 27. Известные риски и техдолг

### 27.1 Секреты и структура

1. `.env`, дампы сессий БАРС содержат живые cookie — закрыты `.gitignore`, но лежат
   в рабочем каталоге.
2. `src/bot/scheduleCache.ts` и `barsSnapshotCache.ts` — состояние в памяти:
   не переживает рестарт, при нескольких инстансах у каждого своя копия.
3. `data/*.json` без версионирования схемы; миграционный fallback `iv`/`tag` →
   `ivPass`/`tagPass` в `readBarsCredentials`.
4. Ротация `ENCRYPTION_SECRET_KEY` и `PWA_AUTH_SECRET` невозможна без миграции.
5. Хрупкость скрапинга БАРС: парсеры привязаны к HTML конкретной версии ЛК.
6. Почта — OWA-скрапинг: контракт OWA (поля формы входа, `X-OWA-CANARY`,
   `service.svc`) снят по протоколу OWA 2013 и должен периодически проверяться —
   при обновлении OWA МЭИ запросы могут поехать (диагностика `OWA_DEBUG=1`).
   Старый IMAP-клиент `osepMailClient.ts` оставлен как `@deprecated`.

### 27.2 Логика

7. `ACADEMIC_HOURS_PER_LESSON = 2` зашито константой.
8. Оценки считаются по КМ с весами; итоговый балл БАРС может считаться иначе (рядом
   показываются оба).
9. Задолженность = только двойки; незакрытые КМ ни в задолженность, ни в
   распределение.
10. График частот опроса даёт 0% экономии на текущих дефолтах.

### 27.3 Фронтенд

11. Нет тестов у веб-приложения; `playwright` в зависимости не входит и ставится
    отдельно для `check:layout`.
12. `@types/react` v19 при `react` 18.3.1 (спасает `skipLibCheck`).
13. Роутера нет — ни истории, ни диплинков.
14. Дублированные хелперы (`gradeColor`/`scoreColor`, `shortKindLabel`, `plural`,
    пары `parseRawDate`/`formatRawDate`).

### 27.4 Почта ОСЭП (OWA)

15. IMAP `:993` режется Forefront TMG (`RST` на ClientHello, сертификат не
   отдаётся); порт 143 — то же. Поэтому почта читается через веб-интерфейс
   `mail.mpei.ru/owa` (FBA-вход + `service.svc`). Сессия OWA (cookie) хранится
   отдельно от БАРС (`StoredUser.owaAuth`), при 401 перелогин, при 403/TMG —
   «нужен VPN МЭИ».
16. Почта в интерфейсе — из превью (`mailPreviewCache`), которое обновляет
   нотификатор; ручного обновления и кнопки «Повторить» нет. Ошибки видны в
   журнале нотификатора (`[Notifier][…] почта OWA недоступна`). Диагностика —
   `OWA_DEBUG=1` и `npm run test:owa`.

### 27.5 Прочее

17. Нет CI и покрытия; smoke-скрипты запускаются вручную.
18. Причина «Android standalone не загружается» устранена в SW/публикации, но не
   подтверждена на устройстве.
19. Замеры по умолчанию выключены — «медленный вход» на устройстве не виден без
   явного включения.
20. Файлы `Архив.zip` (96 МБ) и скриншот в корне не закрыты `.gitignore`.

### 27.6 Лимиты записей/файлов и изоляция

21. Антифлуд записей (`MAX_RECORDS_PER_HOUR = 30`, окно час, **общий** для ДЗ и
    «Важного») хранится только в памяти процесса: рестарт сбрасывает счётчик, у
    каждого инстанса он свой (процесс один). Счётчик учитывает попытки, включая
    отклонённые валидацией, и не персистится. При блокировке — 429 с `Retry-After`.
22. Потолок файла 20 МБ продублирован в двух слоях намеренно: на разборе
    `@fastify/multipart` (файл не попадает в память целиком) и в `saveFile`
    (защита от вызова в обход HTTP). Оба используют одну константу
    `MAX_FILE_SIZE_BYTES`. Квота 500 МБ проверяется до чтения потока, но считает
    резерв в один максимальный файл (консервативно) и опирается на кэш объёма с
    TTL 60 с — при правке каталога в обход процесса значение может кратко
    расходиться (кэш перепроверяется обходом при отказе).
23. Изоляция по группе проверяется дважды: group-scoped методами хранилища
    (`getForGroupAndId`, `getForGroup`, `getUpcoming`, `getForSlot` — пустая
    группа не видит ничего) и явной проверкой в роуте (`canAccessGroup` в
    `studentContext.ts`) перед PATCH/DELETE. Привязка файлов требует и
    владельца файла (`uploadedBy`), и ранее проверенную группу записи.

---

## 28. Быстрый ориентир по файлам

### Бэкенд

| Задача | Файл |
|---|---|
| Экраны и кнопки бота | `src/bot/pwaView.ts` |
| Маршрутизация сообщений/нажатий бота | `src/bot/botEngine.ts` |
| Запуск бота, нотификатор, API, deep link | `src/bot/telegramService.ts` |
| HTML-разметка и санитизация ошибок | `src/bot/format.ts` |
| Кэш расписания (TTL, потолок, дедуп) | `src/bot/scheduleCache.ts` |
| Поиск будущей пары для ДЗ | `src/bot/homeworkManager.ts` |
| Средневзвешенный балл по КМ | `src/bot/gradeCalculator.ts` |
| Вход в БАРС (5 шагов, 2FA) | `src/services/bars/barsAuth.ts` |
| Живость сессии | `src/services/bars/barsClient.ts` |
| Разделы ЛК | `src/services/bars/barsScraper.ts` + `parsers/` |
| Снимок БАРС в памяти | `src/services/bars/barsSnapshotCache.ts` |
| Превью почты для интерфейса | `src/services/mail/mailPreviewCache.ts` |
| Кэш клиентов и креды | `src/services/bars/barsServiceFactory.ts` |
| Почтовый клиент OWA | `src/services/mail/owaMailClient.ts` (+ `mailErrors.ts`) |
| Почта: сессия/креды | `StoredUser.owaAuth`, `readOwaCredentials` (`barsServiceFactory.ts`) |
| Диффы и уведомления | `src/services/notifications/barsNotifier.ts` |
| Частота опроса источников | `src/services/notifications/pollSchedule.ts` |
| Предохранители процесса | `bot.ts` (`unhandledRejection`/`uncaughtException`) |
| Пользователи и токены | `src/storage/userStore.ts` |
| Файлы на диске | `src/storage/fileStore.ts`, `src/storage/filePreview.ts` |
| Формат `data/*.json` | `src/utils/jsonStore.ts` |
| Шифрование кредов | `src/utils/crypto.ts` |
| PWA-токен | `src/utils/pwaAuth.ts` |
| Антибрутфорс | `src/utils/loginLimiter.ts` |
| Московское время | `src/utils/time.ts` |

### API

| Задача | Файл |
|---|---|
| Маршруты / CORS / лимиты / замеры | `src/server/index.ts` |
| Проверка PWA-токена | `src/server/middleware/auth.ts` |
| Вход/регистрация/2FA/bootstrap | `src/server/routes/auth.ts` |
| Контракт клиент/сервер | `src/server/types.ts` + копия `pwa/src/types/api.ts` |
| Файлы: приём, выдача, превью | `src/server/routes/files.ts` + `storage/fileStore.ts` |
| Уведомления (toggle/state) | `src/server/routes/notifications.ts` |
| Изоляция по группе | `src/server/routes/studentContext.ts` (`canAccessGroup`), `recordFiles.ts` |
| Антифлуд записей (30/час, общий) и удаление файлов | `src/server/routes/recordShared.ts` |

### Фронтенд

| Задача | Файл |
|---|---|
| Корень и вход | `pwa/src/App.tsx`, `pwa/src/auth.ts` |
| Оболочка и вкладки | `pwa/src/app/ScheduleApp.tsx`, `pwa/src/components/TabBar.tsx` |
| Загрузка и кэш данных | `pwa/src/lib/dataContext.tsx` → `pwa/src/lib/data/*` |
| API-вызовы | `pwa/src/lib/api.ts` → `pwa/src/lib/api/*` |
| Кэш файлов и превью | `pwa/src/lib/fileCache.ts`, `pwa/src/lib/api/files.ts` (`fetchFile`) |
| Просмотр файлов | `pwa/src/components/InAppBrowser.tsx` (фото), `FileAttachmentList.tsx` |
| Запомненный день расписания | `pwa/src/lib/lastDay.ts` |
| Среда браузера и ссылки | `pwa/src/lib/env.ts` (`openLink`) |
| Замеры | `pwa/src/lib/perf.ts`, `pwa/src/diagnostics.ts` |
| Кабинет (почта/уведомления/ЛК) | `pwa/src/pages/ProfilePage.tsx` |
| Цвета и тема | `pwa/src/index.css` |
| Деплой фронтенда | `pwa/README.md`, `pwa/nginx.conf.example`, `pwa/vite.config.ts` |

---

## 29. Страница статистики `/dev` (личная, владельцу)

Отдельная приватная страница владельца: живая статистика использования Hub.
Хостится рядом с PWA, но **не** входит в React-бандл (не грузит ВПС и PWA).

### Где что лежит

| Часть | Файл |
|---|---|
| Разметка/стили/графики страницы | `pwa/public/dev/index.html` (статика, отдаётся nginx как `/dev/`) |
| API | `GET /dev-api/stats?period=24h\|7d\|30d&usersOffset&usersLimit` → `src/server/routes/dev.ts` |
| Сбор и агрегация | `src/server/devStats.ts` |
| Ежедневный отчёт (HTML+JSON в Telegram) | `src/services/notifications/dailyReport.ts` + `reportHtml.ts` |
| Прокси | nginx: `location /dev-api/` → `127.0.0.1:3000` |

Доступ: только по токену `DEV_STATS_TOKEN` (заголовок `X-Dev-Token` или `?key=`).
Маршрут вне `/api`, поэтому существующий `authHook` не затронут. Не задан токен —
маршрут отдаёт 404. ПДн (логины, зачётки, cookie, userId) не отдаются: только
ФИО, группа, даты и агрегаты.

### Метрики

Собираются (страница + отчёт): онлайн за 1/15/60 мин; запросы в минуту; живые
сессии БАРС и истёкшие; ошибки 5xx за час; всего пользователей (+ новых за
период); авторизованы в БАРС; с Telegram; уведомления вкл; активные за 24ч/7д/30д
(уникальные); запросы за период; ряд активных и запросов по дням (или по часам за
24ч); активность по часам МСК; запросы по разделам (пончик); ДЗ всего/за период и
по группам; «Важное»; файлы (шт./МБ/средний/по типам/топ-5); уведомлений
отправлено; успешные входы БАРС; ошибки БАРС по разделам; нагрузка (аптайм,
RSS/heap, размер `data/`, файлов на диске, 4xx/5xx, p50/p95, снимков на диске);
воронка «регистрация → БАРС → первое ДЗ → уведомления»; список пользователей
(ФИО, группа, регистрация, последняя активность, статусы) с фильтрами, поиском и
пагинацией.

Недоступно (данных физически нет): уведомления по типам и ошибки отправки
(счётчик только общий); IMAP-подключения (IMAP deprecated); «снимки БАРС
в памяти» (наружу не отдаются — показываем на диске); дни истории до внедрения
снапшотов (помечаются `unavailableDays`).

### Модель сбора (без нагрузки)

- На каждый запрос — только инкременты чисел в памяти (Map/массивы). Никакого
  I/O, `JSON.stringify` или обращений к БАРС/почте.
- Последняя активность пользователя — в памяти (`lastSeen`), сбрасывается при
  рестарте (историю хранит снапшот).
- **Единственная** новая запись на диск — дневной снапшот
  `data/stats_daily.json` (JsonDocument, атомарно, 0600) в 00:00 МСК и при смене
  суток; дни старше 90 удаляются.
- p50/p95 — кольцевой буфер на 1000 значений, пересчёт раз в минуту (`unref`).
- 5xx-за-час — кольцо на 60 минут.
- Скан `data/` и файлов — кэш 60 с, не на запрос.
- Ответ API кэшируется в памяти на 30 с (один слот).
- Смена периода и пагинация — параметрами одного запроса; авто-обновления по
  таймеру нет (только кнопка «Обновить» и `visibilitychange` с throttle 60 с).
- Графики — инлайн-SVG + CSS, без библиотек; пересчёт в браузере минимальный.

### Что оптимизировано

- Убрана запись метрик «на каждый запрос» (раньше `stats.json` писался по
  debounce) — теперь один снапшот в сутки.
- Тяжёлые вычисления (скан файлов, размер каталога) вынесены под кэш.
- Воронка и контент считаются из уже загруженных в память `users.json`,
  `homework.json`, `important.json` — без сетевых и файловых обращений на запрос.
- Дубли счётчиков не появились: время ответа берётся из метки `hubStartedAt`,
  которую уже ставит `setupRequestTiming` (`src/server/index.ts`).
- Страница вынесена из React-бандла PWA — не увеличивает ни бандл, ни парсинг
  приложения.
