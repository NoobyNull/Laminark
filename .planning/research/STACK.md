# Stack Research

**Domain:** Claude Code plugin with persistent memory, vector search, adaptive semantic analysis, and web-based visualization
**Researched:** 2026-02-08
**Confidence:** HIGH (core stack) / MEDIUM (visualization, embedding strategy)

## Recommended Stack

### Runtime & Language

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22.x LTS ("Jod") | Runtime | Active LTS until April 2027. Claude Code plugins run on Node.js. Built-in WebSocket client (no ws dependency needed). 30% faster startup than Node 20. Native `node:sqlite` available but better-sqlite3 remains faster. **Confidence: HIGH** |
| TypeScript | ~5.8 | Language | Required by MCP SDK ecosystem. Erasable syntax support lets Node.js run TS directly via `--erasableSyntaxOnly`. MCP SDK is TypeScript-first. **Confidence: HIGH** |
| Zod | ^4.3 | Schema validation | Peer dependency of MCP SDK (SDK imports from `zod/v4`). Also used for tool input schemas. 57% smaller core than v3. 2kb gzipped. **Confidence: HIGH** |

### MCP SDK & Plugin Infrastructure

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| @modelcontextprotocol/sdk | ^1.26 (v1.x line) | MCP server | The official SDK. Use v1.x for production stability -- v2 split packages (`@modelcontextprotocol/server`) expected stable Q1 2026 but not yet released. When v2 ships, migrate to `@modelcontextprotocol/server` for smaller install. Stdio transport for Claude Code integration. **Confidence: HIGH** |

**Migration note:** The v2 SDK splits into `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/core`. v1.x gets bug fixes for 6+ months after v2 ships. Start on v1.x, plan migration path.

### Database & Search

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| better-sqlite3 | ^12.6 | SQLite driver | Synchronous API is 100x faster than async alternatives for local queries. Proven in Engram. Supports loadExtension() for sqlite-vec. Prebuilt binaries for all LTS Node versions. The fastest SQLite library for Node.js, period. **Confidence: HIGH** |
| SQLite FTS5 | (built into SQLite) | Full-text search | Compiled into better-sqlite3's bundled SQLite. Inverted index with BM25 ranking. Use external-content FTS5 tables backed by canonical data tables. No additional dependency. **Confidence: HIGH** |
| sqlite-vec | ^0.1.7-alpha | Vector similarity search | Pure C, zero dependencies, runs anywhere SQLite runs. Loads as a SQLite extension via `db.loadExtension()`. Successor to sqlite-vss (Faiss-based, heavier). Supports L2, cosine, and inner product distance. The only lightweight option that stays in-process with SQLite. **Confidence: MEDIUM** -- still in alpha, but the project is actively developed and the API is stable enough for production use. No realistic alternative that keeps everything in-process with SQLite. |

**FTS5 + sqlite-vec hybrid search pattern:** Use FTS5 for keyword search with BM25 scoring, sqlite-vec for semantic vector search, then combine scores with weighted reciprocal rank fusion. This is the same hybrid pattern Engram used and it works well.

### Embedding Strategy (Pluggable)

| Strategy | Technology | Version | When to Use |
|----------|------------|---------|-------------|
| **Local ONNX (default)** | @huggingface/transformers | ^3.8 | Default strategy. Runs BGE Small EN v1.5 or all-MiniLM-L6-v2 (384-dim) locally via ONNX Runtime. ~23MB model download on first use. Sub-100ms inference on CPU for short texts. No API key needed. **Confidence: HIGH** |
| **Claude piggyback** | Custom extraction | N/A | Extract semantic signals from Claude's own responses during generation. Zero additional compute -- free ride on work Claude is already doing. Requires prompt engineering to extract topic vectors/keywords. **Confidence: MEDIUM** -- novel approach, needs validation |
| **Hybrid** | Both above | N/A | Use Claude piggyback during active sessions, fall back to local ONNX for offline/batch operations. Best of both worlds. **Confidence: MEDIUM** |

**Why @huggingface/transformers over fastembed:** fastembed-js (Anush008/fastembed-js) was **archived January 15, 2026** and is no longer maintained. @huggingface/transformers v3 is the actively maintained successor ecosystem -- it uses ONNX Runtime under the hood, supports the same BGE and MiniLM models, has 1200+ pre-converted models on HuggingFace Hub, and works in Node.js with ESM+CJS. The @mastra/fastembed wrapper still exists but depends on the archived upstream.

