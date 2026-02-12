#!/bin/bash
# Bootstrap installer for Laminark plugin.
# Works around EXDEV (cross-device rename) errors on btrfs subvolumes,
# separate /tmp partitions, and other cross-device setups.
#
# Usage: curl -fsSL <raw-url> | bash
#   or:  ./scripts/install.sh

CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
SAFE_TMP="$CLAUDE_DIR/tmp"

mkdir -p "$SAFE_TMP"
TMPDIR="$SAFE_TMP" claude plugin install laminark
STATUS=$?
rm -rf "$SAFE_TMP"

exit $STATUS
