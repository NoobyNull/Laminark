# Codebase Concerns

**Analysis Date:** 2026-02-14

## Tech Debt

**Deprecated noise and signal classification files:**
- Issue: Two core classification modules marked as DEPRECATED but retained in codebase
- Files: `src/hooks/noise-patterns.ts`, `src/graph/signal-classifier.ts`
- Impact: Code clutter, potential confusion about which system is active. Comments claim "no active code imports it" but files remain
- Fix approach: Remove deprecated files entirely if truly unused. If kept for reference, move to `.archive/` directory

**Deprecated entity extraction regex path:**
- Issue: Legacy regex-based entity extraction functions marked `@deprecated` but return empty results instead of being removed
- Files: `src/graph/entity-extractor.ts` (lines 36-67), `src/graph/relationship-detector.ts` (line 89)
- Impact: Dead code retained in production. Functions like `extractEntities()` and `extractAndPersist()` exist but always return `[]`
- Fix approach: Remove deprecated functions or move to a compatibility shim module if external consumers exist

**Large complex files:**
- Issue: Several files exceed 500 lines, indicating potential complexity and maintenance burden
- Files:
  - `src/web/routes/api.ts` (1113 lines) - REST API routes
  - `src/storage/migrations.ts` (638 lines) - Schema migrations
  - `src/storage/tool-registry.ts` (599 lines) - Tool registry repository
  - `src/context/injection.ts` (509 lines) - Context injection logic
- Impact: Harder to navigate, test, and modify. High cognitive load
- Fix approach: Split `api.ts` by domain (graph routes, timeline routes, admin routes). Consider extracting migration definitions to separate files (one per migration). Extract formatting helpers from `injection.ts`

**Type safety gaps:**
- Issue: 153 instances of `any` or `unknown` types across 59 files
- Files: Heavy usage in `src/web/routes/api.ts` (19), `src/hooks/config-scanner.ts` (9), `src/graph/schema.ts` (7)
- Impact: Runtime type errors not caught at compile time. Reduced type safety benefits
- Fix approach: Replace `any` with proper types or narrow `unknown` with type guards. Start with high-usage modules (api.ts, config-scanner.ts)

