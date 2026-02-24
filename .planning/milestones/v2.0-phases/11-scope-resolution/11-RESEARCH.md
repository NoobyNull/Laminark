# Phase 11: Scope Resolution - Research

**Researched:** 2026-02-10
**Domain:** Scope-aware tool filtering, session context injection, SQL query design
**Confidence:** HIGH

## Summary

Phase 11 builds the scope resolution layer that ensures tools surfaced to Claude during session start are restricted to only those tools actually available in the current project's resolved scope. The tool registry (built in Phase 10) already stores every discovered tool with its `scope` field (`global`, `project`, `plugin`) and `project_hash`. Phase 11's job is to add a filtering layer that prevents cross-project leakage: tools registered from project A's `.mcp.json` must never appear when working in project B.

The implementation touches three main areas: (1) **scope classification correctness** -- ensuring every tool entering the registry gets an accurate scope based on its name prefix and config origin, (2) **session start context filtering** -- modifying `assembleSessionContext` or `handleSessionStart` to query scope-filtered tools and include them in the injected context, and (3) **query-time filtering** -- ensuring any tool queries (current `getForProject` and future tool-related queries) correctly implement the scope resolution rules.

The existing codebase provides almost all the infrastructure needed. The `tool-name-parser.ts` already classifies tools by prefix (`mcp__plugin_` = plugin, `mcp__` = project, bare name = global). The `config-scanner.ts` already assigns scope based on config origin (`.mcp.json` = project, `~/.claude.json` = global, `installed_plugins.json` = plugin). The `ToolRegistryRepository.getForProject()` already queries `WHERE scope = 'global' OR project_hash = ?`. The main gaps are: (a) no tool information is currently surfaced in session start context, (b) the `getForProject` query is simplistic and does not handle plugin scope correctly, and (c) there is no explicit "built-in" scope handling in the ToolScope type.

**Primary recommendation:** Add a `getAvailableForSession(projectHash)` method to `ToolRegistryRepository` with correct scope resolution SQL, create a `formatToolSection()` function in `context/injection.ts` that formats available tools for the session context output, and wire it into the existing `assembleSessionContext` flow. The ToolScope type may need a `builtin` value added or built-in tools can continue using `global` scope (which is semantically correct since built-in tools ARE globally available).

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | ^12.6.2 | Scope-filtered queries on tool_registry | Already in use for all data access |
| Node.js built-ins | n/a | No new built-in imports needed | Phase 11 is purely query and formatting logic |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^3.2.1 | Testing scope resolution logic | Unit tests for filtering correctness |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SQL-level scope filtering | Application-level filtering (fetch all, filter in JS) | SQL filtering is correct because the tool_registry may grow to hundreds of entries across many projects. Filtering at the database level avoids unnecessary data transfer and is idiomatic with the existing codebase pattern (all queries are scope-filtered in SQL). |
| Adding `builtin` to ToolScope enum | Keep using `global` for built-in tools | Built-in tools ARE global -- they are available in every session regardless of project. Adding a separate `builtin` scope creates a distinction without a practical difference in scope resolution (both are always included). The requirement SCOP-04 says "bare names are built-in" which is about classification, not scope. The existing `inferScope` correctly returns `global` for built-ins. |
| Separate `team` scope | No `team` scope in Phase 11 | The phase description mentions "built-in + global + current project + team" but the requirements (SCOP-01 through SCOP-04) do not mention `team` scope. The prior decision says "built-in, global, project, team scopes with resolution rules" but no existing infrastructure supports `team` scope. There is no `team` value in `ToolScope`, no team detection mechanism, and no `.mcp.json` variant for teams. This is likely a forward-looking note. Recommendation: do not add `team` scope in Phase 11 -- it requires infrastructure that does not exist. Document it as deferred. |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure (Modifications Only)

```
src/
  storage/
    tool-registry.ts        # MODIFIED: add getAvailableForSession() with scope resolution
  context/
    injection.ts            # MODIFIED: add formatToolSection() and wire into assembleSessionContext
  hooks/
    session-lifecycle.ts    # MODIFIED: pass toolRegistry to assembleSessionContext
  shared/
    tool-types.ts           # POSSIBLY MODIFIED: add 'builtin' classification to ToolScope if needed
```

