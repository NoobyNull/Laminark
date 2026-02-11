# Feature Landscape: Tool Discovery, Registry, and Conversation-Driven Routing

**Domain:** Global tool intelligence layer for Claude Code (Laminark V2)
**Researched:** 2026-02-10
**Focus:** NEW features only -- tool discovery, scope-aware registry, conversation-driven routing
**Confidence:** MEDIUM-HIGH (Claude Code platform mechanics verified via official docs; routing intelligence patterns well-established but novel in this application context)

---

## Context: What Already Exists in Laminark V1

These features are BUILT and SHIPPING. V2 features build on this infrastructure:

- SQLite database with WAL mode, FTS5, sqlite-vec (single file at `~/.claude/plugins/cache/laminark/data/data.db`)
- Project scoping via SHA-256 hash of canonical project path (`getProjectHash()`)
- `project_metadata` table tracking project_hash -> project_path -> last_seen_at
- Observation pipeline: hooks -> admission filter -> save guard -> observations table
- Knowledge graph: `graph_nodes` (6 entity types) + `graph_edges` (8 relationship types)
- Embedding infrastructure: ONNX local model + piggyback, background embedding loop
- Session lifecycle: SessionStart context injection, SessionEnd summaries, Stop hook
- MCP tools: recall, save_memory, topic_context, query_graph, graph_stats, status
- Web UI: graph visualization, timeline, SSE broadcasts
- Hook handler: PostToolUse/PostToolUseFailure/SessionStart/SessionEnd/Stop

**Key infrastructure constraint:** Laminark runs as an MCP server per-project (spawned by Claude Code when the project is opened). It has NO global daemon. The hook handler (`handler.ts`) opens its own database connection per invocation. All data flows through a single shared SQLite database.

---

## Table Stakes

Features users expect from a "global tool intelligence layer." Missing these means the product feels broken or pointless.

### TS-1: Global Installation (Zero-Config Presence)

**Why Expected:** The entire premise of V2 is "open any project, Laminark is there." If users must manually configure `.mcp.json` per project, this is just V1 with extra steps. Claude Code supports `user` scope MCP servers in `~/.claude.json` that are available across all projects.

**Complexity:** LOW

**Dependencies on Existing Laminark:**
- Existing `getDatabaseConfig()` already resolves to `~/.claude/plugins/cache/laminark/data/data.db` (global path)
- Existing `getProjectHash(process.cwd())` already scopes data per-project
- Existing hook handler already opens its own DB connection per invocation

**What This Actually Means:**
- Laminark MCP server configured at `user` scope in `~/.claude.json` (not per-project `.mcp.json`)
- Hook configuration at `~/.claude/settings.json` (global hooks, not per-project)
- On session start in ANY project, Laminark automatically registers the project in `project_metadata`
- No per-project setup required. It just works.

**User Experience:**
```
# One-time setup:
claude mcp add --scope user --transport stdio laminark -- node /path/to/laminark/dist/index.js

# After that, in ANY project:
$ claude
[Laminark] Session context loaded. 3 tools available for this project.
```

**Notes:** This is nearly free -- Laminark's architecture already assumes a global database. The shift is configuration scope, not code architecture. The existing `.mcp.json` in the Laminark repo root is a development convenience, not the production install path.

---

### TS-2: Tool/Skill Discovery (Know What's Available)

**Why Expected:** If Laminark claims to route users to tools, it must first know what tools exist. Claude Code's ecosystem provides multiple discovery surfaces: MCP servers (via `/mcp`), plugins (via `/plugin`), slash commands (via `/help`), and agent skills. A registry that doesn't know about available tools is useless.

**Complexity:** MEDIUM

**Dependencies on Existing Laminark:**
- Existing `project_metadata` table for project scoping
- Existing hook handler receives `tool_name` on every PostToolUse event
- Existing observation capture pipeline (can capture tool usage patterns)
- SessionStart hook receives `session_id` and `cwd`

**Discovery Sources (ranked by reliability):**

