# External Integrations

**Analysis Date:** 2026-02-14

## APIs & External Services

**LLM Services:**
- Claude Haiku (via Claude Agent SDK V2) - Entity/relationship extraction, topic classification, path summarization
  - SDK/Client: `@anthropic-ai/claude-agent-sdk` (0.2.42)
  - Auth: Subscription-based (no API key required)
  - Implementation: `src/intelligence/haiku-client.ts` (persistent session with `unstable_v2_createSession()`)
  - Usage:
    - `src/intelligence/haiku-entity-agent.ts` - Entity extraction from observations
    - `src/intelligence/haiku-relationship-agent.ts` - Relationship detection between entities
    - `src/intelligence/haiku-classifier-agent.ts` - Observation classification (discovery/problem/solution)
    - `src/paths/kiss-summary-agent.ts` - Path waypoint summarization
  - Configuration: `src/config/haiku-config.ts`

**ML Model Services:**
- HuggingFace Transformers (local ONNX runtime) - Text embeddings for semantic search
  - SDK/Client: `@huggingface/transformers` (3.8.1)
  - Model: Xenova/bge-small-en-v1.5 (quantized q8, 384 dimensions)
  - Cache: `~/.laminark/models/` (managed by HuggingFace library, configurable via `env.cacheDir`)
  - Implementation: `src/analysis/engines/local-onnx.ts`
  - Fallback: Keyword-only mode if ONNX unavailable (`src/analysis/engines/keyword-only.ts`)
  - Worker: Runs in background thread (`src/analysis/worker.ts`, `src/analysis/worker-bridge.ts`)

## Data Storage

**Databases:**
- SQLite3 (better-sqlite3)
  - Connection: Single file at `~/.claude/plugins/cache/laminark/data/data.db`
  - Client: better-sqlite3 12.6.2 (synchronous SQLite bindings)
  - Extensions: sqlite-vec 0.1.7-alpha.2 (vector search with graceful degradation)
  - Mode: WAL (Write-Ahead Logging) for concurrent access between MCP server and hooks
  - Implementation: `src/storage/database.ts`
  - Schema management: `src/storage/migrations.ts`, `src/graph/schema.ts`, `src/paths/schema.ts`
  - Configuration: `busy_timeout=5000ms`, `synchronous=NORMAL`, `cache_size=-64000` (64MB), `temp_store=MEMORY`

**File Storage:**
- Local filesystem only
  - Database: `~/.claude/plugins/cache/laminark/data/data.db`
  - WAL files: `~/.claude/plugins/cache/laminark/data/data.db-wal`, `*.db-shm`
  - Embedding models: `~/.laminark/models/` (HuggingFace cache)
  - Configuration: `~/.laminark/config.json` (optional)

**Caching:**
- In-memory status cache (`src/mcp/status-cache.ts`) - 2-second TTL for graph/observation stats
- SQLite page cache (64MB via `cache_size` pragma)
- Embedding model cache (HuggingFace managed, persistent across sessions)

## Authentication & Identity

**Auth Provider:**
- Claude Agent SDK subscription auth (built-in)
  - Implementation: `unstable_v2_createSession()` in `src/intelligence/haiku-client.ts`
  - Permission mode: `'bypassPermissions'` for LLM-only calls (no tool access)
  - No API keys or external credentials required

**Project Identity:**
- SHA-256 hash of canonical project directory path
  - Implementation: `src/shared/config.ts::getProjectHash()`
  - Uses `realpathSync()` to resolve symlinks
  - First 16 hex characters used as project identifier
  - Ensures complete isolation between projects in shared database

## Monitoring & Observability

**Error Tracking:**
- None (local development tool)

**Logs:**
- Debug logging via `src/shared/debug.ts`
- Enabled via `LAMINARK_DEBUG=1` environment variable or `~/.laminark/config.json`
- Output: stderr only (stdout reserved for Claude Code hook protocol)
- Categories: `'db'`, `'mcp'`, `'hook'`, `'graph'`, `'embedding'`, `'topic'`, `'path'`

## CI/CD & Deployment

**Hosting:**
- Published to npm registry as `laminark` package
- Installed globally via `npm install -g laminark`

**CI Pipeline:**
- GitHub Actions (`.github/workflows/bump-version.yml`) - Automated version bumping