### Pattern 1: Scope Resolution Query (getAvailableForSession)

**What:** A new repository method that returns only tools available in the current session's resolved scope.
**When to use:** During session context assembly to determine which tools to surface.

```typescript
// In src/storage/tool-registry.ts

/**
 * Returns tools available in the resolved scope for a given project.
 *
 * Scope resolution rules:
 *   - Built-in tools (scope = 'global', tool_type = 'builtin'): ALWAYS included
 *   - Global MCP/commands/skills (scope = 'global'): ALWAYS included
 *   - Project-scoped tools (scope = 'project'): ONLY if project_hash matches
 *   - Plugin tools (scope = 'plugin'): included if project_hash IS NULL (global plugin)
 *     OR project_hash matches current project
 *
 * Critical: project-scoped tools from project A MUST NOT appear for project B.
 */
getAvailableForSession(projectHash: string): ToolRegistryRow[] {
  return this.stmtGetAvailableForSession.all(projectHash, projectHash) as ToolRegistryRow[];
}

// Prepared statement:
this.stmtGetAvailableForSession = db.prepare(`
  SELECT * FROM tool_registry
  WHERE
    scope = 'global'
    OR (scope = 'project' AND project_hash = ?)
    OR (scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?))
  ORDER BY usage_count DESC, discovered_at DESC
`);
```

**Key design decision:** The existing `getForProject` method uses `WHERE scope = 'global' OR project_hash = ?` which accidentally includes ALL rows where `project_hash` matches, regardless of scope. The new method uses explicit scope-based logic with correct conditions per scope type.

### Pattern 2: Tool Section Formatting (formatToolSection)

**What:** A formatting function that converts scope-filtered tool registry rows into a compact section for the session context output.
**When to use:** Called from `assembleSessionContext` after querying available tools.

```typescript
// In src/context/injection.ts

/**
 * Formats available tools as a section for session context injection.
 *
 * Groups tools by type (MCP servers, commands, skills, plugins) and
 * annotates with scope and usage count. Respects the global token budget.
 *
 * Server-level entries (mcp__<server>__*) are shown as servers, not
 * individual tools, to keep the section compact.
 */
function formatToolSection(tools: ToolRegistryRow[]): string {
  if (tools.length === 0) return '';

  const lines: string[] = ['## Available Tools'];

  // Group by tool_type for organization
  const servers = tools.filter(t => t.tool_type === 'mcp_server');
  const commands = tools.filter(t => t.tool_type === 'slash_command');
  const skills = tools.filter(t => t.tool_type === 'skill');
  const plugins = tools.filter(t => t.tool_type === 'plugin');

  for (const server of servers) {
    const scopeTag = server.scope === 'project' ? 'project' : 'global';
    lines.push(`- MCP: ${server.server_name ?? server.name} (${scopeTag})`);
  }
  for (const cmd of commands) {
    const scopeTag = cmd.scope === 'project' ? 'project' : 'global';
    const usageStr = cmd.usage_count > 0 ? `, ${cmd.usage_count} uses` : '';
    lines.push(`- ${cmd.name} (${scopeTag}${usageStr})`);
  }
  for (const skill of skills) {
    const desc = skill.description ? ` - ${skill.description}` : '';
    lines.push(`- skill: ${skill.name}${desc}`);
  }
  for (const plugin of plugins) {
    lines.push(`- plugin: ${plugin.name}`);
  }

  return lines.join('\n');
}
```

### Pattern 3: Wiring into Session Context Assembly

**What:** Passing the tool registry into the context assembly pipeline so it can query and format available tools.
**When to use:** During SessionStart hook processing.

```typescript
// In session-lifecycle.ts handleSessionStart():
// Pass toolRegistry to assembleSessionContext

const context = assembleSessionContext(db, projectHash, toolRegistry);

// In injection.ts assembleSessionContext():
// After assembling observation sections, add tool section

export function assembleSessionContext(
  db: BetterSqlite3.Database,
  projectHash: string,
  toolRegistry?: ToolRegistryRepository,
): string {
  // ... existing observation assembly ...

  // Add available tools section
  let toolSection = '';
  if (toolRegistry) {
    const availableTools = toolRegistry.getAvailableForSession(projectHash);
    toolSection = formatToolSection(availableTools);
  }

  // Include in formatted output
  let context = formatContextIndex(lastSession, { changes, decisions, findings, references }, toolSection);

  // ... existing budget trimming logic ...
}
```

