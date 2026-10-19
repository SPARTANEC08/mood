# Android (TWA) — источник правды

В репозитории живёт **только** `twa-manifest.json`. Это конфиг Bubblewrap: домен,
`applicationId`, иконки, тема, ориентация, путь к keystore.

Сам Gradle-проект здесь не хранится: его разворачивает Bubblewrap при
`npm run apk:build`, и он содержит абсолютные пути и скачанный
`gradle-wrapper.jar` (см. `.gitignore`). Хранить сгенерированное в git — значит
плодить мусор, который ещё и расходится с `twa-manifest.json`.

Пересобрать конфиг из `.env` (например, сменился домен или иконка):
```bash
npm run apk:init -- --force
```

Полная инструкция — в корневом `README.md`, раздел «APK (TWA)».
