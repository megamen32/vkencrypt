#!/usr/bin/env bash
# Чистит dist/ — собранные userscript-файлы.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -rf "$SCRIPT_DIR/dist"
echo "✅ dist/ очищен"
