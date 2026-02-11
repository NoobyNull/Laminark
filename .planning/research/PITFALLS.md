# Domain Pitfalls

**Domain:** Adding global tool discovery, scope-aware registry, and conversation-driven routing to an existing Claude Code MCP plugin (Laminark V2)
**Researched:** 2026-02-10
**Confidence:** HIGH (grounded in official Claude Code docs, Laminark source analysis, and documented ecosystem bugs)

---

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or fundamentally broken user experiences.

---

### Pitfall 1: Ghost Tool Suggestions (Recommending Unavailable Tools)

**What goes wrong:** The routing system suggests a tool that is not actually available in the current session's resolved scope. Claude attempts to call it and gets a "No such tool available" error, wasting a turn and confusing the user.

**Why it happens:** Tool availability is session-specific and depends on an intersection of scopes: built-in tools are always present, user-scope MCP servers from `~/.claude.json` apply across projects, project-scope servers from `.mcp.json` apply only in that project, and team settings from `.claude/settings.json` add more. If Laminark's registry caches a tool discovered in Project A and then suggests it in Project B where that tool's MCP server is not configured, it becomes a ghost tool.

**Laminark-specific risk:** Laminark currently stores all data in a single SQLite database with `project_hash` scoping. The knowledge graph and observations are already scoped. But a tool registry that stores "tool X exists" without also storing "tool X is available in scope Y" will leak tools across projects. The current `getProjectHash(process.cwd())` pattern (line 43 of `src/index.ts`) correctly scopes observations, but tool availability is more nuanced -- a user-scope MCP server is available in ALL projects, while a project-scope one is not.

**Consequences:**
- Claude wastes API turns on failed tool calls
- User loses trust in Laminark's recommendations quickly (one ghost suggestion is enough)
- The routing memory learns from failed calls, polluting its pattern data

**Prevention:**
- Tool registry must store scope metadata: `{ tool_name, server_name, scope: 'built_in' | 'user' | 'project' | 'local', project_hash?: string }`
- At suggestion time, compute the available tool set: `built_in UNION user_scope UNION project_scope(current_hash) UNION local_scope(current_hash)`
- NEVER suggest a tool unless it passes the availability check
- Add a "staleness" flag: re-validate tool availability on SessionStart, mark stale tools as unavailable until re-confirmed

**Detection (warning signs):**
- Any tool suggestion that does not pass through an availability filter
- Registry queries that do not include `project_hash` or scope filtering
- Tests that verify tool suggestions without mocking a specific project context

**Phase guidance:** Must be addressed in the registry design phase, before routing is built. Routing depends on a correct, scope-filtered tool set.

---

### Pitfall 2: Config File Format Confusion (MCP Servers vs Settings vs Hooks)

**What goes wrong:** Laminark parses Claude Code config files assuming a single format, but Claude Code uses different formats and locations for different purposes. MCP servers, hooks, settings, and plugins each live in different files with different schemas.

**Why it happens:** The Claude Code config landscape is genuinely confusing:

| File | Location | Contains | Format |
|------|----------|----------|--------|
| `~/.claude.json` | Home dir | User-scope MCP servers + local-scope MCP servers (per-project paths) | `{ "mcpServers": {...}, "projects": { "/path": { "mcpServers": {...} } } }` |
| `~/.claude/settings.json` | Home .claude dir | Global hooks, preferences, enabledPlugins | `{ "hooks": {...}, "env": {...}, "enabledPlugins": [...] }` |
| `~/.claude/settings.local.json` | Home .claude dir | Personal global overrides | Same as settings.json |
| `.mcp.json` | Project root | Project-scope MCP servers | `{ "mcpServers": {...} }` |
| `.claude/settings.json` | Project .claude dir | Team hooks, project preferences | `{ "hooks": {...} }` |
| `.claude/settings.local.json` | Project .claude dir | Personal project overrides | Same as settings.json |

