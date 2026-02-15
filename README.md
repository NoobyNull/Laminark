# Laminark

Persistent adaptive memory for Claude Code. Automatically captures observations from your coding sessions, classifies them using LLM-based curation, and surfaces relevant context when you need it.

## Features

- Automatic observation capture via Claude Code hooks (Write, Edit, Bash, etc.)
- LLM-based classification: discoveries, problems, solutions (noise filtered out)
- Full-text search with BM25 ranking
- Knowledge graph with entity and relationship tracking
- Cross-session memory scoped per project
- Web UI for browsing observations and graph
- Duplicate detection and secret redaction

## Installation

### Quick Install (Recommended)

One command — no git clone needed:

```bash
curl -fsSL https://raw.githubusercontent.com/NoobyNull/Laminark/master/plugin/scripts/install.sh | bash
```

This will:
1. Install `laminark` globally via npm
2. Register the MCP server with Claude Code
3. Configure hooks in `~/.claude/settings.json`

### Local Installation (Development)

For local development or testing:

```bash
git clone https://github.com/NoobyNull/Laminark.git
cd Laminark
npm install
npm run build
./plugin/scripts/local-install.sh
```

This uses `npm link` so changes to the repo are reflected immediately after rebuilding.

### Manual Installation (Advanced)

If you need manual control:

```bash
# Install the package
npm install -g laminark

# Register MCP server
claude mcp add-json laminark '{"command":"laminark-server"}' -s user

# Configure hooks manually in ~/.claude/settings.json
# (see install.sh for the hook structure)
```

### Post-Installation

Verify installation:

```bash
# If installed from repo:
./plugin/scripts/verify-install.sh

# Or check manually:
npm list -g laminark && claude mcp list | grep laminark
```

Laminark will now run in every Claude Code session. Each project's memory is isolated by directory path -- Project A and Project B never share data, but each project remembers across sessions.

### Updating

```bash
npm update -g laminark
# Or: ./plugin/scripts/update.sh
```

### Uninstalling

```bash
claude mcp remove laminark -s user
npm uninstall -g laminark
# Then remove laminark hook entries from ~/.claude/settings.json
# Optionally: rm -rf ~/.laminark  (deletes all memories)
```

## Why User-Level?

- Works in every project automatically -- no per-project `.mcp.json` needed
- Cross-session memory persists for each project
- Single database at `~/.laminark/data.db`, scoped by project hash
- Hooks and MCP tools are available everywhere

## Data Storage

All data is stored in a single SQLite database at `~/.laminark/data.db`. Each project is identified by a SHA-256 hash of its directory path, ensuring complete isolation between projects.

## MCP Tools

| Tool | Description |
|------|-------------|
| `save_memory` | Save an observation with optional title |
| `recall` | Search, view, purge, or restore memories |
| `query_graph` | Query the knowledge graph for entities and relationships |
| `graph_stats` | View knowledge graph statistics |
| `topic_context` | Show recently stashed context threads |
| `status` | Show Laminark status and statistics |

## Development

```bash
npm install
npm run build
npm test
```

## Release History

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

**Versioning:** Laminark uses `MILESTONE.PHASE.SEQUENTIAL` format (e.g., v2.21.0) aligned with GSD workflow phases.

**Latest Releases:**
- **v2.21.0** (2026-02-14) - Phase 21: Graph Visualization (Milestone v2.2 complete)
- **v2.18.0** (2026-02-14) - Phase 18: Agent SDK Migration (Milestone v2.1 complete)
- **v2.16.0** (2026-02-10) - Phase 16: Staleness Management (Milestone v2.0 complete)
- **v1.8.0** (2026-02-09) - Phase 8: Web Visualization (Milestone v1.0 complete)

See [.planning/MILESTONES.md](.planning/MILESTONES.md) for comprehensive milestone documentation.

## License

ISC