| Source | What It Reveals | How to Access | Reliability |
|--------|----------------|---------------|-------------|
| PostToolUse hook events | Every tool Claude actually uses, with full input/output | Already captured -- `tool_name` field in hook JSON | HIGH -- ground truth, tools that actually execute |
| `.mcp.json` files (project scope) | MCP servers configured for specific projects | Read file at `$CLAUDE_PROJECT_DIR/.mcp.json` | HIGH -- explicit configuration |
| `~/.claude.json` (user scope) | Globally configured MCP servers | Read file at `~/.claude.json` | HIGH -- explicit configuration |
| `.claude/commands/` directory | Slash commands available in project | Glob `$CLAUDE_PROJECT_DIR/.claude/commands/**/*.md` | HIGH -- filesystem presence |
| `~/.claude/commands/` directory | Global slash commands | Glob `~/.claude/commands/**/*.md` | HIGH -- filesystem presence |
| `.claude/skills/` directory | Agent skills available in project | Glob `$CLAUDE_PROJECT_DIR/.claude/skills/**/SKILL.md` | HIGH -- filesystem presence |
| `~/.claude/skills/` directory | Global agent skills | Glob `~/.claude/skills/**/SKILL.md` | HIGH -- filesystem presence |
| Installed plugins | Plugin-bundled skills, commands, MCP servers | Read `~/.claude/plugins/installed_plugins.json` | HIGH -- explicit installation records |
| MCP tool call patterns | Which MCP tools are used, how often, in what context | Derived from PostToolUse observations over time | MEDIUM -- requires accumulation |

**What Gets Stored:**
A new `tool_registry` table:
```sql
CREATE TABLE tool_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,           -- e.g., "mcp__gsd__plan_phase", "/gsd:plan-phase"
  tool_type TEXT NOT NULL,      -- 'mcp_tool', 'slash_command', 'skill', 'plugin'
  scope TEXT NOT NULL,          -- 'global', 'project', 'plugin'
  source TEXT NOT NULL,         -- where discovered: 'hook_observation', 'config_scan', 'plugin_manifest'
  project_hash TEXT,            -- NULL for global tools, specific hash for project-scoped
  description TEXT,             -- human-readable description (from SKILL.md frontmatter, tool schema, etc.)
  capability_tags TEXT,         -- JSON array: ["planning", "debugging", "testing"]
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**User Experience:**
Laminark knows: "In this project, you have: GSD (global plugin), Playwright MCP (project config), 3 custom slash commands, and 2 agent skills. Across 47 past sessions, you've used GSD 23 times and Playwright 8 times."

---

### TS-3: Scope-Aware Tool Resolution

**Why Expected:** Suggesting a project-specific tool when working in a different project is worse than suggesting nothing. Scope awareness is fundamental to not being annoying.

**Complexity:** MEDIUM

**Dependencies on Existing Laminark:**
- Existing `getProjectHash()` for project identification
- Existing `project_metadata` table
- Existing pattern of filtering by `project_hash` in all queries

**Scope Hierarchy (matches Claude Code's own hierarchy):**

| Scope | Visibility | Storage | Example |
|-------|------------|---------|---------|
| **Global** | All projects, always | `tool_registry WHERE scope = 'global'` | GSD plugin (installed at `~/.claude/`), Context7 MCP server |
| **Project** | Only in the originating project | `tool_registry WHERE scope = 'project' AND project_hash = ?` | Custom `/deploy` command in `.claude/commands/deploy.md` |
| **Plugin** | Wherever the plugin is enabled | `tool_registry WHERE scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?)` | Plugin installed at user scope vs project scope |

**Resolution Logic:**
```
On SessionStart for project P:
  available_tools =
    (global tools)
    UNION (project tools WHERE project_hash = hash(P))
    UNION (plugin tools WHERE plugin enabled for P or globally)
```

**Critical Rule:** NEVER suggest a project-scoped tool from project A when working in project B. The tool_registry query MUST filter by current project_hash for project-scoped entries.

**User Experience:**
```
# In project A (has Playwright MCP):
User: "I need to test the login flow"
Laminark: [Knows Playwright is available] -> suggests browser testing approach

# In project B (no Playwright):
User: "I need to test the login flow"
Laminark: [Knows only standard tools available] -> suggests unit test approach
```

---

### TS-4: Tool Usage Tracking

**Why Expected:** Routing decisions need data. Which tools does this user actually use? Which tools solve which kinds of problems? Without usage history, routing is just guessing.

**Complexity:** LOW

**Dependencies on Existing Laminark:**
- Existing PostToolUse hook already captures `tool_name`, `tool_input`, and `tool_response`
- Existing observation pipeline with session tracking
- Existing admission filter (already classifies tool significance)

**What Changes:**
The existing PostToolUse handler already observes every tool call. V2 adds a lightweight side-effect: increment `usage_count` and update `last_used_at` in the `tool_registry` for each tool call. Also record the task context (derived from recent observations) to build tool-context associations.

New table for context association:
```sql
CREATE TABLE tool_usage_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  project_hash TEXT NOT NULL,
  session_id TEXT,
  context_embedding BLOB,       -- embedding of the conversation context when tool was used
  context_summary TEXT,          -- short text: "debugging auth flow", "planning feature X"
  outcome TEXT,                  -- 'success', 'failure', 'unknown'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**User Experience:** Invisible. This is infrastructure that powers routing suggestions. Users never interact with it directly.

