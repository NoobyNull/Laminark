#!/bin/bash
# Install Laminark via npm + MCP server registration
# Fully standalone — no git clone required.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/NoobyNull/Laminark/master/plugin/scripts/install.sh | bash
#   or:  ./plugin/scripts/install.sh

set -e

echo "Laminark Installer"
echo "=================="
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "Error: node not found"
  echo "Please install Node.js >= 22: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js >= 22 required (found v$(node -v))"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "Error: npm not found"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if already installed
CURRENT_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -n "$CURRENT_VERSION" ]; then
  echo "Currently installed: v$CURRENT_VERSION"
  echo "Reinstalling..."
fi

# Step 1: Install via npm
echo ""
echo "Installing laminark globally via npm..."
npm install -g laminark
echo "✓ npm package installed"

# Step 2: Register MCP server
echo ""
echo "Registering MCP server with Claude Code..."
claude mcp add-json laminark '{"command":"laminark-server"}' -s user
echo "✓ MCP server registered"

# Step 3: Configure hooks in ~/.claude/settings.json
echo ""
echo "Configuring hooks..."
SETTINGS_FILE="${CLAUDE_HOME:-$HOME/.claude}/settings.json"

node -e '
const fs = require("fs");
const path = require("path");
const settingsPath = process.argv[1];

// Ensure directory exists
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

if (!settings.hooks) settings.hooks = {};

const hookEvents = {
  SessionStart: { type: "command", command: "laminark-hook", statusMessage: "Loading Laminark memory context...", timeout: 10 },
  PreToolUse:   { type: "command", command: "laminark-hook", timeout: 2 },
  PostToolUse:  { type: "command", command: "laminark-hook", async: true, timeout: 30 },
  PostToolUseFailure: { type: "command", command: "laminark-hook", async: true, timeout: 30 },
  Stop:         { type: "command", command: "laminark-hook", async: true, timeout: 15 },
  SessionEnd:   { type: "command", command: "laminark-hook", async: true, timeout: 15 }
};

for (const [event, hookConfig] of Object.entries(hookEvents)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Remove any existing laminark hooks, then re-add (ensures up-to-date config)
  settings.hooks[event] = settings.hooks[event].filter(entry =>
    !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark")))
  );

  settings.hooks[event].push({
    hooks: [hookConfig]
  });
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE"

echo "✓ Hooks configured"

# Done
NEW_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "unknown")
echo ""
echo "✓ Laminark v$NEW_VERSION installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Verify with: /mcp (should show laminark tools)"

# Step 4: Recommend GSD (Get Shit Done) workflow plugin
echo ""
GSD_INSTALLED=false
if [ -d "${CLAUDE_HOME:-$HOME/.claude}/commands/gsd" ] || [ -d "${CLAUDE_HOME:-$HOME/.claude}/plugins/gsd" ]; then
  GSD_INSTALLED=true
fi

if [ "$GSD_INSTALLED" = false ]; then
  echo "Recommended: Install GSD (Get Shit Done) by @gsd-framework"
  echo "  GSD is an independent workflow plugin for Claude Code that pairs"
  echo "  well with Laminark — it handles project planning, phased execution,"
  echo "  and atomic commits while Laminark provides persistent memory."
  echo "  (GSD does not endorse or recommend Laminark — this is our suggestion.)"
  echo ""
  echo "  Install: claude plugin add gsd"
  echo "  More info: https://github.com/gsd-framework/gsd"
  echo ""
  if [ -t 0 ]; then
    read -rp "Install GSD now? [y/N] " INSTALL_GSD
    if [[ "$INSTALL_GSD" =~ ^[Yy]$ ]]; then
      echo ""
      claude plugin add gsd 2>/dev/null && echo "✓ GSD installed" || echo "  GSD install skipped (install manually with: claude plugin add gsd)"
    fi
  fi
fi

exit 0
