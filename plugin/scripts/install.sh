#!/bin/bash
# Install Laminark via npm + MCP server registration
#
# Usage: curl -fsSL <raw-url> | bash
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
  echo ""
  read -p "Update/reinstall? (Y/n): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Installation cancelled."
    exit 0
  fi
fi

# Step 1: Install via npm
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
const settingsPath = process.argv[1];

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

  // Check if laminark hook already exists for this event
  const exists = settings.hooks[event].some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark"))
  );

  if (!exists) {
    settings.hooks[event].push({
      hooks: [hookConfig]
    });
  }
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

exit 0