---

### TS-5: Basic Tool Suggestion on Session Start

**Why Expected:** If Laminark knows what tools are available and what the user has been working on, the minimum viable intelligence is: "Here are tools relevant to your current context." This is table stakes because the existing SessionStart injection already surfaces prior context -- adding tool awareness is the natural extension.

**Complexity:** MEDIUM

**Dependencies on Existing Laminark:**
- Existing `assembleSessionContext()` in `context/injection.ts`
- Existing `formatContextIndex()` with sections (changes, decisions, findings, references)
- Tool registry (TS-2)
- Scope resolution (TS-3)

**What Changes:**
Add a new section to `assembleSessionContext()` output:

```
[Laminark - Session Context]

## Previous Session
<existing summary>

## Recent Changes
<existing>

## Available Tools
- /gsd:plan-phase - Plan implementation phases (used 23x)
- mcp__playwright__browser_screenshot - Browser testing (project-specific)
- /deploy - Custom deploy workflow (project-specific)
```

**Critical constraint:** This must fit within the existing 6000-char token budget (`MAX_CONTEXT_CHARS`). Tool suggestions compete with observations for context window real estate. Keep tool list to top 5-7 most relevant, not an exhaustive dump.

**User Experience:**
```
$ claude
[Laminark - Session Context]

## Previous Session
Implemented auth middleware, fixed JWT expiration bug.

## Available Tools
- /gsd:plan-phase (global, 23 uses) - structured feature planning
- /gsd:debug (global, 12 uses) - systematic debugging workflow
- /deploy (project) - deploy to staging environment
```

---

## Differentiators

Features that set Laminark V2 apart. No other tool in the Claude Code ecosystem does these.

### D-1: Conversation-Driven Tool Routing (Intent Detection)

**Value Proposition:** User discusses a problem in natural language. Laminark detects the intent and proactively suggests the right tool BEFORE the user thinks to invoke it. This is the killer feature -- turning passive memory into active intelligence.

**Complexity:** HIGH

**Dependencies on Existing Laminark:**
- Existing embedding infrastructure (for intent embedding)
- Existing topic detection (for tracking conversation direction)
- Tool registry with capability tags (TS-2)
- Tool usage context (TS-4)
- Existing notification system (`NotificationStore`)

**How It Works:**

1. **Intent Embedding:** As the user converses, Laminark embeds recent conversation context (last 3-5 observations from PostToolUse/UserPromptSubmit).

2. **Context Matching:** Compare conversation embedding against stored `tool_usage_context` embeddings. When similarity exceeds threshold, the conversation is moving toward a domain where a specific tool has historically been useful.

3. **Routing Signal:** When match confidence is high enough, queue a notification via existing `NotificationStore`. The next MCP tool call from Claude will include the suggestion as a prepended notification (existing pattern in all Laminark tool handlers).

4. **Feedback Loop:** If the user follows the suggestion (subsequent tool call matches suggested tool), increase the association weight. If ignored, decrease it.

**User Experience:**
```
User: "I need to plan out the authentication system. There are several
       components: login, registration, password reset, and OAuth."

[Laminark notification on next tool response]:
"Structured planning task detected. /gsd:plan-phase is available and
has been used for similar tasks 8 times in this project."

User: "/gsd:plan-phase authentication system"
[Routing worked -- feedback loop strengthens association]
```

**Why No One Else Does This:**
- Claude Code's built-in Tool Search (ENABLE_TOOL_SEARCH) only defers/loads MCP tools based on context window pressure -- it does not proactively suggest tools based on conversation intent
- Plugin skills are model-invoked (Claude decides), but they lack historical usage context and cross-tool awareness
- MCP gateways route requests after they're made -- they don't suggest before

**Implementation Approach:**
This builds directly on Laminark's existing topic detection infrastructure. The same embedding comparison that detects topic shifts can detect when conversation context drifts toward a "tool activation zone" -- a region in embedding space associated with past tool usage.

