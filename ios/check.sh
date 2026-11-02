#!/usr/bin/env bash
#
# Проверка сборки без подписи: ловит ошибки Swift, Info.plist и ассетов до
# запуска на iPhone. Подпись и установку делает Xcode (⌘R) — здесь она не
# нужна, поэтому CODE_SIGNING_ALLOWED=NO.
#
# Запуск: ./ios/check.sh

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen не найден: brew install xcodegen" >&2
  exit 1
fi

if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  echo "Активны только Command Line Tools — Xcode не установлен." >&2
  echo "После установки Xcode выполните:" >&2
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

xcodegen generate
xcodebuild -version

xcodebuild \
  -project Mood.xcodeproj \
  -scheme Mood \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "Сборка без подписи прошла. Дальше: open Mood.xcodeproj → Run."