### Web Server (Visualization UI)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| hono | ^4.11 | HTTP server for web UI | 14KB total, zero dependencies, built on Web Standards (Fetch API). 3.5x faster than Express. First-class TypeScript. Perfect for a localhost-only visualization server that must add zero perceptible overhead. Ships with built-in middleware for static files, CORS, etc. **Confidence: HIGH** |
| @hono/node-server | ^1.x | Node.js adapter | Thin adapter to run Hono on Node.js. Uses Web Standard APIs from Node 18+. **Confidence: HIGH** |

### Visualization (Web UI)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| cytoscape | ^3.33 | Knowledge graph visualization | Best balance of ease-of-use and analytical power. Built-in graph algorithms (PageRank, betweenness centrality) useful for finding important memory nodes. Force-directed layouts. Rich extension ecosystem. Canvas-based rendering handles hundreds of nodes smoothly. Can also run headlessly on Node.js for graph analysis. **Confidence: HIGH** |
| Vanilla JS + HTML | N/A | Timeline view | Build timeline with plain DOM/CSS. No framework needed for a single-page visualization. Keeps bundle tiny. Use CSS Grid + custom elements for the timeline layout. **Confidence: HIGH** |

**Why not a frontend framework (React/Vue/Svelte)?** This is a localhost developer tool, not a web app. The UI is a knowledge graph and a timeline -- two visualizations, not a complex interactive application. A framework adds build complexity, bundle size, and startup time for zero benefit. Ship HTML + JS + CSS. If complexity grows later, Preact (3KB) is the escape hatch.

### Build & Development Tools

| Tool | Version | Purpose | Notes |
|------|---------|-------|-------|
| tsdown | ^0.20 | TypeScript bundler | Successor to tsup (which is no longer maintained). Built on Rolldown (Rust). ESM-first. Zero config. Outputs ESM + CJS with type declarations. Handles the plugin's TypeScript compilation. **Confidence: MEDIUM** -- tsdown is new (0.x) but actively developed. tsup 8.5 still works if tsdown proves unstable. |
| vitest | ^4.0 | Testing | Next-gen testing powered by Vite. Out-of-box ESM + TypeScript. No config needed. Requires Node >=20. Fast parallel execution. **Confidence: HIGH** |
| TypeScript | ~5.8 | Type checking | Use `tsc --noEmit` for type checking only. Let tsdown handle compilation. **Confidence: HIGH** |

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| better-sqlite3 ^12.6 | node:sqlite (built-in) | node:sqlite requires Node 23.5.0+ (not LTS). API is less mature. Cannot load extensions yet (needed for sqlite-vec). Stick with better-sqlite3 until node:sqlite reaches parity in a future LTS. |
| better-sqlite3 ^12.6 | @libsql/client | Async API adds overhead for local operations (better-sqlite3 is ~100x faster for countPostsByUser-type queries in benchmarks). libSQL's value is remote/edge sync which we don't need (local-first tool). |
| better-sqlite3 ^12.6 | sql.js | WASM-based, 50-60% native performance. Only useful for browser/non-native environments. We're in Node.js -- use native. |
| sqlite-vec ^0.1.7 | pgvector / Pinecone / Qdrant | External database servers. Violates "SQLite single-file" constraint. Massive overhead for a personal dev tool. |
| sqlite-vec ^0.1.7 | sqlite-vss | Predecessor to sqlite-vec, based on Faiss. Heavier dependency. No longer in active development -- all effort goes to sqlite-vec. |
| @huggingface/transformers ^3.8 | fastembed ^2.1 | fastembed-js was archived January 2026. Dead project. |
| @huggingface/transformers ^3.8 | onnxruntime-node direct | Lower-level, requires manual tokenization and model loading. @huggingface/transformers wraps onnxruntime-node with proper tokenizers and model pipeline management. |
| hono ^4.11 | express ^4.x / ^5.x | Express is 5x slower, larger footprint, callback-oriented API feels dated. Express 5 exists but Hono is better in every dimension for a minimal API server. |
| hono ^4.11 | fastify ^5.x | Fastify is great for large APIs but heavier than Hono. Plugin architecture is overkill for a localhost visualization server with 5 routes. |
| cytoscape ^3.33 | sigma.js | WebGL-based, faster for 10K+ nodes. But documentation is poor and our graphs are hundreds of nodes, not thousands. Cytoscape's built-in graph algorithms (PageRank, centrality) provide actual analytical value for finding important memories. |
| cytoscape ^3.33 | vis.js | Beginner-friendly but order-of-magnitude slower than cytoscape in benchmarks. |
| cytoscape ^3.33 | d3.js | Maximum flexibility but maximum effort. D3 is a visualization toolkit, not a graph library. Cytoscape gives you graph-specific features out of the box. |
| tsdown ^0.20 | tsup ^8.5 | tsup is no longer actively maintained. Recommends tsdown as successor. |
| tsdown ^0.20 | esbuild direct | Lower-level, no TypeScript declaration generation, no zero-config experience. tsdown wraps Rolldown (which is faster than esbuild) with sensible defaults. |
| Vanilla JS | React / Vue / Svelte | Framework overhead for a 2-view visualization tool is unjustifiable. Adds build pipeline complexity. HTML + Cytoscape + vanilla JS is sufficient. |
| vitest ^4.0 | jest | Vitest is faster, native ESM/TypeScript, no config. Jest requires transforms for ESM/TS. No reason to use Jest in a new 2026 project. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| fastembed / fastembed-js | Archived January 2026. No longer maintained. Depends on dead upstream. | @huggingface/transformers ^3.8 |
| sqlite-vss | Deprecated in favor of sqlite-vec. Based on Faiss (heavy C++ dependency). | sqlite-vec ^0.1.7 |
| Python anything | Constraint: "No Python." fastembed Python, sentence-transformers, etc. are out. | Node.js-native alternatives |
| Bun | Constraint: "No Bun." Also, Claude Code runs on Node.js. | Node.js 22 LTS |
| Express | Slow, large, outdated API design. No reason to use it in 2026 for a new project. | hono ^4.11 |
| Electron / Tauri | Out of scope per PROJECT.md. Browser-based web UI keeps it simple. | hono + browser |
| Heavy ML frameworks (PyTorch, TensorFlow.js) | Violates lightweight constraint. GB-scale dependencies. This is what made Engram heavy. | @huggingface/transformers (ONNX) |
| React / Vue / Angular | Overkill for 2 visualization views on localhost. Adds 50-200KB+ and build complexity. | Vanilla JS + Cytoscape |
| node:sqlite | Requires Node 23.5+ (not LTS). Cannot load extensions. Immature API. | better-sqlite3 ^12.6 |
| @libsql/client | Async overhead for local ops. Remote sync not needed. | better-sqlite3 ^12.6 |