---

### D-2: Tool Capability Indexing with Semantic Search

**Value Proposition:** Users can ask "what tools can help me with X?" and get semantically relevant answers, not just keyword matches. Laminark indexes tool descriptions, past usage contexts, and SKILL.md contents into its existing search infrastructure.

**Complexity:** MEDIUM

**Dependencies on Existing Laminark:**
- Existing hybrid search (FTS5 + sqlite-vec)
- Existing embedding pipeline
- Tool registry (TS-2)

**What Gets Indexed:**
- Tool descriptions (from MCP tool schemas, SKILL.md frontmatter, command file descriptions)
- Historical usage summaries ("Used to plan auth system", "Used to debug memory leak")
- Capability tags (derived from description + usage patterns)

**New MCP Tool: `discover_tools`**
```
discover_tools:
  query: "testing browser interactions"
  scope: "all" | "global" | "project"

Returns:
  - mcp__playwright__* (project-scoped, 8 uses, relevance: 0.92)
  - /test-e2e (project command, 3 uses, relevance: 0.78)
```

**User Experience:**
```
User: "What tools do I have for database work?"
Claude: [calls mcp__laminark__discover_tools with query "database"]
Response: "You have these database-related tools:
  - mcp__postgres__query (global, used 15 times)
  - /db:migrate (project command, used 4 times)
  - /db:seed (project command, used 2 times)"
```

---

### D-3: Cross-Project Tool Intelligence

**Value Proposition:** Laminark's global database sees tool usage across ALL projects. It can learn that "when debugging memory issues, users in Node.js projects tend to use tool X" and apply that knowledge to new projects. This is organizational learning that no project-scoped tool can achieve.

**Complexity:** HIGH

**Dependencies on Existing Laminark:**
- Existing `project_metadata` table (tracks all known projects)
- Existing global database (already stores data from all projects)
- Tool usage context (TS-4)
- Tool registry (TS-2)

**What This Enables:**
- "In your other TypeScript projects, you've used /gsd:debug for similar issues"
- "Projects with similar dependency patterns (React + Tailwind) commonly use these tools"
- Tool recommendation for new projects based on project similarity

**Critical Safety Rule:** Cross-project intelligence surfaces tool NAMES and PATTERNS, never observation content from other projects. Project memory isolation is sacrosanct.

**User Experience:**
```
# First time opening a new React project:
[Laminark] New project detected. Based on 3 similar TypeScript/React projects:
  - /gsd:plan-phase (used in 3/3 projects)
  - mcp__playwright__* (used in 2/3 projects)
  - /component-gen (used in 2/3 projects, project-scoped -- not available here)
```

---

### D-4: Tool Workflow Chains (Learned Sequences)

**Value Proposition:** Users often invoke tools in sequences: research -> plan -> implement -> test. Laminark observes these patterns and suggests the next step in a workflow. "You just finished planning with GSD. In past sessions, you typically ran tests next."

**Complexity:** HIGH

**Dependencies on Existing Laminark:**
- Existing temporal ordering (preceded_by edges in knowledge graph)
- Existing session tracking
- Tool usage context (TS-4)

**What Gets Tracked:**
A `tool_sequences` table that records tool invocation order within sessions:
```sql
CREATE TABLE tool_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  sequence_position INTEGER NOT NULL,
  context_hash TEXT,            -- hash of conversation context at invocation
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Pattern mining: After N sessions, identify common subsequences (A -> B -> C) and their frequency. When the user completes step A, suggest step B.

**User Experience:**
```
User: [just completed /gsd:plan-phase]
[Laminark notification]: "Planning complete. In past sessions, you typically:
  1. Created implementation files (Write)
  2. Ran tests (Bash: npm test)
  3. Committed (Bash: git commit)
  Consider starting implementation."