### Pattern 4: Tool Name Prefix Scope Classification (SCOP-04)

**What:** The existing `inferScope` function in `tool-name-parser.ts` already implements SCOP-04's prefix parsing rules.
**When to use:** During organic discovery (PostToolUse handler) to classify tool scope from its name.

Current implementation (already correct for SCOP-04):
```typescript
// src/hooks/tool-name-parser.ts (EXISTING -- no changes needed)
export function inferScope(toolName: string): ToolScope {
  if (toolName.startsWith('mcp__plugin_')) return 'plugin';    // SCOP-04: mcp__plugin_ prefix
  if (toolName.startsWith('mcp__')) return 'project';          // SCOP-04: mcp__ prefix (conservative default)
  return 'global';                                              // SCOP-04: bare names are built-in (global)
}
```

**Important nuance for SCOP-04:** The requirement says "bare names are built-in" and "mcp__ prefix is MCP". The existing `inferScope` returns `project` for `mcp__` tools because from the name alone, we cannot distinguish project vs global MCP servers. Config scanning provides the authoritative scope. Organic discovery's conservative `project` default is corrected by the config scanner's upsert (which sets the accurate scope from the config origin). This two-phase approach is correct and already implemented.

### Anti-Patterns to Avoid

- **Fetching all tools and filtering in application code:** The tool_registry could have hundreds of entries across many projects. Always filter in SQL, not JS. The `getAvailableForSession` method should use a WHERE clause, not `getAll()` + `.filter()`.

- **Including mcp_tool entries alongside mcp_server entries:** Config scanning discovers MCP *servers* (e.g., `mcp__playwright__*`), while organic discovery discovers individual MCP *tools* (e.g., `mcp__playwright__browser_screenshot`). The session context should show server-level entries for compactness, not every individual tool. Filter by `tool_type = 'mcp_server'` for the tool section, or deduplicate by `server_name`.

- **Hardcoding "built-in" tool list:** Built-in tools (Read, Write, Edit, Bash, etc.) are always available in every session. There is no need to list them in the "Available Tools" section -- doing so wastes context window tokens on information Claude already knows. The scope resolution should surface only MCP servers, slash commands, skills, and plugins -- things Claude may not know about.

- **Adding a `team` scope without infrastructure:** The V2 roadmap mentions "team" scope but there is no team detection, team config file, or team identifier in the current system. Do not add dead code for a scope that cannot be resolved.

- **Breaking the token budget:** The session context has a 6000-char budget (`MAX_CONTEXT_CHARS`). The tool section competes with observations for this budget. Keep the tool section compact (server names + scope labels, not full descriptions) and include it AFTER observations so it gets trimmed first when the budget is tight.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Scope resolution logic | Custom resolution engine with inheritance and override rules | Simple SQL WHERE clause with scope-based conditions | The scope rules are flat (global OR project-match OR plugin-match), not hierarchical. A SQL query with 3 OR conditions is the complete implementation. No inheritance, no override, no cascade. |
| Built-in tool enumeration | Maintained list of Claude Code built-in tools | Skip built-ins in tool section entirely | Built-in tools are always available and Claude knows about them. Enumerating them wastes tokens and creates maintenance burden as Claude Code adds new built-ins. |
| Cross-project isolation testing | Custom test framework for multi-project scenarios | Existing test pattern with multiple projectHash values | The existing tests (e.g., `injection.test.ts`) already test project isolation by creating observations with different projectHash values. The same pattern works for tool registry scoping. |

**Key insight:** Scope resolution is NOT a complex authorization system. It is a simple query filter: "show me tools where (scope is global) OR (scope is project AND project matches) OR (scope is plugin AND project matches or is global)." The total implementation is one new SQL prepared statement and one formatting function.

## Common Pitfalls

