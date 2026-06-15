#!/usr/bin/env bash
# Устанавливает git-хуки из scripts/hooks/ в .git/hooks/.
# Идемпотентно: можно гонять сколько угодно раз.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [[ ! -d "$HOOKS_SRC" ]]; then
    echo "❌ Нет директории $HOOKS_SRC" >&2
    exit 1
fi

installed=0
for hook in "$HOOKS_SRC"/*; do
    [[ -f "$hook" ]] || continue
    name=$(basename "$hook")
    dst="$HOOKS_DST/$name"
    rm -f "$dst"
    cp "$hook" "$dst"
    chmod +x "$dst"
    echo "✅ Installed: $name"
    installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
    echo "ℹ️ Нет хуков в $HOOKS_SRC"
fi