```

---

### D-5: Deprecation and Staleness Awareness

**Value Proposition:** Tools come and go. A project removes an MCP server, a plugin gets uninstalled, a slash command file is deleted. Laminark should detect this and stop suggesting stale tools. It should also notice when a tool hasn't been used in weeks and deprioritize it.

**Complexity:** LOW

**Dependencies on Existing Laminark:**
- Existing staleness detection in knowledge graph (`graph/staleness.ts`)
- Existing curation agent for graph maintenance
- Tool registry (TS-2)

**What Changes:**
- Periodic config rescan (on SessionStart): check if `.mcp.json`, command files, skill files still exist
- Mark tools as `status = 'stale'` if config source is gone
- Decay `usage_count` influence over time (recency-weighted)
- Curation agent prunes tools not seen in 30+ days

---

## Anti-Features

Features that seem logical for V2 but would create problems. Explicitly NOT building these.

### AF-1: Automatic Tool Installation

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "If Laminark knows I need Playwright, just install it" | Security nightmare. Auto-installing npm packages or MCP servers without explicit user consent violates trust. Claude Code requires explicit approval for project-scoped MCP servers for good reason. | Suggest the tool and provide the install command. User runs it. "To add Playwright MCP: `claude mcp add --transport stdio playwright -- npx -y @playwright/mcp@latest`" |

### AF-2: Tool Execution Proxy

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "Laminark should invoke tools on my behalf" | Laminark is a memory/intelligence layer, not a tool execution engine. MCP tools already have their own execution paths. Adding a proxy layer creates: redundant permission checks, error surface area, confused responsibility boundaries. | Route the user to the tool. Let Claude Code's existing tool execution handle the rest. Laminark observes outcomes via PostToolUse hooks. |

### AF-3: Real-Time MCP Server Health Monitoring

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "Check if MCP servers are responsive before suggesting them" | Laminark runs as an MCP server itself -- it cannot make outbound connections to other MCP servers. MCP servers communicate with clients, not with each other. Health checking would require a separate daemon. | Track PostToolUseFailure events. If a tool fails repeatedly, deprioritize it in suggestions. Reactive, not proactive. |

### AF-4: Natural Language Tool Creation

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "If no tool exists for X, generate one" | Code generation from intent is Claude's job, not Laminark's. Creating tools requires understanding the full project context, testing, permissions. This is a completely different product (and Claude Code already does it via skills). | Detect the gap: "No tool found for X. Consider creating a skill: `mkdir .claude/skills/X && edit .claude/skills/X/SKILL.md`" |

### AF-5: Multi-User Tool Sharing / Team Registry

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "Share tool configurations across the team" | Requires auth, conflict resolution, network infrastructure. Claude Code already handles team sharing via project-scoped `.mcp.json` (checked into git) and marketplace plugins. Laminark duplicating this adds complexity with no benefit. | Respect existing scopes. Project-scoped `.mcp.json` IS the team sharing mechanism. Laminark discovers and indexes it; it doesn't replace it. |

### AF-6: Universal Tool Abstraction Layer

| Why Requested | Why Problematic | What to Do Instead |
|---------------|-----------------|-------------------|
| "Normalize all tools into a common interface" | MCP tools, slash commands, skills, and agents have fundamentally different invocation patterns, argument schemas, and lifecycle behaviors. Forcing them into one abstraction loses the characteristics that make each useful. | Index them with common metadata (name, description, capability tags, usage stats) but preserve their native invocation format. Tell the user "/gsd:plan-phase" or "mcp__playwright__browser_screenshot" -- don't abstract away the invocation path. |

---

## Feature Dependencies

```
[Global Installation (TS-1)]
    |
    +--enables--> [Tool Discovery (TS-2)]
    |                 |
    |                 +--requires--> [Config Scanning] (read .mcp.json, commands/, skills/, plugins)
    |                 |
    |                 +--requires--> [PostToolUse observation] (existing)
    |                 |
    |                 +--produces--> [tool_registry table]
    |                                    |
    |                                    +--enables--> [Scope-Aware Resolution (TS-3)]
    |                                    |                 |
    |                                    |                 +--requires--> [getProjectHash()] (existing)
    |                                    |
    |                                    +--enables--> [Tool Usage Tracking (TS-4)]
    |                                    |                 |
    |                                    |                 +--requires--> [PostToolUse hook] (existing)
    |                                    |                 |
    |                                    |                 +--produces--> [tool_usage_context table]
    |                                    |
    |                                    +--enables--> [Session Start Suggestions (TS-5)]
    |                                                      |
    |                                                      +--requires--> [assembleSessionContext()] (existing)

