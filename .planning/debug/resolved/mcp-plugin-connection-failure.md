---
status: resolved
trigger: "mcp-plugin-connection-failure"
created: 2026-02-09T00:00:00Z
updated: 2026-02-10T03:01:00Z
---

## Current Focus

hypothesis: CONFIRMED and FIXED
test: N/A
expecting: N/A
next_action: Archive and commit

## Symptoms

expected: Laminark MCP plugin connects successfully and provides memory/recall/graph tools
actual: "Failed to reconnect to plugin:laminark:laminark." error when running /mcp command
errors: "Failed to reconnect to plugin:laminark:laminark."
reproduction: Running /mcp in Claude Code shows the failure
started: Has never worked - first-time setup/installation issue

## Eliminated

- hypothesis: Plugin cache directory missing or incomplete
  evidence: Cache at ~/.claude/plugins/cache/laminark/laminark/2/ exists with dist/, node_modules/, scripts/, .mcp.json, plugin.json
  timestamp: 2026-02-10T02:55:00Z

- hypothesis: installed_plugins.json has wrong paths or structure
  evidence: Points to version "2" path which exists and contains full plugin files
  timestamp: 2026-02-10T02:55:00Z

- hypothesis: MCP server code itself is broken (can't create StdioServerTransport)
  evidence: Debug log shows "MCP server started on stdio transport" -- the MCP part works fine
  timestamp: 2026-02-10T02:56:00Z

## Evidence

- timestamp: 2026-02-10T02:55:00Z
  checked: installed_plugins.json and cache directory structure
  found: Plugin registered at version 2, cache dir has dist/, node_modules/, scripts/
  implication: Plugin installation is structurally correct

- timestamp: 2026-02-10T02:56:00Z
  checked: Running MCP server with LAMINARK_DEBUG=1 and /dev/null stdin
  found: |
    1. MCP server starts successfully: "MCP server started on stdio transport"
    2. Web server crashes with EADDRINUSE on port 37820 (already in use)
    3. uncaughtException handler catches this and calls process.exit(1)
    4. This kills the entire process including the working MCP server
  implication: Web server port conflict is the PRIMARY crash cause

- timestamp: 2026-02-10T02:56:30Z
  checked: Running with LAMINARK_WEB_PORT=0 to avoid port conflict
  found: |
    1. Port conflict avoided, server stays alive longer
    2. Worker fails: "Cannot find module '.../dist/worker.js'"
    3. Worker file is actually at dist/analysis/worker.js, not dist/worker.js
    4. worker-bridge.ts resolves path as join(thisDir, 'worker.js') where thisDir=dist/
  implication: Worker path resolution is wrong, but this is non-fatal (worker failure is caught)

- timestamp: 2026-02-10T02:57:00Z
  checked: startWebServer() in src/web/server.ts
  found: No error handling on serve() call. EADDRINUSE becomes uncaught exception.
  implication: The web server must handle port-in-use errors gracefully instead of crashing the process

- timestamp: 2026-02-10T03:00:00Z
  checked: Rebuilt dist after both fixes, tested with LAMINARK_DEBUG=1
  found: |
    1. Port 37820 in use, trying 37821 -- graceful port fallback works
    2. Web server listening on http://localhost:37821 -- auto-increment success
    3. Worker ready {"engineName":"bge-small-en-v1.5-q8","dimensions":384} -- worker path fixed
    4. MCP server started on stdio transport -- MCP server stays alive
    5. MCP initialize handshake returns correct JSON-RPC response with 5 tools
  implication: Both fixes verified working

- timestamp: 2026-02-10T03:00:30Z
  checked: Full test suite (npm test)
  found: 621/622 tests pass. 1 pre-existing failure (.mcp.json test expects ${CLAUDE_PLUGIN_ROOT} format)
  implication: Zero regressions from our changes

## Resolution

root_cause: |
  PRIMARY: startWebServer() in src/web/server.ts calls serve() with no error handling.
  When port 37820 is already in use (e.g., from another Laminark instance or a previous
  run that didn't shut down cleanly), the EADDRINUSE error becomes an uncaught exception,
  triggering process.on('uncaughtException') in src/index.ts which calls process.exit(1)
  -- killing the entire process including the working MCP server. Claude Code then sees
  the process die and reports "Failed to reconnect to plugin:laminark:laminark."

  SECONDARY: worker-bridge.ts resolves worker.js path relative to import.meta.url of
  the running file (dist/index.js after bundling), but tsdown outputs the worker entry
  to dist/analysis/worker.js preserving the source directory structure. The path
  join(thisDir, 'worker.js') looks for dist/worker.js which doesn't exist. This prevents
  the embedding worker from starting (no vector search, keyword-only mode).

fix: |
  1. src/web/server.ts: Added error handling to startWebServer() that catches EADDRINUSE
     and auto-retries on incrementing ports (up to MAX_PORT_RETRIES=10). If all ports fail,
     logs a warning and continues without the web server -- MCP is the primary function.
  2. src/analysis/worker-bridge.ts: Fixed worker path from join(thisDir, 'worker.js') to
     join(thisDir, 'analysis', 'worker.js') to match the actual build output location.
  3. Rebuilt dist and copied to plugin cache.

verification: |
  - MCP server starts and stays alive even when port 37820 is occupied
  - Web server auto-falls back to port 37821 on conflict
  - Worker loads embedding model successfully (bge-small-en-v1.5-q8, 384 dimensions)
  - MCP initialize handshake returns valid JSON-RPC with protocolVersion 2024-11-05
  - tools/list returns all 5 tools: save_memory, recall, topic_context, query_graph, graph_stats
  - 621/622 tests pass (1 pre-existing failure unrelated to our changes)

files_changed:
  - src/web/server.ts
  - src/analysis/worker-bridge.ts
  - dist/index.js (rebuilt)
  - dist/index.js.map (rebuilt)