**No TypeScript strict mode enforcement:**
- Issue: No visible strict compiler checks (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` NOT found, which is good, but no strict mode config verified)
- Files: `tsconfig.json` not examined for `strict: true`
- Impact: May allow unsafe null/undefined access, implicit any, etc.
- Fix approach: Enable TypeScript strict mode in `tsconfig.json` if not already enabled

## Known Bugs

**None explicitly documented:**
- No TODO/FIXME/BUG comments found in source beyond deprecation notices
- Suggests either clean codebase or undocumented issues

## Security Considerations

**Environment variable usage:**
- Risk: `process.env` accessed in 4 files, potential for undefined values or missing config
- Files: `src/shared/config.ts` (LAMINARK_DEBUG, LAMINARK_DATA_DIR), `src/index.ts`, `src/hooks/__tests__/privacy-filter.test.ts`, `src/context/injection.test.ts`
- Current mitigation: `config.ts` provides fallback defaults for LAMINARK_DATA_DIR
- Recommendations: Validate all required env vars at startup. Consider config validation with Zod schema

**API key management:**
- Risk: No API key required (uses Claude Agent SDK subscription auth)
- Files: `src/intelligence/haiku-client.ts` routes through user's Claude Code subscription
- Current mitigation: No secrets stored in codebase. Agent SDK handles auth
- Recommendations: Document clearly that ANTHROPIC_API_KEY is NOT needed (avoids user confusion)

**Privacy filter exists:**
- Files: `src/hooks/privacy-filter.ts` filters secrets before storage
- Current mitigation: Active protection against storing credentials
- Recommendations: Audit filter patterns to ensure comprehensive coverage (API keys, tokens, passwords, SSH keys)

**Database security:**
- Risk: Single SQLite database at `~/.claude/plugins/cache/laminark/data.db` contains all project data
- Files: `src/shared/config.ts` (getDbPath)
- Current mitigation: Project isolation via SHA-256 hash. File permissions inherited from user's home directory
- Recommendations: Document backup/restore procedures. Consider encryption at rest for sensitive projects

## Performance Bottlenecks

**Worker thread startup overhead:**
- Problem: 30-second timeout for embedding worker initialization
- Files: `src/analysis/worker-bridge.ts` (line 16: `STARTUP_TIMEOUT_MS = 30_000`)
- Cause: ONNX model loading in `@huggingface/transformers` is slow on first run
- Improvement path: Reduce timeout or show user feedback. Consider lazy loading (start worker on first embed request, not server startup)

**Embedding processing synchronous loop:**
- Problem: Background embedding loop processes 10 observations at a time sequentially
- Files: `src/index.ts` (lines 127-189: `processUnembedded()`)
- Cause: `for` loop with `await worker.embed(text)` -- no parallelization
- Improvement path: Use `Promise.all()` to batch embed requests. Worker already supports `embedBatch()` method (see `worker-bridge.ts`)

**Large API route file:**
- Problem: `src/web/routes/api.ts` is 1113 lines, likely complex route handlers
- Files: `src/web/routes/api.ts`
- Cause: All REST endpoints in one file
- Improvement path: Split by domain. Consider using Hono route grouping to organize endpoints

**setTimeout/setInterval usage:**
- Files: `src/web/routes/sse.ts`, `src/storage/__tests__/concurrency.test.ts`, `src/graph/__tests__/graph-wiring-integration.test.ts`, `src/intelligence/haiku-processor.ts`, `src/graph/curation-agent.ts`, `src/analysis/worker-bridge.ts`, `src/index.ts`
- Problem: Background timers could accumulate if not cleaned up properly
- Cause: Multiple polling loops (embedding, curation, SSE heartbeat)
- Improvement path: Audit timer cleanup on shutdown. Ensure `clearTimeout()` called in error paths

## Fragile Areas

**Worker thread lifecycle:**
- Files: `src/analysis/worker-bridge.ts`, `src/index.ts` (lines 74-82)
- Why fragile: Complex startup with timeout, silent failure handling, session reset on error
- Safe modification: Always handle worker.embed() returning null. Test timeout and crash scenarios
- Test coverage: Worker has tests (`src/analysis/__tests__/embedder.test.ts`) but integration coverage unclear

**Haiku session reuse:**
- Files: `src/intelligence/haiku-client.ts` (lines 25-41, 79-101)
- Why fragile: Singleton session state (`_session`). Session reset on error may create fresh session mid-processing
- Safe modification: Never modify session state outside `callHaiku()`. Test session expiration scenarios
- Test coverage: Haiku agents have unit tests but session lifecycle edge cases may be untested

**SQLite WAL mode dependency:**
- Files: `src/storage/database.ts` (lines 41-49)
- Why fragile: Code warns if WAL mode fails but continues. Synchronous NORMAL is ONLY safe with WAL
- Safe modification: Do NOT change `synchronous = NORMAL` without verifying WAL is active. If WAL unavailable, must use `synchronous = FULL`
- Test coverage: Database tests verify WAL activation (`src/storage/__tests__/database.test.ts`)

**Migration versioning:**
- Files: `src/storage/migrations.ts` (20 migrations as of analysis date)
- Why fragile: Migrations must be append-only. Changing old migrations breaks existing databases
- Safe modification: NEVER edit existing migration `up` strings. Always add new migration at end
- Test coverage: Migration tests exist (`src/storage/__tests__/database.test.ts`)

**Curation agent error handling:**
- Files: `src/graph/curation-agent.ts` (lines 72-73: "Each step is wrapped in try/catch")
- Why fragile: Claimed isolation between curation steps, but errors are accumulated in report
- Safe modification: Ensure each curation function has its own try/catch. Test what happens if database locked during curation
- Test coverage: Comprehensive tests in `src/graph/__tests__/curation-agent.test.ts`

## Scaling Limits

**Single database file:**
- Current capacity: SQLite in WAL mode handles concurrent reads well, single writer
- Limit: Write contention under heavy concurrent hook load (multiple Claude Code sessions in same project)
- Scaling path: SQLite can handle ~100k observations easily, but concurrent writes from multiple processes will serialize. Consider advisory locking or move to client-server DB for team use

**In-memory embedding worker:**
- Current capacity: One worker thread per MCP server instance
- Limit: Single-threaded embedding (though batch supported). Memory usage scales with model size (BGE Small = ~100MB)
- Scaling path: Worker pool or remote embedding service for high-throughput scenarios

**FTS5 search performance:**
- Current capacity: FTS5 handles full-text search well up to ~1M rows
- Limit: No observed limit yet, but FTS5 rebuild on schema change is expensive
- Scaling path: Partition by project already implemented. Monitor FTS rebuild time if adding columns

**Knowledge graph density:**
- Current capacity: `MAX_NODE_DEGREE = 50` enforced per entity (see `src/graph/types.ts`)
- Limit: High-degree nodes (e.g., "index.ts" file referenced by 100+ observations) get edge-capped
- Scaling path: Already handled via `enforceMaxDegree()` constraint. Consider time-decay for old edges

## Dependencies at Risk

**sqlite-vec alpha version:**
- Risk: `sqlite-vec@0.1.7-alpha.2` is pre-1.0 alpha software
- Impact: Vector search functionality. If extension fails to load, system degrades to keyword-only mode
- Migration plan: Already has graceful fallback (see `src/storage/database.ts` lines 72-78). Monitor sqlite-vec stability. Consider alternative: pgvector if migrating away from SQLite

**@anthropic-ai/claude-agent-sdk unstable API:**
- Risk: Uses `unstable_v2_createSession` from SDK version 0.2.42
- Impact: Breaking changes in SDK could break Haiku classification pipeline
- Migration plan: Pin SDK version. Monitor SDK releases. Consider wrapping SDK calls in adapter layer for easier migration

**@huggingface/transformers.js model loading:**
- Risk: ONNX runtime dependency, ~100MB model download on first run
- Impact: Embedding feature depends on runtime environment supporting ONNX. Fails in restricted environments
- Migration plan: Graceful degradation to keyword-only mode already implemented. Alternative: remote embedding API (OpenAI, Cohere)

## Missing Critical Features

**No backup/restore tooling:**
- Problem: Single SQLite database contains all project memories
- Blocks: Easy migration, disaster recovery, exporting memories to other systems
- Priority: Medium (users can copy `~/.claude/plugins/cache/laminark/data.db` manually, but not user-friendly)

**No multi-project memory merging:**
- Problem: Projects are strictly isolated by hash. No cross-project search
- Blocks: Reusing knowledge across related projects (e.g., monorepo with multiple services)
- Priority: Low (design decision for privacy, not a bug)

**No embedding model configuration:**
- Problem: BGE Small (384-dim) is hardcoded in `src/analysis/engines/local-onnx.ts`
- Blocks: Using larger/better models, multilingual embeddings
- Priority: Low (BGE Small works well for most use cases)

## Test Coverage Gaps

**Web UI routes:**
- What's not tested: `/api` routes in `src/web/routes/api.ts` (1113 lines, no corresponding test file found)
- Files: `src/web/routes/api.ts`, `src/web/routes/admin.ts`, `src/web/server.ts`
- Risk: HTTP API contract changes could break web UI without detection
- Priority: High (user-facing feature)

**MCP server lifecycle:**
- What's not tested: Server startup, shutdown, cleanup in `src/index.ts` (346 lines)
- Files: `src/index.ts` (main entry point)
- Risk: Resource leaks (worker threads, timers) on abnormal shutdown
- Priority: Medium (hard to test in unit tests, needs integration tests)

**Privacy filter edge cases:**
- What's not tested: All secret patterns, Unicode secrets, obfuscated credentials
- Files: `src/hooks/privacy-filter.ts`
- Risk: Secrets could leak into database if filter has gaps
- Priority: High (security-critical)

**Embedding worker crash recovery:**
- What's not tested: Worker process crash mid-embed, restart scenarios
- Files: `src/analysis/worker-bridge.ts`
- Risk: Observations stuck in "unembedded" state if worker crashes during batch
- Priority: Medium (graceful degradation means keyword search still works)

**Migration rollback:**
- What's not tested: No down migrations, no rollback tests
- Files: `src/storage/migrations.ts`
- Risk: Failed migration could leave database in inconsistent state
- Priority: Low (migrations are tested forward, append-only design)

**Haiku agent fallback behavior:**
- What's not tested: What happens if Haiku calls fail consistently (session expired, rate limit, etc.)
- Files: `src/intelligence/haiku-client.ts`, `src/intelligence/haiku-processor.ts`
- Risk: Observations never get classified if Haiku unavailable
- Priority: Medium (should degrade to regex fallback or mark as "uncategorized")

---

*Concerns audit: 2026-02-14*