[Tool Usage Context (TS-4)]
    |
    +--combined-with--> [Embedding Infrastructure] (existing)
    |
    +--enables--> [Conversation-Driven Routing (D-1)]
    |                 |
    |                 +--requires--> [Topic Detection] (existing)
    |                 +--requires--> [NotificationStore] (existing)
    |
    +--enables--> [Tool Capability Search (D-2)]
    |                 |
    |                 +--requires--> [Hybrid Search] (existing)
    |
    +--enables--> [Cross-Project Intelligence (D-3)]
    |                 |
    |                 +--requires--> [project_metadata] (existing)
    |
    +--enables--> [Tool Workflow Chains (D-4)]
                      |
                      +--requires--> [Session Tracking] (existing)

[Staleness Awareness (D-5)]
    |
    +--requires--> [Tool Registry (TS-2)]
    +--requires--> [Curation Agent] (existing)
```

### Key Dependency Observations

1. **TS-1 (Global Install) is the prerequisite for everything.** Without global presence, there is no multi-project visibility.

2. **TS-2 (Discovery) is the foundation.** Every other feature depends on having a populated tool registry. Discovery must work before routing can work.

3. **TS-4 (Usage Tracking) bridges table stakes and differentiators.** It's simple to implement but enables all the intelligent features (D-1 through D-4).

4. **D-1 (Conversation Routing) is the highest-value differentiator** but has the most dependencies. It needs: registry, usage context, embeddings, and topic detection all working.

5. **Existing Laminark infrastructure covers ~60% of the dependency graph.** The embedding pipeline, topic detection, notification system, hybrid search, session management, and knowledge graph are all already built.

---

## MVP Recommendation for V2

### Phase 1: Foundation (Must Ship)

Build the registry and make Laminark globally present:

1. **TS-1: Global Installation** -- configure user-scope MCP server + global hooks
2. **TS-2: Tool Discovery** -- config scanning on SessionStart + passive observation via PostToolUse
3. **TS-3: Scope-Aware Resolution** -- filter registry queries by current project_hash
4. **TS-4: Tool Usage Tracking** -- lightweight side-effect in existing hook pipeline
5. **TS-5: Session Start Suggestions** -- add "Available Tools" section to context injection
6. **D-5: Staleness Awareness** -- config rescan + decay (low cost, prevents bad suggestions)

**Rationale:** These features are individually low-to-medium complexity, build directly on existing infrastructure, and create the data foundation for intelligent routing.

### Phase 2: Intelligence (Differentiators)

Once the registry is populated and stable:

7. **D-2: Tool Capability Search** -- new `discover_tools` MCP tool using existing hybrid search
8. **D-1: Conversation-Driven Routing** -- intent detection using existing embedding + topic infrastructure
9. **D-4: Tool Workflow Chains** -- pattern mining from accumulated usage sequences

### Defer

10. **D-3: Cross-Project Intelligence** -- requires significant accumulated data across multiple projects; premature to build before the registry is proven useful in single-project context

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Risk | Priority |
|---------|------------|---------------------|------|----------|
| TS-1: Global Installation | CRITICAL | LOW | LOW | P0 |
| TS-2: Tool Discovery | CRITICAL | MEDIUM | LOW | P0 |
| TS-3: Scope-Aware Resolution | HIGH | MEDIUM | LOW | P0 |
| TS-4: Tool Usage Tracking | MEDIUM (enables HIGH) | LOW | LOW | P0 |
| TS-5: Session Start Suggestions | HIGH | MEDIUM | LOW | P0 |
| D-5: Staleness Awareness | MEDIUM | LOW | LOW | P0 |
| D-2: Tool Capability Search | HIGH | MEDIUM | LOW | P1 |
| D-1: Conversation-Driven Routing | VERY HIGH | HIGH | MEDIUM (threshold tuning) | P1 |
| D-4: Tool Workflow Chains | MEDIUM | HIGH | MEDIUM (pattern quality) | P2 |
| D-3: Cross-Project Intelligence | MEDIUM | HIGH | HIGH (data sparsity) | P3 |

---

## Concrete User Workflow Examples

### Workflow 1: First-Time Global Setup
```
# User installs Laminark globally
$ claude mcp add --scope user --transport stdio laminark -- node ~/.local/lib/laminark/dist/index.js

# User also configures global hooks in ~/.claude/settings.json
# (or Laminark ships as a plugin with hooks/hooks.json)

# Now, in any project:
$ cd ~/projects/my-app && claude
[Laminark] New project detected: /home/user/projects/my-app
[Laminark] Scanning for available tools...
[Laminark] Found: 2 MCP servers (laminark, context7), 3 global commands, 1 project command
[Laminark - Session Context]
## Available Tools
- /gsd:plan-phase (global, new) - structured feature planning
- /gsd:debug (global, new) - systematic debugging
- mcp__context7__query-docs (global) - library documentation lookup
```

### Workflow 2: Conversation-Driven Routing
```
User: "The login page is broken. Users are seeing a white screen after
       entering their credentials."

