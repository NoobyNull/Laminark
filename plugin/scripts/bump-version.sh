#!/bin/bash
# Bump version using standard semver (patch | minor | major)
# Usage: ./plugin/scripts/bump-version.sh [patch|minor|major]
#
# Examples:
#   ./plugin/scripts/bump-version.sh patch   # 0.1.0 -> 0.1.1 (default)
#   ./plugin/scripts/bump-version.sh minor   # 0.1.0 -> 0.2.0
#   ./plugin/scripts/bump-version.sh major   # 0.1.0 -> 1.0.0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/../.."

BUMP_TYPE="${1:-patch}"

CURRENT=$(node -e "console.log(require('$ROOT/package.json').version)")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP_TYPE" in
  patch)
    NEXT="$MAJOR.$MINOR.$((PATCH + 1))"
    ;;
  minor)
    NEXT="$MAJOR.$((MINOR + 1)).0"
    ;;
  major)
    NEXT="$((MAJOR + 1)).0.0"
    ;;
  *)
    echo "Error: Invalid bump type '$BUMP_TYPE'. Use: patch, minor, or major" >&2
    exit 1
    ;;
esac

# Update version in all files that track it
for file in \
  "$ROOT/package.json" \
  "$ROOT/package-lock.json" \
  "$ROOT/plugin/package.json" \
  "$ROOT/plugin/.claude-plugin/plugin.json" \
  "$ROOT/.claude-plugin/marketplace.json"
do
  if [ -f "$file" ]; then
    sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" "$file"
  fi
done

echo "Bumped $CURRENT -> $NEXT"