## Stack Patterns by Variant

**If MCP SDK v2 ships stable during development:**
- Migrate from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/server`
- Smaller install, cleaner imports, same API concepts
- Because: v1 will get 6+ months of patches, but v2 is the future

**If sqlite-vec alpha proves too unstable:**
- Use raw SQLite BLOB columns with manual cosine similarity in SQL
- Store float32 vectors as BLOBs, compute `vec_distance_cosine()` equivalent with a custom SQL function registered via better-sqlite3
- Because: sqlite-vec's core value is the virtual table abstraction and SIMD acceleration. For small datasets (<100K vectors), brute-force cosine in SQL is acceptable

**If @huggingface/transformers is too heavy at startup:**
- Lazy-load the embedding pipeline only when first needed
- Use Claude piggyback strategy as primary during active sessions
- Fall back to batch ONNX inference during idle periods
- Because: the ONNX runtime is ~50MB of native binaries. Lazy loading eliminates startup cost

**If tsdown 0.x proves unstable:**
- Fall back to tsup ^8.5 (still works, just not actively maintained)
- Or use esbuild directly with a thin build script
- Because: tsdown is 0.x software. Having a fallback is prudent

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| better-sqlite3 ^12.6 | Node.js 22 LTS | Prebuilt binaries available for LTS versions |
| better-sqlite3 ^12.6 | sqlite-vec ^0.1.7 | Load via `db.loadExtension()`. sqlite-vec npm package provides the compiled extension. |
| @modelcontextprotocol/sdk ^1.26 | zod ^4.3 (v4) | SDK imports from `zod/v4`. Backwards compatible with Zod v3.25+. |
| @huggingface/transformers ^3.8 | onnxruntime-node ^1.24 | Transformers.js uses ONNX Runtime under the hood. onnxruntime-node is a transitive dependency. |
| @huggingface/transformers ^3.8 | Node.js 22 LTS | ESM + CJS both supported |
| hono ^4.11 | @hono/node-server ^1.x | Required adapter for Node.js. Uses Web Standard APIs from Node 18+. |
| vitest ^4.0 | Node.js >=20 | Requires Vite >=6. Node 22 LTS satisfies this. |
| tsdown ^0.20 | TypeScript ~5.8 | Built on Rolldown (Rust). Handles TS compilation and bundling. |
| cytoscape ^3.33 | Any modern browser | Canvas-based rendering. No WebGL required (unlike sigma.js). |

## Installation

```bash
# Core runtime + MCP
npm install @modelcontextprotocol/sdk zod better-sqlite3 sqlite-vec