### Pitfall 1: Cross-Project Tool Leakage

**What goes wrong:** Tools registered from project A's `.mcp.json` appear in session context for project B.
**Why it happens:** The `getForProject` query uses `WHERE scope = 'global' OR project_hash = ?`. If a tool row happens to have `project_hash = NULL` (e.g., from a scanning bug), it would match `scope = 'global'` even though it should be project-scoped. Or if the scope field is wrong (tool scanned as `global` when it should be `project`), it would always be included.
**How to avoid:** The new `getAvailableForSession` query must check BOTH scope AND project_hash together. A tool with `scope = 'project'` is ONLY included when its `project_hash` matches. A tool with `scope = 'global'` is always included regardless of project_hash. Never rely on project_hash alone -- always check scope.
**Warning signs:** Users reporting "I see tools I don't have" when switching projects. Test with two different projectHash values and verify zero cross-contamination.

### Pitfall 2: Organic Discovery Overwriting Config Scanner Scope

**What goes wrong:** Config scanner correctly identifies a tool as `scope = 'global'` (from `~/.claude.json`), but organic PostToolUse discovery later sees the same tool and classifies it as `scope = 'project'` (because `inferScope` defaults `mcp__` to `project`), overwriting the correct scope.
**Why it happens:** The upsert in `ToolRegistryRepository` updates `source` on conflict: `source = excluded.source`. If the organic discovery's INSERT triggers the ON CONFLICT path, it updates the source but crucially does NOT update the scope column (the current upsert only updates `description` and `source`). This is actually SAFE by design -- the scope set by config scanning is preserved because it is not in the DO UPDATE SET clause.
**How to avoid:** Verify that the upsert's ON CONFLICT clause does NOT update the `scope` column. The current implementation (`DO UPDATE SET description = COALESCE(excluded.description, tool_registry.description), source = excluded.source`) is correct -- it preserves the original scope. Do NOT add `scope = excluded.scope` to the upsert.
**Warning signs:** After many PostToolUse events, checking if tools that were global in config scanning still show as global in the registry. Add a test for this.

### Pitfall 3: Plugin Scope Resolution Ambiguity

**What goes wrong:** A plugin installed at user scope (global) provides MCP tools. Config scanning records the plugin's MCP server with `scope = 'plugin'` and `project_hash = NULL`. The scope resolution query needs to include these tools in every project, but `scope = 'plugin' AND project_hash IS NULL` needs special handling.
**Why it happens:** Plugin scope is more complex than global/project because plugins can be installed globally (user scope) or per-project. A globally installed plugin should be available everywhere, but `scope = 'plugin'` does not inherently mean "always available."
**How to avoid:** The resolution rule for plugins must be: include if `project_hash IS NULL` (globally installed plugin) OR `project_hash = current_project` (project-scoped plugin). This is distinct from `global` scope tools and must be its own condition in the WHERE clause.
**Warning signs:** Plugin tools appearing when they should not, or disappearing when they should be available.

### Pitfall 4: Token Budget Overflow from Large Tool Lists

**What goes wrong:** A user with many MCP servers, commands, and skills has a tool section that consumes most of the 6000-char context budget, crowding out observations.
**Why it happens:** The tool section is added without considering its size relative to the remaining budget.
**How to avoid:** (1) Limit the tool section to a fixed number of entries (e.g., top 10 by usage_count). (2) Add the tool section AFTER observations in the budget trimming logic so it gets trimmed first. (3) Format compactly: one line per server/command, no descriptions by default.
**Warning signs:** Session context that shows tools but no observations, or context that is consistently at max length.

### Pitfall 5: Duplicate MCP Server Entries

**What goes wrong:** The same MCP server appears twice in the tool section -- once from config scanning (as `mcp__playwright__*` with `tool_type = 'mcp_server'`) and once from organic discovery (as individual tools like `mcp__playwright__browser_screenshot` with `tool_type = 'mcp_tool'`).
**Why it happens:** Config scanning creates server-level wildcard entries. Organic discovery creates tool-level specific entries. Both exist in the registry.
**How to avoid:** The `formatToolSection` function should (1) prefer `mcp_server` entries for display (they represent the server as a whole), (2) exclude individual `mcp_tool` entries that belong to an already-listed server, and (3) use `server_name` to group and deduplicate.
**Warning signs:** Tool section with both "MCP: playwright" and "mcp__playwright__browser_screenshot" listed.

