#!/bin/bash
# Set up TMPDIR globally to avoid EXDEV errors in Claude Code
# This allows the Claude UI plugin installation to work correctly

set -e

echo "Claude Code TMPDIR Setup"
echo "========================"
echo ""
echo "This script will configure your shell to use ~/.claude/tmp as TMPDIR,"
echo "which prevents EXDEV errors when installing plugins via Claude's UI."
echo ""

# Create the temp directory
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
TMPDIR_PATH="$CLAUDE_DIR/tmp"

mkdir -p "$TMPDIR_PATH"
echo "✓ Created directory: $TMPDIR_PATH"

# Detect shell
SHELL_NAME=$(basename "$SHELL")
if [ "$SHELL_NAME" = "zsh" ]; then
  PROFILE="$HOME/.zshrc"
elif [ "$SHELL_NAME" = "bash" ]; then
  PROFILE="$HOME/.bashrc"
else
  echo "Warning: Unsupported shell: $SHELL_NAME"
  echo "Please manually add this to your shell profile:"
  echo ""
  echo "  export TMPDIR=\$HOME/.claude/tmp"
  echo "  mkdir -p \$TMPDIR"
  echo ""
  exit 1
fi

# Check if already configured
if grep -q "export TMPDIR.*\.claude/tmp" "$PROFILE" 2>/dev/null; then
  echo ""
  echo "✓ TMPDIR already configured in $PROFILE"
else
  echo ""
  echo "Adding TMPDIR configuration to $PROFILE..."
  cat >> "$PROFILE" << 'EOF'

# Claude Code TMPDIR workaround for EXDEV errors
export TMPDIR=$HOME/.claude/tmp
mkdir -p $TMPDIR
EOF
  echo "✓ Added TMPDIR configuration to $PROFILE"
fi

echo ""
echo "✓ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Restart your terminal (or run: source $PROFILE)"
echo "  2. Restart Claude Code"
echo "  3. Try installing Laminark via Claude's UI:"
echo "     /plugin → marketplace → NoobyNull/Laminark → install"
echo ""
echo "To verify TMPDIR is set, run: echo \$TMPDIR"
echo "Expected output: $TMPDIR_PATH"

exit 0
