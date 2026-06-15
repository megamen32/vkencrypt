#!/usr/bin/env bash
# Сборка userscript из vkencrypt.template.js.
#
# В v4+ ключи НЕ бэйкаются в код — пользователь вводит их через UI
# (seed-фраза → PBKDF2 k1..k4, или пользовательские 64-hex ключи).
# Поэтому build.sh больше не подставляет PRE_SHARED_KEY_* из bot/.env,
# а просто публикует актуальную версию template в:
#   - dist/vkencrypt_userscript_<timestamp>.js   (снапшот)
#   - vkencrypt.user.js                         (стабильный install-файл)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/vkencrypt.template.js"
DIST_DIR="$SCRIPT_DIR/dist"
STABLE_PATH="$SCRIPT_DIR/vkencrypt.user.js"

if [[ ! -f "$TEMPLATE" ]]; then
    echo "Не найден шаблон: $TEMPLATE" >&2
    exit 1
fi

mkdir -p "$DIST_DIR"

OUT_NAME="vkencrypt_userscript_$(date +%Y%m%d_%H%M%S).js"
OUT_PATH="$DIST_DIR/$OUT_NAME"

cp -f "$TEMPLATE" "$OUT_PATH"
chmod 644 "$OUT_PATH"
echo "✅ Собран: $OUT_PATH"

cp -f "$TEMPLATE" "$STABLE_PATH"
chmod 644 "$STABLE_PATH"
echo "📌 Стабильный install-файл: $STABLE_PATH"
echo "   Используй эту ссылку для установки и автообновления:"
echo "   https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js"
