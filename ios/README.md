# Mood для iOS

Нативное приложение для iPhone. Сейчас это **первая фаза**: устанавливаемая
оболочка на SwiftUI + `WKWebView`, которая открывает `https://mood-app.ru`
полноэкранно, сохраняет сессию между запусками и ведёт себя как системное
приложение (иконка, splash, safe area, файлы, внешние ссылки в Safari).

Дальше экраны переписываются на SwiftUI по одному — расписание, оценки, задания,
кабинет. Оболочка остаётся запасным вариантом и точкой отката.

## Требования

- macOS с установленным **Xcode** (не только Command Line Tools).
- iPhone с iOS 18+ и кабель.
- Бесплатный Apple ID для подписи (Personal Team).
- `xcodegen` — ставится через Homebrew.

## Первая сборка

### 1. Xcode

```bash
# из App Store (≈12 ГБ)
open "macappstore://apps.apple.com/app/xcode/id497799835"

# после установки
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -downloadPlatform iOS      # платформа iOS (≈8 ГБ)
```

Проверка:

```bash
xcodebuild -version
```

### 2. Проект

```bash
brew install xcodegen
cd ios
xcodegen generate
open Mood.xcodeproj
```

`Mood.xcodeproj` в git не лежит: источник правды — `project.yml`. После
изменения структуры папок или настроек таргета снова выполните
`xcodegen generate`.

Проверить компиляцию без подписи и без телефона:

```bash
./check.sh
```

Скрипт перегенерирует проект и собирает его под `generic/platform=iOS` с
выключенной подписью — ловит ошибки Swift и ассетов до подключения iPhone.

### 3. Подпись

1. Xcode → **Settings → Accounts → +** → войти Apple ID.
2. Выбрать аккаунт → **Manage Certificates → + → Apple Development**.
3. В проекте: таргет **Mood → Signing & Capabilities**.
4. **Team** — свой Personal Team.
5. **Bundle Identifier** — `ru.spartanec.mood.dev`. Если Xcode ругается, что
   идентификатор занят, добавьте суффикс: `ru.spartanec.mood.dev2`.

`DEVELOPMENT_TEAM` в `project.yml` не прописан намеренно: у каждого свой Team ID,
а генерируемый проект не должен зависеть от конкретного аккаунта.

### 4. iPhone

1. Настройки → Конфиденциальность и безопасность → **Режим разработчика** → вкл,
   перезагрузить телефон.
2. Подключить кабелем, на телефоне «Доверять этому компьютеру».
3. В Xcode сверху выбрать устройство и нажать **Run** (⌘R).
4. При первом запуске: Настройки → Основные → VPN и управление устройством →
   «Доверять» разработчику.

## Ограничения бесплатного Apple ID

| Что | Следствие |
|---|---|
| Профиль живёт **7 дней** | Приложение перестаёт открываться — снова Run из Xcode |
| Нет Push Notifications | Системных пушей нет; уведомления — только лента внутри PWA |
| Нет Associated Domains | Universal links не работают |
| Нет App Groups | Виджеты и Share Extension не могут делить данные с приложением |
| ~3 приложения на устройство | Старые сборки придётся удалять |
| Нет TestFlight / App Store | Только установка со своего Mac |

Когда понадобятся push, виджеты и раздача тестерам — Apple Developer Program
($99/год). После оплаты меняется только Team в Xcode и добавляются
entitlements; код переписывать не нужно.

### AltStore / SideStore

Нужны, чтобы не подключать кабель каждые 7 дней:

- **AltStore** — AltServer на Mac; компьютер должен быть в той же сети (или
  включён). Переподпись автоматическая, пока Mac доступен.
- **SideStore** — WireGuard + pairing file, обновление прямо с телефона.
  Настройка дольше, зато Mac не нужен.

Проще начать с Xcode по кабелю, а AltStore добавить, когда оболочка заработает.

## Что внутри

```
ios/
├── project.yml                  # XcodeGen: таргет, bundle id, iOS 18
├── Mood/
│   ├── MoodApp.swift            # @main
│   ├── RootView.swift           # фон, прогресс, экран ошибки
│   ├── WebViewStore.swift       # WKWebView, навигация, файлы, тема, JS-диалоги
│   ├── ExternalBrowser.swift    # Safari, share sheet, поиск контроллера
│   ├── AppConfiguration.swift   # адрес приложения и allowlist доменов
│   ├── Info.plist               # ATS, ориентация, usage descriptions
│   └── Assets.xcassets          # иконка, акцент, фон запуска
└── README.md
```

Поведение:

- **Внутри** приложения открывается только домен из `MoodAppURL`. Любая чужая
  ссылка (почта МЭИ, GitHub, Telegram) уходит в `SFSafariViewController` — чужой
  сайт не получает доступ к `localStorage` с PWA-токеном.
- **Сессия** хранится в `WKWebsiteDataStore.default()`, то есть вход переживает
  перезапуск и переустановку кода поверх.
- **Файлы**, которые WebKit не умеет показать, скачиваются и отдаются через
  системный share sheet.
- **Тема**: скрипт читает `data-theme` у PWA и сообщает нативной оболочке, чтобы
  статус-бар и системные алерты совпадали с фоном приложения.
- **JS-диалоги** (`alert`/`confirm`/`prompt`) показываются нативно — без этого
  подтверждение удаления аккаунта и другие действия молча зависали бы.
- **Ошибка сети** показывается только на первой загрузке; если страница уже
  открывалась, офлайн-оболочку Service Worker не перекрываем.

## Смена адреса

`MoodAppURL` в `Mood/Info.plist` (или в настройках таргета). Прод —
`https://mood-app.ru`; для отладки на локальном сервере можно указать
`http://192.168.x.x:3000`. Для HTTP вне `localhost` понадобится
`NSAppTransportSecurity` — добавлять только на время отладки.

## Типовые проблемы

| Симптом | Причина и решение |
|---|---|
| «Untrusted Developer» | Настройки → Основные → VPN и управление устройством → доверять |
| Приложение «не открывается» через неделю | Истёк 7-дневный профиль — снова Run |
| Белый экран | Xcode → Debug → Attach to Process → Mood, открыть Safari Web Inspector и посмотреть ошибку загрузки |
| `No signing certificate` | Xcode → Settings → Accounts → Manage Certificates → Apple Development |
| `Bundle identifier is not available` | Сменить `PRODUCT_BUNDLE_IDENTIFIER` в `project.yml`, `xcodegen generate` |
| Не работают фото/камера в загрузке файлов | Проверить usage descriptions в `Info.plist` и разрешения в Настройках |

## Следующие фазы

1. `APIClient` + `X-PWA-Token` в Keychain, вход БАРС и 2FA, гостевой режим.
2. Расписание на SwiftUI + офлайн-кэш (SwiftData).
3. Оценки, задания, «Важное».
4. Кабинет, почта, согласия, центр уведомлений.
5. После Apple Developer Program: APNs + endpoint на сервере, виджеты,
   Share Extension, Universal Links, TestFlight.
