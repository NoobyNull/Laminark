#!/bin/bash
# Laminark Doctor — diagnose and fix plugin health issues
#
# Checks:
#   1. Global plugin enabled check
#   2. All runtime dependencies installed and loadable
#   3. Native addons built correctly
#   4. Dist files present and non-empty
#
# Usage: bash plugin/scripts/doctor.sh [--fix]
#   Without --fix: dry-run, reports issues only
#   With --fix:    automatically repairs what it can
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"
REPAIR_LOG="$PLUGIN_ROOT/.repair-log"
FIX=false
ISSUES=0
FIXED=0

if [[ "${1:-}" == "--fix" ]]; then
  FIX=true
fi

# --- Helpers ---

log() {
  echo "$1"
  echo "[$(date -Iseconds)] doctor: $1" >> "$REPAIR_LOG"
}

ok()   { echo "  ✓ $1"; }
warn() { echo "  ✗ $1"; ((ISSUES++)); }
info() { echo "  → $1"; }

# --- 1. Global Plugin Check ---

echo ""
echo "=== Plugin Check ==="

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
LOCAL_SETTINGS="$PROJECT_ROOT/.claude/settings.local.json"

if [ -f "$CLAUDE_SETTINGS" ]; then
  if node -e "
    const s = require('$CLAUDE_SETTINGS');
    const ep = s.enabledPlugins || {};
    const active = Object.entries(ep).some(([k,v]) => k.includes('laminark') && v === true);
    process.exit(active ? 0 : 1);
  " 2>/dev/null; then
    ok "Global Laminark plugin is enabled"
  else
    info "Global Laminark plugin is not enabled"
  fi
else
  info "No global Claude settings found"
fi

# Check if local settings accidentally disable the plugin
if [ -f "$LOCAL_SETTINGS" ]; then
  if node -e "
    const s = require('$LOCAL_SETTINGS');
    const ep = s.enabledPlugins || {};
    const disabled = Object.entries(ep).some(([k,v]) => k.includes('laminark') && v === false);
    process.exit(disabled ? 0 : 1);
  " 2>/dev/null; then
    warn "Local settings disable Laminark plugin (enabledPlugins set to false)"
    if $FIX; then
      node -e "
        const fs = require('fs');
        const s = JSON.parse(fs.readFileSync('$LOCAL_SETTINGS', 'utf-8'));
        if (s.enabledPlugins) {
          for (const key of Object.keys(s.enabledPlugins)) {
            if (key.includes('laminark')) delete s.enabledPlugins[key];
          }
          if (Object.keys(s.enabledPlugins).length === 0) delete s.enabledPlugins;
        }
        fs.writeFileSync('$LOCAL_SETTINGS', JSON.stringify(s, null, 2) + '\n');
      "
      info "Fixed: removed plugin override from local settings"
      ((FIXED++))
    else
      info "Run with --fix to remove the override"
    fi
  fi
fi

# --- 2. Runtime Dependencies ---

echo ""
echo "=== Dependency Check ==="

