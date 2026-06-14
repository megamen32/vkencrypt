#!/usr/bin/env bash
# Развёртывание VKEncrypt-бота как systemd-сервиса.
# Шаги:
#   1. Создаёт .venv и ставит зависимости через `uv sync` (или `pip install` как fallback).
#   2. Генерирует .env с двумя случайными ключами, если его нет.
#   3. Рендерит vkencrypt.service из шаблона и копирует в /etc/systemd/system/.
#   4. Запускает бота и показывает статус.
#   5. Опционально — собирает userscript из ../extension/.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="vkencrypt"
SERVICE_TEMPLATE="$PROJECT_DIR/vkencrypt.service.template"
SERVICE_LOCAL="$PROJECT_DIR/vkencrypt.service"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="$PROJECT_DIR/.env"

echo "Проект: $PROJECT_DIR"

# 1. venv
if [[ ! -x "$PROJECT_DIR/.venv/bin/python" ]]; then
    echo "Создаю виртуальное окружение и ставлю зависимости..."
    if command -v uv >/dev/null 2>&1; then
        uv sync
    else
        python3 -m venv .venv
        ./.venv/bin/pip install --upgrade pip
        ./.venv/bin/pip install -e .
    fi
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Генерирую .env с двумя случайными ключами..."
    KEY_K1=$("$PROJECT_DIR/.venv/bin/python" -c "from Crypto.Random import get_random_bytes; import binascii; print(binascii.hexlify(get_random_bytes(32)).decode())")
    KEY_K2=$("$PROJECT_DIR/.venv/bin/python" -c "from Crypto.Random import get_random_bytes; import binascii; print(binascii.hexlify(get_random_bytes(32)).decode())")

    cat > "$ENV_FILE" <<EOF
VK_TOKEN=YOUR_TOKEN_HERE
MY_USER_ID=YOUR_USER_ID
PRE_SHARED_KEY_K1=$KEY_K1
PRE_SHARED_KEY_K2=$KEY_K2
DEFAULT_KEY_ID=k1
EOF

    chmod 600 "$ENV_FILE"
    echo "✅ .env создан. Отредактируйте VK_TOKEN и MY_USER_ID:"
    echo "    nano $ENV_FILE"
fi

# 3. systemd unit из шаблона
echo "Рендерю $SERVICE_LOCAL из шаблона..."
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$SERVICE_TEMPLATE" > "$SERVICE_LOCAL"

echo "Копирую $SERVICE_LOCAL -> $SYSTEMD_UNIT"
sudo cp "$SERVICE_LOCAL" "$SYSTEMD_UNIT"
sudo chmod 644 "$SYSTEMD_UNIT"

# 4. Запуск
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo ""
sudo systemctl status "$SERVICE_NAME" --no-pager | head -n 20
echo ""

# 5. Опциональная сборка userscript
EXT_DIR="$PROJECT_DIR/../extension"
if [[ -x "$EXT_DIR/build.sh" ]]; then
    echo "Собираю userscript для расширения..."
    ENV_FILE="$ENV_FILE" "$EXT_DIR/build.sh" || true
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "📱 Собранный userscript: $EXT_DIR/dist/"
    echo "   Скопируйте его в Tampermonkey (ПК) или Userscripts (iPhone)."
    echo "   Подробности — в extension/README.md"
    echo "════════════════════════════════════════════════════════════════"
fi

echo ""
echo "📝 Логи: sudo journalctl -u $SERVICE_NAME -f"
