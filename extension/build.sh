#!/usr/bin/env bash
# Сборка userscript-файла расширения из vkencrypt.template.js.
# Если ../bot/.env существует и содержит PRE_SHARED_KEY_*, эти ключи
# подставляются в STATIC_KEYS собранного файла.
# Готовый файл пишется в dist/ (gitignored) — он содержит ключи, не коммитьте его.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/vkencrypt.template.js"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../bot/.env}"
DIST_DIR="$SCRIPT_DIR/dist"

if [[ ! -f "$TEMPLATE" ]]; then
    echo "Не найден шаблон: $TEMPLATE" >&2
    exit 1
fi

mkdir -p "$DIST_DIR"

OUT_NAME="vkencrypt_userscript_$(date +%Y%m%d_%H%M%S).js"
OUT_PATH="$DIST_DIR/$OUT_NAME"

# Собираем JSON-объект статических ключей для подстановки.
declare -A KEY_MAP
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        if [[ "$key" == PRE_SHARED_KEY_* ]]; then
            kid=$(echo "$key" | sed 's/^PRE_SHARED_KEY_//' | tr '[:upper:]' '[:lower:]')
            KEY_MAP[$kid]="$value"
        fi
    done < <(grep -E '^PRE_SHARED_KEY_[A-Za-z0-9]+=' "$ENV_FILE" | sed 's/[[:space:]]*$//')
fi

# Считываем текущий блок STATIC_KEYS из шаблона, чтобы аккуратно заменить только его.
TMP=$(mktemp)
python3 - "$TEMPLATE" "$TMP" "$ENV_FILE" <<'PY'
import sys, re, os
src, dst, env_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(src, "r", encoding="utf-8") as f:
    body = f.read()

# Парсим env-файл, если он есть.
key_map = {}
if env_path and os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as ef:
        for line in ef:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if k.startswith("PRE_SHARED_KEY_"):
                kid = k[len("PRE_SHARED_KEY_"):].lower()
                key_map[kid] = v

# Ищем блок const STATIC_KEYS = { ... };
pattern = re.compile(
    r"(const STATIC_KEYS\s*=\s*\{)([\s\S]*?)(\n\s*\};)",
    re.MULTILINE,
)
m = pattern.search(body)
if not m:
    print("Не нашёл блок STATIC_KEYS в шаблоне", file=sys.stderr)
    sys.exit(1)

indent = "        "
# Если в env есть ключи — собираем новый блок. Иначе оставляем как есть.
if key_map:
    new_block = "const STATIC_KEYS = {\n"
    for kid, v in key_map.items():
        new_block += f'{indent}"{kid}": "{v}",\n'
    new_block = new_block.rstrip(",\n") + "\n    };"
    body = body[:m.start()] + new_block + body[m.end():]
else:
    print("[build.sh] В env нет PRE_SHARED_KEY_* — STATIC_KEYS из шаблона сохранён без изменений",
          file=sys.stderr)

with open(dst, "w", encoding="utf-8") as f:
    f.write(body)
PY
mv "$TMP" "$OUT_PATH"
chmod 644 "$OUT_PATH"

if [[ ${#KEY_MAP[@]} -gt 0 ]]; then
    echo "✅ Userscript собран: $OUT_PATH"
    echo "   Ключи из env: ${!KEY_MAP[*]}"
else
    echo "✅ Userscript собран (без env): $OUT_PATH"
    echo "   STATIC_KEYS взят из шаблона как есть — отредактируйте вручную при необходимости"
fi
