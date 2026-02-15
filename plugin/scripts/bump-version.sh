#!/bin/bash
# Bump version using MILESTONE.PHASE.SEQUENTIAL format
# Usage: ./scripts/bump-version.sh [patch|phase|milestone]
#
# Examples:
#   ./scripts/bump-version.sh patch      # 2.21.0 -> 2.21.1 (default)
#   ./scripts/bump-version.sh phase      # 2.21.0 -> 2.22.0 (new phase)
#   ./scripts/bump-version.sh milestone  # 2.21.0 -> 3.22.0 (new milestone)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

BUMP_TYPE="${1:-patch}"

CURRENT=$(node -e "console.log(require('$ROOT/package.json').version)")

# Parse current version
IFS='.' read -r MILESTONE PHASE SEQUENTIAL <<< "$CURRENT"

# Determine next version based on bump type
case "$BUMP_TYPE" in
  patch)
    NEXT="$MILESTONE.$PHASE.$((SEQUENTIAL + 1))"
    ;;
  phase)
    NEXT="$MILESTONE.$((PHASE + 1)).0"
    ;;
  milestone)
    NEXT="$((MILESTONE + 1)).$((PHASE + 1)).0"
    ;;
  *)
    echo "Error: Invalid bump type '$BUMP_TYPE'. Use: patch, phase, or milestone" >&2
    exit 1
    ;;
esac

# Update version in all files
sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" \
  "$ROOT/package.json" \
  "$ROOT/.claude-plugin/plugin.json" \
  "$ROOT/.claude-plugin/marketplace.json"

echo "$NEXT"