**Build Process:**
- Local: `npm run build` (tsdown bundles to `plugin/dist/`)
- Pre-publish: `prepublishOnly` script runs build automatically
- Distribution: `plugin/` directory only (specified in `package.json` files field)

## Environment Configuration

**Required env vars:**
- None (all configuration is optional with sensible defaults)

**Optional env vars:**
- `LAMINARK_DEBUG` - Enable debug logging (values: `"1"` or `"true"`)
- `LAMINARK_DATA_DIR` - Override data directory (default: `~/.claude/plugins/cache/laminark/data/`)
- `LAMINARK_WEB_PORT` - Web UI port (default: `37820`)

**Secrets location:**
- None required (subscription auth via Claude Agent SDK)

## Webhooks & Callbacks

**Incoming:**
- Claude Code hook events (synchronous stdin/stdout handlers in `src/hooks/handler.ts`):
  - `SessionStart` - Initialize session tracking, inject project metadata
  - `SessionEnd` - Finalize session, trigger cleanup
  - `PostToolUse` - Capture observations from successful tool usage
  - `PostToolUseFailure` - Track tool failures for routing decisions
  - `PreToolUse` - Inject context before tool execution (routing suggestions)
  - `Stop` - Emergency shutdown handler
- Protocol: JSON on stdin, text/JSON on stdout (only for SessionStart/PreToolUse)
- Implementation: `src/hooks/handler.ts` (direct SQLite access, no HTTP intermediary)

**Outgoing:**
- Server-Sent Events (SSE) for web UI real-time updates
  - Endpoint: `GET /api/events` (`src/web/routes/sse.ts`)
  - Broadcast channel: `src/web/routes/sse.ts::broadcast()` function
  - Events: graph changes, observation updates, path tracking
  - CORS: Localhost only (`http://localhost:*`, `http://127.0.0.1:*`)

## MCP Protocol

**MCP Server:**
- Protocol: Model Context Protocol v1.26.0 (stdio transport)
- Implementation: `src/mcp/server.ts` using `@modelcontextprotocol/sdk`
- Transport: StdioServerTransport (stdin/stdout communication)
- Server name: `laminark`, version: `0.1.0`
- Tools exposed:
  - `save_memory` - Manual observation storage (`src/mcp/tools/save-memory.js`)
  - `recall` - Search/view/purge/restore memories (`src/mcp/tools/recall.js`)
  - `query_graph` - Knowledge graph entity/relationship queries (`src/mcp/tools/query-graph.js`)
  - `graph_stats` - Graph statistics (entity/relationship counts) (`src/mcp/tools/graph-stats.js`)
  - `topic_context` - Recent stashed context threads (`src/mcp/tools/topic-context.js`)
  - `status` - System status and statistics (`src/mcp/tools/status.js`)
  - `discover_tools` - Tool discovery and listing (`src/mcp/tools/discover-tools.js`)
  - `report_tools` - Tool usage reporting (`src/mcp/tools/report-tools.js`)
  - `debug_paths` - Path debugging (waypoint inspection) (`src/mcp/tools/debug-paths.js`)

**Web UI:**
- Framework: Hono 4.11.9 with Node.js adapter
- Server: HTTP via `@hono/node-server` (`serve()` function)
- Port: 37820 (configurable via `LAMINARK_WEB_PORT`)
- CORS: Localhost only (`http://localhost:*`, `http://127.0.0.1:*`)
- Implementation: `src/web/server.ts`
- Routes:
  - `/api/health` - Health check endpoint
  - `/api/*` - REST API routes (`src/web/routes/api.ts`)
  - `/api/events` - SSE endpoint (`src/web/routes/sse.ts`)
  - `/api/admin/*` - Admin routes (`src/web/routes/admin.ts`)
  - `/*` - Static file serving from `plugin/ui/` directory
- Concurrency: Single instance per port (EADDRINUSE gracefully handled)

## Extension Architecture

**SQLite Extensions:**
- sqlite-vec (optional vector search)
  - Loaded at runtime in `src/storage/database.ts` (lines 71-78)
  - Graceful degradation if unavailable (`hasVectorSupport` flag)
  - Virtual table: `vec_observations` (384-dimensional embeddings)
  - Distance metric: Cosine similarity
- FTS5 (Full-Text Search) - Built-in SQLite extension
  - Virtual table: `observations_fts` (synchronized via triggers)
  - Tokenizer: `porter unicode61`
  - BM25 ranking for keyword search

---

*Integration audit: 2026-02-14*
