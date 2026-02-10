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

## Installation (Recommended: User-Level Plugin)

User-level installation is recommended. This enables Laminark across all your projects with data automatically isolated per project directory.

```bash
# Install as a Claude Code plugin (user-level)
claude plugin add /path/to/Laminark
```

Or if installing from a clone:

```bash
git clone https://github.com/NoobyNull/Laminark.git
cd Laminark
npm install
npm run build
claude plugin add .
```

After installation, enable the plugin:

```bash
claude plugin enable laminark
```

Laminark will now run in every Claude Code session. Each project's memory is isolated by directory path -- Project A and Project B never share data, but each project remembers across sessions.

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

## License

ISC