The critical trap: `~/.claude.json` (MCP servers) vs `~/.claude/settings.json` (hooks/settings) look almost the same but serve completely different purposes. A documented bug (GitHub issue #4976) confirms even the official docs got this wrong.

**Laminark-specific risk:** Laminark's current config reading is minimal -- `src/shared/config.ts` only reads `~/.laminark/config.json` for debug settings. Expanding to read Claude Code's config files means parsing 5-6 different files with 3 different schemas. If the parser treats `~/.claude.json` as having the same structure as `.mcp.json`, it will miss per-project server blocks inside the `"projects"` key.

**Consequences:**
- Missing tools (most config files parsed correctly, but one format misunderstood)
- Runtime crashes from unexpected JSON structure
- Silent data loss: tools exist in config but are not discovered

**Prevention:**
- Define explicit TypeScript interfaces for each config file format:
  - `ClaudeJsonConfig` (for `~/.claude.json`): `{ mcpServers?: McpServers, projects?: Record<string, { mcpServers?: McpServers }> }`
  - `SettingsConfig` (for `settings.json`): `{ hooks?: HooksConfig, enabledPlugins?: string[], env?: Record<string, string> }`
  - `McpJsonConfig` (for `.mcp.json`): `{ mcpServers: McpServers }`
- Validate with Zod schemas (already a dependency) -- fail loud on unexpected structure
- Write a dedicated parser per file type, not a generic "read JSON and extract tools" function
- Handle `${VAR}` and `${VAR:-default}` environment variable expansion in `.mcp.json` (Claude Code does this natively; Laminark must too)

**Detection (warning signs):**
- A single `parseConfig()` function that handles all file types
- No Zod/schema validation on parsed config objects
- Tests that use a simplified config format instead of real-world examples

**Phase guidance:** Must be the first thing built in the discovery phase. Everything downstream depends on correct parsing.

---

### Pitfall 3: Silent Config Override (Last-Wins JSON Merging)

**What goes wrong:** When `~/.claude.json` contains multiple `mcpServers` sections (e.g., from merging JSON incorrectly), only the last section takes effect. This is a documented Claude Code bug (GitHub issue #4938). Laminark's parser must handle this the same way Claude Code does, or tool discovery will disagree with what Claude Code actually loads.

**Why it happens:** JSON does not support duplicate keys. When a JSON parser encounters duplicate keys at the same level, behavior is implementation-defined. Most JavaScript parsers (including `JSON.parse`) silently take the last value. If Laminark reads `~/.claude.json` and handles duplicate keys differently than Claude Code does, Laminark thinks tools exist that Claude Code has not loaded.

**Laminark-specific risk:** Laminark uses `JSON.parse` (via Node.js built-in), which has last-wins behavior, matching Claude Code. However, if Laminark ever switches to a streaming JSON parser, Zod `.transform()`, or a JSONC parser, the behavior could diverge. Additionally, if Laminark tries to be "smarter" by merging duplicate sections, it would create ghost tools.

**Consequences:**
- Tool registry disagrees with Claude Code's actual loaded tools
- Ghost tool suggestions (see Pitfall 1)
- Extremely hard to debug -- the config file looks correct to humans

**Prevention:**
- Use standard `JSON.parse` for all Claude Code config files (matches Claude Code's own behavior)
- Never attempt to merge duplicate keys or "fix" malformed configs
- Add a consistency check: after discovery, compare Laminark's tool list against what Claude Code reports via `list_changed` or `/mcp` output
- Document that Laminark follows Claude Code's resolution semantics exactly, not its own interpretation

**Detection (warning signs):**
- Custom JSON parsing logic beyond `JSON.parse`
- Any code that "merges" or "deep-merges" config objects from the same file
- Missing integration tests with real-world (potentially malformed) config files

**Phase guidance:** Config parsing phase. Must match Claude Code's behavior exactly.

---

### Pitfall 4: Scope Precedence Inversion (Getting the Hierarchy Wrong)

**What goes wrong:** Laminark resolves tool scope priority differently than Claude Code does, causing tools to appear with wrong scope metadata or causing Laminark to think a tool is available when Claude Code has overridden it.

**Why it happens:** Claude Code's scope precedence for MCP servers is: **local > project > user**. When servers with the same name exist at multiple scopes, local wins completely (no merging). But this is counterintuitive -- most systems use "specific overrides general" where project would beat global. In Claude Code, "local" means "per-project in `~/.claude.json`" (NOT `.claude/settings.local.json`), while "user" means "global in `~/.claude.json`". Both live in the same file but at different JSON paths.

For hooks and settings, the precedence is different: managed policy > enterprise settings > user settings > project settings > local settings. The precedence is NOT the same as MCP server precedence.

**Laminark-specific risk:** Laminark needs to track scope for tools AND hooks. If it applies MCP server precedence rules to hooks (or vice versa), routing decisions will be wrong. The system currently has a single `projectHash` concept, but scope resolution requires understanding the difference between "this tool is user-scope (available everywhere)" and "this tool is local-scope (available only here, overrides user-scope)".

**Consequences:**
- Tools shown with wrong scope labels
- Routing suggests a tool that has been overridden at a more-specific scope
- Scope-aware filtering removes tools that should be present, or keeps tools that should be hidden

**Prevention:**
- Implement scope resolution as a dedicated module with explicit precedence rules
- MCP server resolution: `local_scope(project) > project_scope(.mcp.json) > user_scope(~/.claude.json global)`
- When same-name servers exist at multiple scopes, the higher-priority scope REPLACES (not merges) the lower one
- Build a comprehensive test suite with multi-scope conflicts as the primary test scenario
- Separate scope resolution for MCP servers from scope resolution for hooks/settings

**Detection (warning signs):**
- A single "resolve scope" function that handles both MCP servers and hooks
- Tests that only exercise single-scope scenarios
- No test cases for same-name servers at different scopes

**Phase guidance:** Registry design phase. The scope model must be correct before tools are stored.

---

### Pitfall 5: Breaking the Hook Handler's Stdout Contract

**What goes wrong:** After adding global tool discovery and routing logic to the hook handler (`src/hooks/handler.ts`), debug output or error messages accidentally leak to stdout, which Claude Code interprets as context injection content and injects into Claude's conversation.

**Why it happens:** Laminark's hook handler has a critical constraint documented at line 21-25 of `handler.ts`: "Only SessionStart writes to stdout (synchronous hook -- stdout is injected into Claude's context window). All other hooks NEVER write to stdout." When adding new discovery logic (reading config files during SessionStart, computing available tools, etc.), any `console.log`, uncaught exception message, or library warning that writes to stdout becomes injected context.

**Laminark-specific risk:** This is Laminark's most fragile architectural constraint. The current handler is careful -- it uses `debug()` (which writes to a log file, not stdout) and only `process.stdout.write(context)` in SessionStart. But new tool discovery code might:
- Use `console.log` for debugging during development and forget to remove it
- Import a library that writes warnings to stdout
- Have a Zod validation error that `.toString()` includes `console.log` from a `refine()` handler
- Throw an uncaught error whose message includes the string "[object Object]" or similar noise

**Consequences:**
- Claude receives garbled context injection (config file paths, JSON fragments, error messages)
- Confusing and unpredictable Claude behavior
- Extremely hard to debug because the noise appears as if it is part of Laminark's context

**Prevention:**
- Enforce the contract with a test that captures stdout during non-SessionStart events and asserts it is empty
- All new modules imported into `handler.ts` must go through a review for stdout writes
- Wrap SessionStart discovery logic in a try-catch that only returns null (not error messages) on failure
- Use the existing `debug()` function for ALL logging; never `console.log` or `console.warn` in hook handler code paths
- Consider redirecting `process.stdout` to `/dev/null` for non-SessionStart events as a safety net

**Detection (warning signs):**
- Any `console.log` or `console.warn` call in files imported by `handler.ts`
- Missing stdout-assertion tests for hook events
- New dependencies added to the hook handler's import chain

**Phase guidance:** Every phase that touches the hook handler. Should be a CI check.

---

### Pitfall 6: Database Schema Migration Conflicts Between V1 and V2

**What goes wrong:** V2 adds new tables (tool_registry, routing_patterns, scope_metadata) to the same SQLite database that V1 uses. If users upgrade from V1 to V2, the migration must not break existing data. If it fails mid-migration, the database is left in an inconsistent state.

**Why it happens:** Laminark uses a migration system (`src/storage/migrations.ts`) that runs on database open. V1 already has migrations 001-013+. V2 needs to add new tables without altering existing ones. SQLite does not support transactional DDL for all operations (ALTER TABLE has limitations). If a V2 migration adds a column to an existing table and fails, the table may be left with the column but without the data migration.

**Laminark-specific risk:** The current database opens in `src/index.ts` line 41: `const db = openDatabase(getDatabaseConfig())`. Migrations run synchronously during `openDatabase`. The hook handler ALSO opens the database independently (line 199 of `handler.ts`). If the MCP server process and hook handler process both run migrations concurrently on first V2 startup, they could conflict despite WAL mode.

**Consequences:**
- Corrupted database on upgrade
- V1 data lost
- User must manually delete database and lose all memories

**Prevention:**
- V2 migrations should ONLY add new tables (CREATE TABLE IF NOT EXISTS), never alter existing V1 tables
- Use a migration version guard: check current migration version before running, skip if already applied
- Test the upgrade path explicitly: create a V1 database, run V2 migrations, verify all V1 data intact
- The migration runner should use a SQLite transaction wrapping all DDL for each migration step
- Consider a migration lock (exclusive SQLite lock during migration) to prevent concurrent migration from hook handler and MCP server

**Detection (warning signs):**
- Any migration that uses ALTER TABLE on existing V1 tables
- Missing upgrade-path tests (V1 DB -> V2 migration -> verify data)
- No concurrent migration protection

**Phase guidance:** Must be addressed in the very first V2 implementation phase (registry tables). Test the upgrade path before any other work.

---

## Moderate Pitfalls

Issues that cause degraded functionality but not data loss or rewrites.

---

### Pitfall 7: Config File Read Performance in Hook Handler

**What goes wrong:** The SessionStart hook reads 5-6 config files from disk to discover tools, adding enough latency that it exceeds the 2-second hook timeout, causing Claude Code to skip the context injection entirely.

**Why it happens:** The current `handleSessionStart` has a 500ms performance warning (line 43 of `session-lifecycle.ts`). Adding file reads for `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, `.mcp.json`, `.claude/settings.json`, and `.claude/settings.local.json` means 6 synchronous `readFileSync` calls plus JSON parsing. On a cold filesystem (first access after boot, NFS mounts, encrypted home directories), each read could take 10-50ms. If any config file is large (a `~/.claude.json` with many projects could be several KB), parsing adds overhead.

**Laminark-specific risk:** The hook handler opens a fresh database connection every invocation (line 199 of `handler.ts`), which already costs ~2ms. Adding 6 file reads pushes the total startup toward the danger zone. The hook handler imports NO heavy dependencies (explicitly documented in the handler: "Imports only storage modules -- NO @modelcontextprotocol/sdk (cold start overhead)"). Tool discovery code must follow this same constraint.

**Prevention:**
- Cache discovered tools in the SQLite database; do NOT re-parse config files on every SessionStart
- Only re-scan config files when they have changed (check file mtime before reading)
- Use `fs.statSync` (fast) before `fs.readFileSync` (slower) to detect changes
- Keep tool discovery code import-light: no Zod validation in the hot path, validate offline
- Set a performance budget: total SessionStart handler must complete in <200ms (current is ~100ms)

**Detection (warning signs):**
- `readFileSync` calls in the SessionStart code path without mtime caching
- Importing Zod or other validation libraries in the hook handler's critical path
- No performance benchmarks for the SessionStart handler

**Phase guidance:** Discovery phase. Build caching from the start, not as an optimization later.

---

### Pitfall 8: Tool Name Collisions Across MCP Servers

**What goes wrong:** Two different MCP servers register tools with the same name (e.g., both have a `search` tool). Laminark's registry stores them as separate entries but cannot distinguish which one to route to.

**Why it happens:** Claude Code namespaces MCP tools as `mcp__<servername>__<toolname>`. But Laminark needs to understand tool capabilities to route effectively. If it strips the namespace for readability or matching ("the user needs search capabilities"), it loses the disambiguation. Conversely, if it keeps the full namespace, the routing model must understand that `mcp__github__search_repositories` and `mcp__jira__search_issues` are different tools for different purposes.

**Laminark-specific risk:** The current self-referential filter uses `mcp__laminark__` prefix (line 70 of `handler.ts`). This shows the codebase already deals with MCP namespacing. But routing logic needs to go further: understand what each tool does, not just its name. Two tools named `search` from different servers are completely different capabilities.

**Prevention:**
- Always store and reference tools by their full Claude Code namespace: `mcp__<server>__<tool>`
- Store tool descriptions from the MCP server's tool listing alongside the name
- Route based on descriptions, not names -- use embedding similarity between user intent and tool descriptions
- Index tool descriptions in FTS5 for keyword matching, just as observations are indexed

**Detection (warning signs):**
- Registry schema that stores `tool_name` without `server_name`
- Routing logic that matches on short tool names rather than full namespaced names
- No storage of tool descriptions

**Phase guidance:** Registry design phase. The schema must include server name from the start.

---

### Pitfall 9: Cold Start -- Empty Routing Memory

**What goes wrong:** When Laminark V2 first installs (or in a new project), the routing memory is empty. Without historical patterns, every routing decision is a guess. The system either suggests nothing (useless) or suggests everything (annoying).

**Why it happens:** Conversation-driven routing learns from patterns: "when the user discusses X, they tend to use tool Y." On first run, there are zero patterns. The system must have a sensible default behavior that is useful from the very first session.

**Laminark-specific risk:** Laminark V1 already solved this for topic detection -- `AdaptiveThresholdManager` has `seedFromHistory()` (line 92 of `index.ts`). The same architectural pattern should apply to routing, but the cold-start problem is harder: topic detection has a mathematical default (use the static threshold), but routing has no mathematical default for "which tool should I suggest."

**Prevention:**
- Define built-in routing heuristics that work without any learned data:
  - "User mentions database" -> suggest database MCP tools if available
  - "User mentions GitHub/PR/issue" -> suggest GitHub MCP tools if available
  - "User mentions memory/context" -> suggest Laminark tools
- Keyword-based routing first, pattern-learned routing second (progressive enhancement)
- Set a minimum observation count before learned patterns override heuristics (e.g., need 10+ successful routing outcomes before the learned model takes over)
- Display confidence levels with suggestions: "I think you might want [tool] (low confidence -- still learning your patterns)"

**Detection (warning signs):**
- Routing module that only uses learned patterns with no fallback
- No heuristic/keyword-based routing as the default strategy
- Missing "confidence" or "certainty" signal in routing output

**Phase guidance:** Routing phase. Build the heuristic fallback FIRST, then add learning on top.

---

### Pitfall 10: Over-Suggestion Fatigue (The Clippy Problem)

**What goes wrong:** Laminark suggests tools too frequently, for conversations that do not need routing assistance. Users become annoyed and disable the feature or ignore all suggestions.

**Why it happens:** Routing systems face an asymmetric feedback problem. Missing a useful suggestion is invisible (the user never knows), but an unwanted suggestion is immediately annoying. If the system optimizes for "never miss a routing opportunity," it will over-suggest. This is the same failure mode as Clippy, browser notification prompts, and autocomplete that fires on every keystroke.

**Laminark-specific risk:** Laminark's current SessionStart injection is already in Claude's context window. Adding tool suggestions to every SessionStart or every PostToolUse event compounds the context burden. Claude Code already has MCP Tool Search (announced January 2026) that handles tool discovery when tools would exceed 10% of context. If Laminark also suggests tools, the user gets double suggestions.

**Prevention:**
- Suggestion gating: only suggest when confidence exceeds a threshold (start high, tune down)
- Rate limiting: maximum 1-2 tool suggestions per session, not per turn
- Negative signal: if a user does not use a suggested tool within N turns, reduce confidence for that pattern
- Opt-in escalation: start with zero active suggestions, only suggest when explicitly asked or when a high-confidence match occurs
- Never duplicate what Claude Code's built-in Tool Search already does -- focus on cross-session intelligence (tools the user used yesterday in a similar context) rather than intra-session discovery

**Detection (warning signs):**
- Suggestions injected on every SessionStart
- No rate limiting on suggestion frequency
- No negative feedback mechanism (unused suggestions)
- No comparison with Claude Code's native Tool Search feature

**Phase guidance:** Routing phase. Define the suggestion policy (when to suggest, how often, how to back off) before implementing the suggestion mechanism.

---

### Pitfall 11: Plugin Installation Path Resolution

**What goes wrong:** When Laminark moves from project-scoped `.mcp.json` to global installation as a Claude Code plugin, the `command` path in the MCP server config stops resolving correctly. The `ensure-deps.sh` script (which currently uses relative paths from project root) breaks when the plugin is installed in a different location.

**Why it happens:** Currently `.mcp.json` uses `"command": "bash", "args": ["./scripts/ensure-deps.sh", "node", "./dist/index.js"]` with paths relative to the project root. When installed as a global plugin, the plugin files are copied to a cache directory (Claude Code's plugin caching system). The relative paths `./scripts/` and `./dist/` would need to resolve from the cache location, not the original source.

**Laminark-specific risk:** The `ensure-deps.sh` script detects the plugin root with `PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"` which works from the project directory but may fail in the cached plugin directory if `node_modules` needs to be installed there. Additionally, native modules like `better-sqlite3` and `sqlite-vec` require platform-specific compilation -- if the plugin is installed via npm and cached, the native modules need to match the target platform.

**Consequences:**
- Laminark MCP server fails to start after global installation
- Plugin appears enabled but all tools are unavailable
- Error only visible with `claude --debug`, invisible to normal users

**Prevention:**
- Use `${CLAUDE_PLUGIN_ROOT}` in all plugin configuration paths (this is Claude Code's official variable for plugin-relative paths)
- Ensure `ensure-deps.sh` uses `${CLAUDE_PLUGIN_ROOT}` instead of `dirname $0` relative paths
- Test the full install-from-npm -> cache -> start lifecycle, not just local development
- Consider whether `npx @laminark/memory` is simpler than `bash ./scripts/ensure-deps.sh node ./dist/index.js` for the global case
- Handle the native module compilation concern: bundle prebuilt binaries or use `npm rebuild` in the ensure-deps script

**Detection (warning signs):**
- Hard-coded relative paths in `.mcp.json` or `plugin.json` MCP server configs
- `ensure-deps.sh` not using `${CLAUDE_PLUGIN_ROOT}`
- No integration test that installs the plugin from npm and starts it

**Phase guidance:** Global installation phase (first V2 phase). Must work before anything else.

---

### Pitfall 12: Stale Registry After Config Changes

**What goes wrong:** The user adds or removes an MCP server in their config while a Claude Code session is active. Laminark's tool registry does not update, so it suggests tools that no longer exist or misses new tools.

**Why it happens:** Claude Code supports `list_changed` notifications for dynamic tool updates within a running session. But config file changes (adding a new server to `~/.claude.json`) require restarting Claude Code. Laminark's registry would be populated at SessionStart and not refreshed. If the user restarts Claude Code (getting new MCP servers) but Laminark's cached registry is from a previous discovery run, the registry is stale.

**Prevention:**
- Re-run discovery on every SessionStart (but use mtime caching, see Pitfall 7)
- Mark all registry entries with a `discovered_at` timestamp
- On SessionStart, if any config file has changed since `discovered_at`, invalidate and re-scan
- Consider subscribing to MCP `list_changed` notifications to update the registry mid-session
- Add a manual refresh mechanism: a Laminark MCP tool like `refresh_registry` that forces re-scan

**Detection (warning signs):**
- Registry populated once and never refreshed
- No `discovered_at` or `last_seen_at` timestamp on registry entries
- No mechanism to detect config file changes

**Phase guidance:** Discovery phase. Build invalidation alongside initial population.

---

### Pitfall 13: Laminark Routing Conflicts with Claude Code's Native Tool Search

**What goes wrong:** Claude Code (since January 2026) has its own MCP Tool Search feature that dynamically loads tools when they would exceed 10% of context window. Laminark's routing suggestions overlap or conflict with this built-in behavior, creating confusion -- the user gets tool recommendations from two different systems that may disagree.

**Why it happens:** Tool Search is Anthropic's solution to the "too many tools" problem. It defers MCP tool loading and uses a search mechanism to find relevant tools on demand. If Laminark independently suggests tools that Tool Search has already surfaced (or worse, suggests tools that Tool Search has deliberately deferred), the two systems interfere.

**Laminark-specific risk:** Laminark is itself an MCP server. Its tools (`recall`, `save_memory`, `query_graph`, etc.) are subject to Tool Search's deferral logic. If Laminark has >10 tools and Claude Code defers some of them, Laminark's routing cannot suggest its own deferred tools because they are not loaded in context.

**Prevention:**
- Focus Laminark routing on cross-session intelligence (tools used before in similar contexts) rather than intra-session discovery (what tools exist right now)
- Do NOT duplicate Tool Search's job of listing available tools -- instead, provide memory-augmented context ("last time you worked on database migrations, you used mcp__postgres__query")
- Keep Laminark's own tool count low (6-8 tools) to stay below Tool Search's deferral threshold
- Test with `ENABLE_TOOL_SEARCH=true` to ensure Laminark works correctly when Tool Search is active

**Detection (warning signs):**
- Laminark routing that lists available tools (duplicates Tool Search)
- More than 10 Laminark MCP tools registered
- No testing with Tool Search enabled

**Phase guidance:** Routing design phase. Must define how Laminark routing complements (not competes with) Tool Search.

---

## Minor Pitfalls

Issues that are annoying but not blocking.

---

### Pitfall 14: Environment Variable Expansion in Config Parsing

**What goes wrong:** `.mcp.json` files use `${VAR}` syntax for environment variable expansion. Laminark reads the file and stores the literal string `${API_KEY}` instead of the expanded value, making tool metadata contain unexpanded variables.

**Prevention:**
- Implement the same expansion rules as Claude Code: `${VAR}` expands to env value, `${VAR:-default}` uses default if unset
- If a required variable is not set and has no default, log a warning and skip that server (do not crash)
- Only expand variables that Laminark needs for identification (server command/url); do NOT expand secrets into the database

**Phase guidance:** Config parsing phase.

---

### Pitfall 15: MCP Tool Description Token Budget

**What goes wrong:** Laminark stores full tool descriptions for routing and they consume excessive space in the database or in context injection.

**Prevention:**
- Truncate tool descriptions to 200 characters in the registry (enough for routing, not a full manual)
- When injecting tool suggestions into context, use one-line summaries, not full descriptions
- Follow the existing `estimateTokens` / `TOKEN_BUDGET` pattern from `src/mcp/token-budget.ts`

**Phase guidance:** Registry phase.

---

### Pitfall 16: Windows Path Handling in Config Discovery

**What goes wrong:** Config file paths use Unix-style paths (`~/.claude/settings.json`). On Windows, the home directory is different and path separators are backslashes.

**Prevention:**
- Use `os.homedir()` (already done in `src/shared/config.ts`) instead of hardcoding `~`
- Use `path.join()` for all config file paths
- Note that Claude Code on Windows requires `cmd /c` wrappers for npx commands -- Laminark should not need to replicate this since it reads configs rather than executing them, but should be aware of it for documentation

**Phase guidance:** Global installation phase.

---

### Pitfall 17: Managed MCP Configuration Override in Enterprise Environments

**What goes wrong:** In enterprise environments, `managed-mcp.json` takes exclusive control of MCP servers. Laminark discovers tools from user config files but those tools are actually blocked by the managed configuration.

**Prevention:**
- Check for managed config at `/Library/Application Support/ClaudeCode/managed-mcp.json` (macOS) or `/etc/claude-code/managed-mcp.json` (Linux)
- If managed config exists, ONLY discover tools from managed servers plus `allowedMcpServers` / `deniedMcpServers` in managed settings
- Log a warning when enterprise management is detected: "Managed MCP configuration detected -- discovery limited to approved servers"
- Also check `allowedMcpServers` and `deniedMcpServers` in managed settings for allowlist/denylist filtering

**Phase guidance:** Discovery phase (handle as a variant, not an afterthought).

---

### Pitfall 18: Intent Classification Cascading Errors

**What goes wrong:** A single misclassification in conversation intent analysis causes the router to send the user down the wrong tool path. The wrong tool's output then feeds back into the conversation, compounding the error -- the next routing decision is based on corrupted context.

**Prevention:**
- Never auto-invoke tools based on routing classification; only suggest (require user or Claude confirmation)
- Include an "uncertain" / "no match" classification that results in no suggestion (safe default)
- Limit routing influence to tool metadata / context enrichment, not tool invocation
- Log all routing decisions for retrospective analysis

**Phase guidance:** Routing implementation phase.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Severity | Mitigation |
|-------------|---------------|----------|------------|
| Global installation | Path resolution (#11), ensure-deps script (#11), Windows paths (#16) | Critical | Use `${CLAUDE_PLUGIN_ROOT}`, test full install lifecycle |
| Config parsing | Format confusion (#2), silent override (#3), env expansion (#14) | Critical | Per-file-type parsers with Zod schemas, match `JSON.parse` behavior |
| Registry design | Ghost tools (#1), scope precedence (#4), name collisions (#8) | Critical | Scope-aware schema with full MCP namespaces, local>project>user precedence |
| Discovery implementation | Hook performance (#7), stale registry (#12), managed config (#17) | Moderate | mtime caching, invalidation timestamps, enterprise detection |
| Routing implementation | Cold start (#9), over-suggestion (#10), Tool Search conflict (#13), cascading errors (#18) | Moderate | Heuristic fallbacks, rate limiting, complement not compete with Tool Search |
| Migration / upgrade | Schema conflicts (#6), stdout contract (#5) | Critical | CREATE TABLE IF NOT EXISTS only, upgrade-path tests, stdout assertion tests |

---

## Integration-Specific Pitfalls (Laminark V1 -> V2)

These pitfalls are specific to adding V2 features to the existing Laminark architecture.

### The Hook Handler Import Chain Must Stay Light

The hook handler (`src/hooks/handler.ts`) is Laminark's performance-critical path. It currently imports ONLY storage modules. Any V2 module imported into this chain (config parsers, registry queries, routing logic) must:
- Not import `@modelcontextprotocol/sdk` (adds ~50ms cold start)
- Not import `zod` in the hot path (validate offline, query validated data)
- Not use `console.log` anywhere in the import chain
- Complete within the existing ~100ms performance budget

### The Database Is Shared Between Two Processes

The MCP server process and hook handler process both access the same SQLite database. V1 handles this with WAL mode and busy_timeout. V2 adds more writes (tool registry updates, routing pattern storage). The busy_timeout of 5000ms (`src/shared/config.ts` line 58) should remain sufficient, but V2 must not add long-running write transactions that block the hook handler.

### The ProjectHash Is Not the Only Scope Identifier

V1 uses `projectHash` as the sole scope key. V2 needs to distinguish between user-scope (no project hash -- available everywhere), project-scope (needs project hash), and local-scope (needs project hash + user identity). This does not mean changing V1's schema, but V2 tables need a richer scope model beyond just `project_hash`.

### Session Context Injection Budget Is Already Tight

The current context injection budget is 6000 characters / ~2000 tokens (`src/context/injection.ts` line 12). Tool suggestions must fit within this budget OR use a separate injection mechanism. Adding a "Available tools for this project" section to SessionStart context will compete with observation summaries, session context, and decision history for the same token budget. Prioritize memory context over tool suggestions -- the user came to this project to work, not to read a tool catalog.

### Self-Referential Loop Risk with Routing

If Laminark routes tool suggestions through its own MCP tools (e.g., a `suggest_tools` tool), the hook handler's self-referential filter (`mcp__laminark__` prefix on line 70) will correctly skip capturing observations about Laminark's own suggestions. But if routing logic triggers via hooks (e.g., PostToolUse of a non-Laminark tool triggers a routing evaluation), care must be taken to ensure the routing evaluation itself does not generate observations that trigger further routing evaluations. This is an infinite-loop risk.

---

## Sources

- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- Official scope hierarchy, config formats, precedence rules (HIGH confidence)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide) -- Hook lifecycle, settings locations, matcher system (HIGH confidence)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) -- Plugin manifest, `CLAUDE_PLUGIN_ROOT`, caching behavior (HIGH confidence)
- [GitHub Issue #4938: Multiple mcpServers sections silently override](https://github.com/anthropics/claude-code/issues/4938) -- Silent override bug with duplicate mcpServers sections (HIGH confidence)
- [GitHub Issue #4976: Documentation incorrect about config location](https://github.com/anthropics/claude-code/issues/4976) -- Documentation error about config file locations (HIGH confidence)
- [GitHub Issue #2731: npx MCP servers fail after update](https://github.com/anthropics/claude-code/issues/2731) -- Path resolution failures after Claude Code updates (HIGH confidence)
- [MCP and Context Overload (EclipseSource)](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/) -- Too many tools degrades performance (MEDIUM confidence)
- [MCP Tool Overload Prevention (Lunar.dev)](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents) -- Tool naming collisions, ghost tools (MEDIUM confidence)
- [LLM Ignoring MCP Tools (Arsturn)](https://www.arsturn.com/blog/why-your-llm-is-ignoring-your-mcp-tools-and-how-to-fix-it) -- Tool hallucination, selection degradation after 40+ tools (MEDIUM confidence)
- [Intent Classification in Agentic LLM Apps](https://medium.com/@mr.murga/enhancing-intent-classification-and-error-handling-in-agentic-llm-applications-df2917d0a3cc) -- Routing misclassification, cascading errors (MEDIUM confidence)
- [AI Agent Routing Best Practices (Patronus)](https://www.patronus.ai/ai-agent-development/ai-agent-routing) -- Over-suggestion, hybrid routing patterns (MEDIUM confidence)
- [MCP Tool Search announcement](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide) -- Claude Code's native tool discovery (MEDIUM confidence)
- [Too Many Tools Problem](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/) -- Tool count limits, 400-500 tokens per tool definition (MEDIUM confidence)
- Laminark source code analysis: `src/index.ts`, `src/hooks/handler.ts`, `src/shared/config.ts`, `src/context/injection.ts`, `src/hooks/admission-filter.ts`, `src/hooks/session-lifecycle.ts`, `src/mcp/server.ts`, `scripts/ensure-deps.sh` (HIGH confidence -- direct code reading)

---
*Pitfalls research for Laminark V2: Global Tool Intelligence*
*Researched: 2026-02-10*