## Code Examples

### Complete getAvailableForSession Method

```typescript
// Add to src/storage/tool-registry.ts constructor:

this.stmtGetAvailableForSession = db.prepare(`
  SELECT * FROM tool_registry
  WHERE
    scope = 'global'
    OR (scope = 'project' AND project_hash = ?)
    OR (scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?))
  ORDER BY
    CASE tool_type
      WHEN 'mcp_server' THEN 0
      WHEN 'slash_command' THEN 1
      WHEN 'skill' THEN 2
      WHEN 'plugin' THEN 3
      ELSE 4
    END,
    usage_count DESC,
    discovered_at DESC
`);

// Add method:
getAvailableForSession(projectHash: string): ToolRegistryRow[] {
  return this.stmtGetAvailableForSession.all(projectHash, projectHash) as ToolRegistryRow[];
}
```

### Complete formatToolSection Function

```typescript
// In src/context/injection.ts

import type { ToolRegistryRow } from '../shared/tool-types.js';

const MAX_TOOLS_IN_CONTEXT = 10;

function formatToolSection(tools: ToolRegistryRow[]): string {
  if (tools.length === 0) return '';

  // Deduplicate: prefer mcp_server entries over individual mcp_tool entries
  const seenServers = new Set<string>();
  const deduped: ToolRegistryRow[] = [];

  for (const tool of tools) {
    if (tool.tool_type === 'mcp_server') {
      seenServers.add(tool.server_name ?? tool.name);
      deduped.push(tool);
    }
  }
  for (const tool of tools) {
    if (tool.tool_type !== 'mcp_server') {
      // Skip individual MCP tools if their server is already listed
      if (tool.tool_type === 'mcp_tool' && tool.server_name && seenServers.has(tool.server_name)) {
        continue;
      }
      deduped.push(tool);
    }
  }

  // Exclude builtins (Claude already knows about Read, Write, Edit, Bash, etc.)
  const displayable = deduped.filter(t => t.tool_type !== 'builtin');

  if (displayable.length === 0) return '';

  const limited = displayable.slice(0, MAX_TOOLS_IN_CONTEXT);
  const lines: string[] = ['## Available Tools'];

  for (const tool of limited) {
    const scopeTag = tool.scope === 'project' ? 'project' : 'global';
    const usageStr = tool.usage_count > 0 ? `, ${tool.usage_count}x` : '';
    const desc = tool.description ? ` - ${tool.description}` : '';

    if (tool.tool_type === 'mcp_server') {
      lines.push(`- MCP: ${tool.server_name ?? tool.name} (${scopeTag}${usageStr})`);
    } else if (tool.tool_type === 'slash_command') {
      lines.push(`- ${tool.name} (${scopeTag}${usageStr})${desc}`);
    } else if (tool.tool_type === 'skill') {
      lines.push(`- skill: ${tool.name} (${scopeTag})${desc}`);
    } else if (tool.tool_type === 'plugin') {
      lines.push(`- plugin: ${tool.name} (${scopeTag})`);
    } else {
      lines.push(`- ${tool.name} (${scopeTag}${usageStr})`);
    }
  }

  if (displayable.length > MAX_TOOLS_IN_CONTEXT) {
    lines.push(`(${displayable.length - MAX_TOOLS_IN_CONTEXT} more available)`);
  }

  return lines.join('\n');
}
```

### Integration into assembleSessionContext

