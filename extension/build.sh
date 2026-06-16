#!/usr/bin/env bash
# Сборка snapshot userscript из vkencrypt.user.js.
#
# Единственный исходник теперь сам install-файл:
#   - vkencrypt.user.js                         (стабильный install-файл)
#   - dist/vkencrypt_userscript_<timestamp>.js   (снапшот)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/vkencrypt.user.js"
DIST_DIR="$SCRIPT_DIR/dist"

if [[ ! -f "$SOURCE" ]]; then
    echo "Не найден userscript: $SOURCE" >&2
    exit 1
fi

mkdir -p "$DIST_DIR"

OUT_NAME="vkencrypt_userscript_$(date +%Y%m%d_%H%M%S).js"
OUT_PATH="$DIST_DIR/$OUT_NAME"

cp -f "$SOURCE" "$OUT_PATH"
chmod 644 "$OUT_PATH"
echo "✅ Собран: $OUT_PATH"
chmod 644 "$SOURCE"
echo "📌 Стабильный install-файл: $SOURCE"
echo "   Используй эту ссылку для установки и автообновления:"
echo "   https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js"