# Web server
npm install hono @hono/node-server

# Embedding (lazy-loaded, but install upfront)
npm install @huggingface/transformers

# Visualization (served as static assets, not bundled server-side)
# cytoscape loaded via <script> tag or bundled into web UI assets

# Dev dependencies
npm install -D typescript @types/better-sqlite3 tsdown vitest
```

## Architecture Implications

1. **Single process, multiple concerns:** The plugin runs as one Node.js process serving both MCP (stdio) and web UI (HTTP on localhost). Hono's lightweight footprint makes this viable without bloat.

2. **Synchronous database, async everything else:** better-sqlite3's sync API is intentional -- SQLite queries complete in microseconds on local disk. The async overhead of libSQL/node-sqlite3 adds latency for zero benefit in a local tool. Use sync for DB, async for HTTP and embedding inference.

3. **Lazy embedding initialization:** @huggingface/transformers downloads and caches models on first use (~23MB for BGE Small). Initialize the pipeline lazily on first semantic operation, not at plugin startup. This keeps startup instant.

4. **Static web assets:** The visualization UI is plain HTML/JS/CSS served by Hono's static middleware. No build step needed for the frontend. Cytoscape loaded from a local copy or CDN fallback.

5. **Plugin lifecycle:** Claude Code plugins use `.mcp.json` for MCP server config (stdio transport) and `hooks/hooks.json` for event hooks (PostToolUse, SessionStart, SessionEnd, etc.). The plugin structure is: `.claude-plugin/plugin.json` (manifest), `.mcp.json` (MCP config), `hooks/` (event handlers), `skills/` (slash commands), `commands/` (user commands).

## Sources

- [Claude Code Plugin Docs](https://code.claude.com/docs/en/plugins) -- Plugin structure, hooks, MCP integration (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- PostToolUse, SessionStart, notification hooks (HIGH confidence)
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- v1.26.0, v2 roadmap, split packages (HIGH confidence)
- [MCP SDK npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- v1.26.0 latest (HIGH confidence)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) -- v12.6.2 latest (HIGH confidence)
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec) -- v0.1.7-alpha.2, pure C, zero deps (MEDIUM confidence -- alpha)
- [sqlite-vec Node.js docs](https://alexgarcia.xyz/sqlite-vec/js.html) -- Node.js integration, loadExtension() API (MEDIUM confidence)
- [SQLite FTS5 docs](https://www.sqlite.org/fts5.html) -- BM25, external content tables (HIGH confidence)
- [fastembed-js GitHub](https://github.com/Anush008/fastembed-js) -- Archived January 15, 2026 (HIGH confidence)
- [@huggingface/transformers npm](https://www.npmjs.com/package/@huggingface/transformers) -- v3.8.1, ONNX Runtime, 1200+ models (HIGH confidence)
- [SQLite Driver Benchmark](https://sqg.dev/blog/sqlite-driver-benchmark) -- better-sqlite3 vs libSQL vs node:sqlite performance (MEDIUM confidence)
- [Hono.js](https://hono.dev/) -- v4.11.9, 14KB, Web Standards, 3.5x faster than Express (HIGH confidence)
- [Cytoscape.js](https://js.cytoscape.org/) -- v3.33.1, graph theory library, built-in algorithms (HIGH confidence)
- [Graph Library Comparison](https://memgraph.com/blog/you-want-a-fast-easy-to-use-and-popular-graph-visualization-tool) -- Cytoscape vs sigma vs vis.js benchmarks (MEDIUM confidence)
- [Vitest](https://vitest.dev/) -- v4.0.18, Vite-powered, native ESM+TS (HIGH confidence)
- [tsdown GitHub](https://github.com/rolldown/tsdown) -- v0.20.3, Rolldown-powered, tsup successor (MEDIUM confidence -- 0.x)
- [tsup GitHub](https://github.com/egoist/tsup) -- v8.5.1, no longer actively maintained (HIGH confidence)
- [Node.js 22 LTS](https://nodejs.org/en/about/previous-releases) -- Active LTS until April 2027 (HIGH confidence)
- [TypeScript 5.8](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/) -- Erasable syntax, ESM require() support (HIGH confidence)
- [Zod v4](https://zod.dev/v4) -- v4.3.6, 2kb core, 57% smaller than v3 (HIGH confidence)

---
*Stack research for: Memorite -- Claude Code persistent adaptive memory plugin*
*Researched: 2026-02-08*