```typescript
// Modify src/context/injection.ts assembleSessionContext signature:

import type { ToolRegistryRepository } from '../storage/tool-registry.js';
import type { ToolRegistryRow } from '../shared/tool-types.js';

export function assembleSessionContext(
  db: BetterSqlite3.Database,
  projectHash: string,
  toolRegistry?: ToolRegistryRepository,
): string {
  debug('context', 'Assembling session context', { projectHash });

  const lastSession = getLastCompletedSession(db, projectHash);
  const changes = getRecentByKind(db, projectHash, 'change', 10, 1);
  const decisions = getRecentByKind(db, projectHash, 'decision', 5, 7);
  const findings = getRecentByKind(db, projectHash, 'finding', 5, 7);
  const references = getRecentByKind(db, projectHash, 'reference', 3, 3);

  // Query scope-filtered tools for this session
  let toolSection = '';
  if (toolRegistry) {
    try {
      const availableTools = toolRegistry.getAvailableForSession(projectHash);
      toolSection = formatToolSection(availableTools);
    } catch {
      // Tool registry is supplementary -- never block context assembly
    }
  }

  let context = formatContextIndex(
    lastSession,
    { changes, decisions, findings, references },
    toolSection,
  );

  // Existing budget trimming logic...
  // Tool section gets trimmed BEFORE observations (lowest priority)
  if (context.length > MAX_CONTEXT_CHARS && toolSection) {
    context = formatContextIndex(lastSession, { changes, decisions, findings, references }, '');
  }
  // Then existing progressive trimming for references -> findings -> changes
}
```

### Scope Isolation Test Pattern

