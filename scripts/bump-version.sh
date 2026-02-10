#!/bin/bash
# Bump integer version (V1, V2, V3, ...) across all plugin files
# Usage: ./scripts/bump-version.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

CURRENT=$(node -e "console.log(require('$ROOT/package.json').version)")
NEXT=$((CURRENT + 1))

sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" \
  "$ROOT/package.json" \
  "$ROOT/.claude-plugin/plugin.json" \
  "$ROOT/.claude-plugin/marketplace.json"

echo "$NEXT"
