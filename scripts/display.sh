#!/bin/sh
# Отдельный экран для агента: Xvfb (X-сервер без монитора, рисует в память) + браузер на нём.
#   sh scripts/display.sh [url]          экран :99 1280×800, браузер с url (по умолчанию — песочница)
#   EYE_DISPLAY=:100 EYE_SIZE=1920x1080 sh scripts/display.sh https://example.com
# Твой собственный экран и мышь агент не трогает: у него свой экран, своя мышь, своя клавиатура.
set -e
DISP="${EYE_DISPLAY:-:99}"
SIZE="${EYE_SIZE:-1280x800}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-file://$HERE/sandbox.html}"

if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  Xvfb "$DISP" -screen 0 "${SIZE}x24" -nolisten tcp >/dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do xdpyinfo -display "$DISP" >/dev/null 2>&1 && break; sleep 0.2; done
  echo "экран $DISP $SIZE поднят"
fi

CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || ls /opt/pw-browsers/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1)}"
if [ -n "$CHROME" ]; then
  W="${SIZE%x*}"; H="${SIZE#*x}"
  DISPLAY="$DISP" "$CHROME" --no-sandbox --no-first-run --no-default-browser-check --disable-gpu \
    --user-data-dir="${TMPDIR:-/tmp}/eye-chrome$DISP" --window-position=0,0 --window-size="$W,$H" \
    --app="$URL" >/dev/null 2>&1 &
  echo "браузер на $DISP: $URL"
else
  echo "браузер не найден (задай CHROME=путь) — экран пустой"
fi