# Laminark observes this via PostToolUse (Claude will read files, etc.)
# Embedding of conversation context lands in "debugging" zone
# tool_usage_context shows /gsd:debug used 12 times in debugging contexts

[Laminark notification on next tool response]:
"Debugging pattern detected. /gsd:debug has been effective for similar
issues (used 12 times in debugging contexts)."

User: "/gsd:debug white screen after login"
# GSD debug workflow begins, Laminark continues observing
```

### Workflow 3: Tool Discovery by Query
```
User: "What tools do I have for testing?"
Claude: [calls mcp__laminark__discover_tools query="testing"]

Laminark returns:
  Tools matching "testing":
  1. mcp__playwright__browser_screenshot (project, 8 uses) - Browser automation
  2. /test-integration (project command, 5 uses) - Run integration test suite
  3. /gsd:debug (global, 12 uses) - Includes test verification step

  Not installed but commonly used in similar projects:
  - mcp__jest__ - Jest test runner MCP (install: claude mcp add ...)
```

### Workflow 4: Scope Awareness in Action
```
# In project A (has Playwright MCP + custom deploy command):
User: "Deploy to staging"
[Laminark]: /deploy command available (project-scoped, 7 uses)

# User switches to project B (different project, no Playwright, no deploy):
$ cd ~/projects/other-app && claude
[Laminark - Session Context]
## Available Tools
- /gsd:plan-phase (global, 23 uses)
- /gsd:debug (global, 12 uses)
# Note: /deploy and Playwright are NOT listed -- they're project A only

User: "Deploy to staging"
[Laminark]: No deployment tool configured for this project.
Consider creating .claude/commands/deploy.md or configuring a CI/CD MCP server.
```

---

## Sources

- [Claude Code MCP Configuration Scopes](https://code.claude.com/docs/en/mcp) -- local/project/user scopes, `.mcp.json` format, `~/.claude.json`, `managed-mcp.json`, scope hierarchy and precedence, plugin MCP servers (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- full hook event schema, PostToolUse/SessionStart/Stop input JSON, matcher patterns, MCP tool naming convention `mcp__<server>__<tool>`, decision control (HIGH confidence)
- [Claude Code Plugins System](https://code.claude.com/docs/en/plugins) -- plugin structure (`.claude-plugin/plugin.json`, `commands/`, `skills/`, `agents/`, `hooks/`, `.mcp.json`), namespacing (`/plugin-name:skill`), discovery via marketplace (HIGH confidence)
- [Claude Code Skills](https://code.claude.com/docs/en/skills) -- model-invoked vs user-invoked, SKILL.md frontmatter format, `.claude/skills/` directory structure (HIGH confidence)
- [Claude Code MCP Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) -- ENABLE_TOOL_SEARCH, auto mode, context window threshold, deferred tool loading (HIGH confidence)
- [MCP Proxy Server Pattern](https://github.com/adamwattis/mcp-proxy-server) -- capability aggregation, request routing, connection management for multiple backends (MEDIUM confidence)
- [MCP Gateway Architecture](https://obot.ai/resources/learning-center/mcp-gateway/) -- tools/list aggregation, request routing, policy enforcement (MEDIUM confidence)
- [AI Agent Routing Best Practices](https://www.patronus.ai/ai-agent-development/ai-agent-routing) -- LLM-powered routing vs rule-based, context preservation, intent classification (MEDIUM confidence)
- [Intent Recognition in Multi-Agent Systems](https://gist.github.com/mkbctrl/a35764e99fe0c8e8c00b2358f55cd7fa) -- conversation context as routing input, last N messages for intent detection (MEDIUM confidence)
- [Claude Code Community Plugin Registry](https://claude-plugins.dev/) -- 11,989 plugins, 63,065 skills indexed; demonstrates ecosystem scale (MEDIUM confidence)
- [MCP Registry and Server Discovery](https://modelcontextprotocol.io/development/roadmap) -- .well-known URLs for capability advertisement, public/private sub-registries (MEDIUM confidence)

---
*Feature research for: Laminark V2 -- Tool Discovery, Registry, and Conversation-Driven Routing*
*Researched: 2026-02-10*