# Read dependencies from package.json dynamically
DEPS=$(node -e "
  const pkg = require('$PLUGIN_ROOT/package.json');
  const deps = Object.keys(pkg.dependencies || {});
  deps.forEach(d => console.log(d));
" 2>/dev/null)

if [ -z "$DEPS" ]; then
  warn "Could not read dependencies from package.json"
else
  MISSING_DEPS=()
  for dep in $DEPS; do
    if [ -d "$PLUGIN_ROOT/node_modules/$dep" ]; then
      # Check if the module resolves (try CJS require.resolve, fall back to ESM import check)
      if node -e "require.resolve('$dep', { paths: ['$PLUGIN_ROOT'] })" 2>/dev/null || \
         node --input-type=module -e "import('$dep').catch(() => process.exit(1))" 2>/dev/null || \
         [ -f "$PLUGIN_ROOT/node_modules/$dep/package.json" ]; then
        ok "$dep"
      else
        warn "$dep installed but fails to resolve"
        MISSING_DEPS+=("$dep")
      fi
    else
      warn "$dep not installed"
      MISSING_DEPS+=("$dep")
    fi
  done

  if [ ${#MISSING_DEPS[@]} -gt 0 ] && $FIX; then
    log "Reinstalling dependencies..."
    NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
    mkdir -p "$NPM_TMP"
    TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>>"$REPAIR_LOG"
    rm -rf "$NPM_TMP"
    info "Fixed: ran npm install for ${#MISSING_DEPS[@]} missing dep(s)"
    FIXED=$((FIXED + ${#MISSING_DEPS[@]}))
  fi
fi

# --- 3. Native Addons ---

echo ""
echo "=== Native Addon Check ==="

# better-sqlite3 native addon
BS3_ADDON="$PLUGIN_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -f "$BS3_ADDON" ]; then
  if node -e "require('better-sqlite3')" --prefix "$PLUGIN_ROOT" 2>/dev/null || \
     node -e "const p = '$PLUGIN_ROOT'; require(p + '/node_modules/better-sqlite3')" 2>/dev/null; then
    ok "better-sqlite3 native addon loads"
  else
    warn "better-sqlite3 addon exists but fails to load"
    if $FIX; then
      log "Rebuilding better-sqlite3..."
      npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
      if node -e "require('$PLUGIN_ROOT/node_modules/better-sqlite3')" 2>/dev/null; then
        info "Fixed: rebuilt better-sqlite3"
        ((FIXED++))
      else
        warn "Rebuild failed — may need full reinstall (rm -rf node_modules + npm install)"
      fi
    fi
  fi
else
  warn "better-sqlite3 native addon binary missing"
  if $FIX; then
    log "Rebuilding better-sqlite3 native addon..."
    npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
    if [ -f "$BS3_ADDON" ]; then
      info "Fixed: rebuilt better-sqlite3 addon"
      ((FIXED++))
    else
      warn "Rebuild did not produce addon — running full reinstall"
      rm -rf "$PLUGIN_ROOT/node_modules"
      NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
      mkdir -p "$NPM_TMP"
      TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>>"$REPAIR_LOG"
      npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
      rm -rf "$NPM_TMP"
      if [ -f "$BS3_ADDON" ]; then
        info "Fixed: full reinstall + rebuild"
        ((FIXED++))
      else
        warn "Full reinstall failed — check $REPAIR_LOG"
      fi
    fi
  fi
fi

# --- 4. Dist Files ---

echo ""
echo "=== Dist File Check ==="

DIST_FILES=(
  "dist/index.js"
  "dist/hooks/handler.js"
  "dist/analysis/worker.js"
)

for f in "${DIST_FILES[@]}"; do
  path="$PLUGIN_ROOT/$f"
  if [ -s "$path" ]; then
    ok "$f"
  elif [ -f "$path" ]; then
    warn "$f exists but is empty"
  else
    warn "$f missing"
  fi
done

# Check for stale chunk references — dist/*.mjs files referenced in index.js should exist
if [ -f "$PLUGIN_ROOT/dist/index.js" ]; then
  CHUNKS=$(grep -oP '[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+\.mjs' "$PLUGIN_ROOT/dist/index.js" 2>/dev/null | sort -u)
  for chunk in $CHUNKS; do
    if [ -f "$PLUGIN_ROOT/dist/$chunk" ]; then
      ok "chunk $chunk"
    else
      warn "chunk $chunk referenced in index.js but missing (stale build?)"
    fi
  done
fi

# --- Summary ---

echo ""
echo "=== Summary ==="
if [ $ISSUES -eq 0 ]; then
  echo "  All checks passed. Plugin is healthy."
elif $FIX; then
  echo "  Found $ISSUES issue(s), fixed $FIXED."
  REMAINING=$((ISSUES - FIXED))
  if [ $REMAINING -gt 0 ]; then
    echo "  $REMAINING issue(s) could not be auto-fixed. Check $REPAIR_LOG"
    exit 1
  fi
else
  echo "  Found $ISSUES issue(s). Run with --fix to repair."
  exit 1
fi

exit 0
