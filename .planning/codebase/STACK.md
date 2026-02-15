# Technology Stack

**Analysis Date:** 2026-02-14

## Languages

**Primary:**
- TypeScript 5.9.3 - All source code in `src/`

**Secondary:**
- Bash - Installation scripts in `plugin/scripts/` (install.sh, update.sh, verify-install.sh, uninstall.sh)

## Runtime

**Environment:**
- Node.js >= 22.0.0 (specified in `package.json` engines field)

**Package Manager:**
- npm (evidenced by `package-lock.json`)
- Lockfile: present (`package-lock.json`)

## Frameworks

**Core:**
- Hono 4.11.9 - Web server framework for visualization UI (`src/web/server.ts`)
- @hono/node-server 1.19.9 - Node.js adapter for Hono HTTP server
- @modelcontextprotocol/sdk 1.26.0 - MCP server protocol implementation (`src/mcp/server.ts`)
- @anthropic-ai/claude-agent-sdk 0.2.42 - Claude Agent SDK for LLM calls via subscription auth

**Testing:**
- Vitest 4.0.18 - Test runner with globals enabled
- Config: `vitest.config.ts` (includes `src/**/*.test.ts`)

**Build/Dev:**
- tsdown 0.20.3 - TypeScript bundler/compiler with Rolldown backend
- tsx 4.21.0 - TypeScript execution for development scripts
- TypeScript 5.9.3 - Type checking and compilation

## Key Dependencies

**Critical:**
- better-sqlite3 12.6.2 - Synchronous SQLite database driver (`src/storage/database.ts`)
- sqlite-vec 0.1.7-alpha.2 - Vector search extension for semantic search (optional, graceful degradation)
- @huggingface/transformers 3.8.1 - Local ONNX embedding engine (BGE Small EN v1.5, `src/analysis/engines/local-onnx.ts`)
- zod 4.3.6 - Schema validation for LLM outputs and API boundaries

**Infrastructure:**
- @modelcontextprotocol/sdk 1.26.0 - MCP protocol client/server implementation
- @anthropic-ai/claude-agent-sdk 0.2.42 - Haiku LLM calls for entity/relationship extraction, topic classification
- Node.js built-ins: `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:url`

## Configuration

**Environment:**
- Optional environment variables (no `.env` file required):
  - `LAMINARK_DEBUG` - Enable debug logging (values: `"1"` or `"true"`)
  - `LAMINARK_DATA_DIR` - Override data directory (default: `~/.claude/plugins/cache/laminark/data/`)
  - `LAMINARK_WEB_PORT` - Web UI port (default: `37820`)
- Configuration file: `~/.laminark/config.json` (optional JSON, supports `{ "debug": true }`)
- No API keys required - uses Claude Agent SDK subscription auth

**Build:**
- `tsconfig.json` - TypeScript compiler config (target ES2024, module NodeNext, strict mode enabled)
- `tsdown.config.ts` - Build configuration (ESM output to `plugin/dist/`, multiple entry points)
- `vitest.config.ts` - Test configuration (globals enabled)
- `.gitignore` - Excludes `node_modules/`, `dist/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `coverage/`

## Platform Requirements

**Development:**
- Node.js >= 22.0.0
- npm (any recent version)
- SQLite3 support (via better-sqlite3 native bindings)
- Git (for repository operations)

**Production:**
- Deployed as npm global package (`npm install -g laminark`)
- Runs as Claude Code plugin (user-level MCP server + hooks)
- Binary entry points: `laminark-server` (MCP), `laminark-hook` (hooks)
- Requires Claude Code Desktop application
- Data stored in `~/.claude/plugins/cache/laminark/data/data.db`
- Embedding models cached in `~/.laminark/models/` (HuggingFace managed)

---

*Stack analysis: 2026-02-14*
