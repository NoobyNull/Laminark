<!-- laminark:instructions:v1 -->
# Memory & Context

Laminark is the primary memory system. Use it before any other approach.

## Recalling Context
When you need prior work, decisions, or context:
1. `recall` — keyword search for past observations, decisions, findings
2. `query_graph` — find relationships between files, decisions, and problems
3. `topic_context` — see recently stashed conversation threads ("where was I?")
4. Only fall back to raw file searches (Grep, Glob) when Laminark has no relevant results

## Saving Context
- `save_memory` — persist important decisions, findings, and reference material
- Use appropriate `kind`: `decision` for choices made, `finding` for discoveries, `change` for modifications, `reference` for external info, `verification` for confirmed behavior

# Codebase Knowledge

Use GSD's `/gsd:map-codebase` to generate structured codebase analysis, then ingest it into Laminark for queryable access.

## Workflow
1. **Map** — run `/gsd:map-codebase` to produce `.planning/codebase/*.md` files (ARCHITECTURE, STRUCTURE, STACK, CONVENTIONS, TESTING, INTEGRATIONS, CONCERNS)
2. **Ingest** — run `ingest_knowledge` to import those docs into Laminark as searchable reference memories
3. **Query** — use `recall` or `query_graph` to pull codebase knowledge on demand instead of re-reading files

## When to Re-map
- After major architectural changes (new modules, changed entry points, dependency overhauls)
- When starting a new milestone that touches unfamiliar parts of the codebase
- If `recall` results for codebase structure feel stale or incomplete

# Tool Discovery & Suggestions

Laminark maintains a tool registry and proactively suggests relevant tools during your workflow.

## Tool Registration
Tools enter the registry through three paths — no manual setup needed:
1. **Config scan** (automatic at session start) — discovers tools from `.claude.json`, `.mcp.json`, plugin configs
2. **Organic discovery** (automatic on every tool use) — any tool Claude uses gets recorded with usage counts
3. **Session report** (prompted at session start) — call `report_available_tools` with all available tools when asked. This is the most complete source since it includes built-ins and descriptions

## Tool Suggestions
Laminark evaluates potential suggestions after each tool use, delivered as `[Laminark suggests]` banners on the next MCP tool call. Three tiers, first match wins:

| Tier | Method | What it does |
|------|--------|-------------|
| 0 | **Proactive** | Context-aware rules — checks arc stage, debug state, recent observation types. E.g., suggests debug tools when errors are detected without an active debug path |
| 1 | **Learned patterns** | Historical tool sequences from past sessions. Activates after 20+ tool events for the project |
| 2 | **Heuristic** | Keyword overlap between recent observations and tool descriptions. Cold-start fallback |

Suggestions are rate-limited: max 2 per session, 5-tool cooldown between them, minimum 3 tool calls before the first.

## Using discover_tools
When you need a tool but aren't sure what's available, use `discover_tools` with a natural language query. It searches the registry by name, description, and trigger hints. Prefer this over guessing tool names.

## Tool Health
- Tools with repeated failures (3+ in last 5 uses) are automatically **demoted** and excluded from suggestions
- A single successful use restores a demoted tool
- Tools missing from config on rescan are marked **stale**
<!-- /laminark:instructions -->