```typescript
// Test: project-scoped tools from project A never appear in project B

it('project-scoped tools do not leak across projects', () => {
  const registry = new ToolRegistryRepository(db);

  // Register a tool for project A
  registry.upsert({
    name: 'mcp__playwright__*',
    toolType: 'mcp_server',
    scope: 'project',
    source: 'config:.mcp.json',
    projectHash: 'project-a-hash',
    description: null,
    serverName: 'playwright',
  });

  // Register a global tool
  registry.upsert({
    name: 'mcp__context7__*',
    toolType: 'mcp_server',
    scope: 'global',
    source: 'config:~/.claude.json',
    projectHash: null,
    description: null,
    serverName: 'context7',
  });

  // Query for project B
  const toolsB = registry.getAvailableForSession('project-b-hash');

  // Project B should see the global tool but NOT project A's tool
  expect(toolsB.some(t => t.server_name === 'context7')).toBe(true);
  expect(toolsB.some(t => t.server_name === 'playwright')).toBe(false);

  // Query for project A should see both
  const toolsA = registry.getAvailableForSession('project-a-hash');
  expect(toolsA.some(t => t.server_name === 'context7')).toBe(true);
  expect(toolsA.some(t => t.server_name === 'playwright')).toBe(true);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No scope filtering | Tools stored with scope but not filtered at query time | Phase 10 (current) | Registry has scope data but doesn't use it for filtering |
| No tools in context | Session context shows only observations and session summary | V1 (current) | Claude has no awareness of available project-specific tools at session start |
| getForProject = global + project_hash match | getAvailableForSession = explicit scope-based resolution | Phase 11 (planned) | Correct cross-project isolation with plugin handling |

**Current state (Phase 10):**
- Tools are stored with `scope` and `project_hash` in the registry
- `inferScope` correctly parses tool name prefixes
- Config scanner correctly assigns scope from config origin
- BUT: no tools are surfaced in session context
- BUT: `getForProject` query is naive (`scope = 'global' OR project_hash = ?`)
- BUT: no test verifies cross-project isolation

## Open Questions

1. **Should formatContextIndex signature change or should tool section be appended separately?**
   - What we know: `formatContextIndex` currently takes `(lastSession, sections)` and produces a string. Adding a `toolSection` parameter changes its signature, which affects existing tests.
   - What's unclear: Whether it's cleaner to modify `formatContextIndex` or to append the tool section after calling it.
   - Recommendation: Append the tool section after `formatContextIndex` returns, before the budget trimming loop. This avoids modifying the existing function signature and keeps tool formatting as a separate concern. The budget trimming can then strip the tool section first (by reassembling without it) before trimming observations.

2. **Should builtins appear in scope resolution at all?**
   - What we know: Built-in tools (Read, Write, Edit, Bash, Glob, Grep, etc.) are always available. Organic discovery records them with `scope = 'global'` and `tool_type = 'builtin'`. They would appear in `getAvailableForSession` results.
   - What's unclear: Whether showing "Read, Write, Edit, Bash" in the Available Tools section provides any value.
   - Recommendation: Filter out `tool_type = 'builtin'` from the formatted tool section. Claude already knows its built-in tools. Including them wastes context tokens and makes the tool section noisy. They remain in the registry for completeness but are excluded from session context display.

3. **How does the mcp__ prefix ambiguity (project vs global) resolve in practice?**
   - What we know: `inferScope('mcp__context7__query_docs')` returns `'project'` because the parser cannot distinguish project from global MCP servers by name alone. Config scanning sets the correct scope.
   - What's unclear: If a tool is first seen via organic discovery (before config scanning runs), it gets `scope = 'project'`. Will the subsequent config scan upsert correct this?
   - Recommendation: The current upsert does NOT update scope on conflict (it only updates description and source). This means the FIRST discovery sets the scope permanently. Since config scanning runs at SessionStart BEFORE any PostToolUse events in that session, config scanning will always create the entry first with the correct scope. Organic discovery's upsert becomes a no-op for scope. The edge case is: tool used in session N (organic: scope=project), then config scan runs in session N+1 (config: scope=global). The upsert will NOT fix the scope. This is a real bug. **The upsert ON CONFLICT should conditionally update scope when the new source is a config scan (higher authority than hook).** However, this may be deferred -- it only affects MCP tools in `~/.claude.json` that are used before a config scan runs.

4. **Token budget allocation: how much for tools vs observations?**
   - What we know: Current budget is 6000 chars. Observations use a variable amount.
   - What's unclear: What fraction should be reserved for the tool section.
   - Recommendation: No hard reservation. Assemble observations first (existing logic), then append tool section. If total exceeds budget, drop tool section entirely. If still over budget, apply existing progressive trimming. Tools are lower priority than recent observations for context recovery.

## Sources

### Primary (HIGH confidence)
- Laminark codebase analysis: `src/storage/tool-registry.ts` (ToolRegistryRepository with getForProject query), `src/hooks/tool-name-parser.ts` (inferScope, inferToolType, extractServerName), `src/hooks/config-scanner.ts` (scanConfigForTools with scope assignment), `src/context/injection.ts` (assembleSessionContext, formatContextIndex), `src/hooks/session-lifecycle.ts` (handleSessionStart integration), `src/shared/tool-types.ts` (ToolScope = 'global' | 'project' | 'plugin'), `src/storage/migrations.ts` (migration 16 tool_registry schema with UNIQUE index on name + COALESCE(project_hash, ''))
- Phase 10 verification report: `.planning/phases/10-tool-discovery-registry/10-VERIFICATION.md` -- confirmed all Phase 10 artifacts exist and are wired correctly
- Phase 10 research: `.planning/phases/10-tool-discovery-registry/10-RESEARCH.md` -- design decisions for registry schema, upsert semantics, NULL-safe unique index
- V2 feature research: `.planning/research/FEATURES.md` -- TS-3 Scope-Aware Tool Resolution design, scope hierarchy, resolution logic

### Secondary (MEDIUM confidence)
- Prior V2 decisions referenced in phase context: "[V2]: Tool registry needs scope awareness -- built-in, global, project, team scopes with resolution rules" -- this guides the scope categories but the `team` scope is aspirational
- Phase 10 decisions: "ToolRegistryRepository is NOT project-scoped -- queries span all scopes for cross-project discovery" -- confirms the cross-scope query pattern

### Tertiary (LOW confidence)
- `team` scope feasibility: No evidence of team scope infrastructure in Claude Code. The concept exists in the V2 roadmap but has no config surface, detection mechanism, or identifier system. LOW confidence that it can be implemented in Phase 11.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Zero new dependencies; pure query and formatting work
- Architecture: HIGH - Direct extension of existing patterns (repository methods, context formatting)
- Scope resolution rules: HIGH - Rules are simple and fully determined by existing data model
- Cross-project isolation: HIGH - SQL WHERE clause logic is straightforward to verify with tests
- Plugin scope handling: MEDIUM - Plugin scope has a nuance (global vs project-scoped plugins) that needs careful SQL
- Token budget integration: MEDIUM - Budget trimming priority (tools vs observations) is a judgment call, not a technical constraint

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (scope rules determined by data model which is stable)
