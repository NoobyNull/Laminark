# Phase 14: Conversation Routing - Research

**Researched:** 2026-02-10
**Domain:** Intent-to-tool mapping via hook-observed tool usage patterns, confidence-gated suggestion delivery, and cold-start heuristic fallback
**Confidence:** HIGH

## Summary

Phase 14 builds conversation routing on top of the infrastructure from Phases 9-13. The system must detect when the current conversation context resembles contexts where a specific tool was historically used, and surface a suggestion via the existing notification mechanism. The critical constraint is that Laminark has NO access to user messages or Claude's responses -- it only observes tool calls via PostToolUse hooks. This means "conversation intent" must be inferred entirely from the sequence of tool calls and their payloads, not from natural language understanding.

The existing infrastructure provides everything needed: `tool_usage_events` (Phase 12) records every tool call with session context, `tool_registry` (Phase 10) knows what tools are available, `NotificationStore` delivers messages prepended to the next MCP tool response, and the embedding pipeline (Phase 4) can compute semantic similarity between observation sequences. The routing module's job is to bridge these: analyze recent tool usage patterns in the current session, compare them against historical patterns that preceded specific tool activations, and emit a notification when confidence is high.

The cold-start requirement (ROUT-04) is addressed by a keyword-based heuristic fallback that maps tool descriptions to recent observation content. This works without any accumulated usage history. As usage data accumulates, the learned pattern matcher progressively takes over.

**Primary recommendation:** Build a `ConversationRouter` class in `src/routing/` that runs in the hook handler's PostToolUse path, queries recent session tool patterns against historical tool-context associations, and emits notifications via `NotificationStore` when confidence exceeds a configurable threshold. Start with keyword heuristic routing (cold start), layer pattern-based routing on top.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | All data queries for routing patterns | Already in use, WAL handles concurrent access |
| Node.js fs/path/os | >=22.0.0 | No filesystem access needed for routing | Routing is purely database-driven |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | ^4.3.6 | Validate routing config schema | Configuration validation only |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SQLite pattern queries | In-memory embedding comparison | SQLite is already open in handler; adding vector comparison in the hook handler hot path would require importing the ONNX worker, adding ~50ms cold start |
| Keyword heuristic for cold start | LLM-based intent classification via MCP sampling | Sampling requires the MCP server process, but routing runs in the hook handler (separate process); too complex and too slow |

**Installation:**
```bash
# No new dependencies
```

## Architecture Patterns

### Recommended Project Structure

```
src/
  routing/
    conversation-router.ts   # Main router: pattern matching + suggestion emission
    intent-patterns.ts       # Historical pattern extraction from tool_usage_events
    heuristic-fallback.ts    # Keyword-based cold-start routing
    types.ts                 # RoutingContext, RoutingSuggestion, RoutingConfig interfaces
```

### Pattern 1: Two-Tier Routing (Heuristic + Learned)

**What:** A routing system with two tiers. Tier 1 (heuristic) uses keyword matching between tool descriptions and recent observation content -- works immediately with zero history. Tier 2 (learned) uses historical tool usage patterns -- progressively takes over as data accumulates.

**When to use:** Always. The heuristic tier is the foundation. The learned tier is an overlay.

**How it works in Laminark's constraint model:**

Laminark cannot see user messages. It CAN see:
1. Every tool call (tool_name, tool_input, tool_response) via PostToolUse hooks
2. Observations extracted from those tool calls (stored in `observations` table)
3. Historical tool usage sequences per session (from `tool_usage_events`)

"Conversation context" in Laminark's world = the sequence of recent tool calls and their extracted observations in the current session.

**Tier 1 (Heuristic Fallback -- Cold Start):**
```typescript
// Match recent observation content against tool descriptions
function heuristicMatch(
  recentObservations: string[],   // Last 3-5 observation contents from this session
  availableTools: ToolRegistryRow[],  // Tools with descriptions
): RoutingSuggestion | null {
  // Combine recent observation text
  const contextText = recentObservations.join(' ').toLowerCase();

  // Score each tool by keyword overlap with its description
  for (const tool of availableTools) {
    if (!tool.description) continue;
    const keywords = extractKeywords(tool.description);
    const matchCount = keywords.filter(kw => contextText.includes(kw)).length;
    const score = matchCount / keywords.length;
    if (score >= HEURISTIC_THRESHOLD) {
      return { toolName: tool.name, confidence: score, tier: 'heuristic' };
    }
  }
  return null;
}
```

**Tier 2 (Learned Patterns):**
```typescript
// Compare current session's tool sequence against historical sequences
// that preceded activation of a specific tool
function learnedMatch(
  currentSessionTools: string[],      // Tools used so far this session
  historicalPatterns: ToolPattern[],   // Pre-computed from tool_usage_events
): RoutingSuggestion | null {
  for (const pattern of historicalPatterns) {
    const overlap = computeSequenceOverlap(currentSessionTools, pattern.precedingTools);
    if (overlap >= LEARNED_THRESHOLD) {
      return { toolName: pattern.targetTool, confidence: overlap, tier: 'learned' };
    }
  }
  return null;
}
```

### Pattern 2: Notification-Based Suggestion Delivery (ROUT-02)

**What:** Route suggestions are delivered via the existing `NotificationStore`. When the router determines a suggestion should be made, it writes to `pending_notifications`. The next time Claude calls ANY Laminark MCP tool (`recall`, `save_memory`, `query_graph`, etc.), the notification is prepended to the response.

**When to use:** Always. This is the ONLY approved delivery mechanism per ROUT-02.

**Why this works:**
- The hook handler (where routing runs) and the MCP server (where notifications are consumed) share the same SQLite database via WAL mode
- The hook handler writes `notificationStore.add(projectHash, message)` during PostToolUse
- The next MCP tool call reads `notificationStore.consumePending(projectHash)` and prepends to the response
- This is the exact same pattern used for topic shift notifications (Phase 6)

**Example flow:**
```
1. User discusses auth → Claude calls Write (creates auth middleware)
2. PostToolUse fires → handler extracts observation → router evaluates
3. Router finds: "auth-related tool sequence matches historical pattern for /gsd:debug"
4. Router writes: notificationStore.add(projectHash, "Auth debugging pattern detected. /gsd:debug is available (used 8x for similar work).")
5. Next time Claude calls mcp__laminark__recall or any Laminark tool:
   Response: "[Laminark] Auth debugging pattern detected. /gsd:debug is available..."
             + normal recall results
```

**Critical constraint:** The hook handler runs as a separate short-lived process. It opens its own DB connection. The `NotificationStore` creates its table with `CREATE TABLE IF NOT EXISTS` (no migration needed). The handler can safely instantiate `NotificationStore` and write to it.

### Pattern 3: Confidence Threshold Gating (ROUT-03)

**What:** Every routing evaluation produces a confidence score (0.0 to 1.0). Only suggestions above the configured threshold are emitted. Below threshold = silence.

**When to use:** Every routing evaluation. No exceptions.

**Threshold design:**
```typescript
interface RoutingConfig {
  // Minimum confidence to emit a suggestion (default: 0.6)
  confidenceThreshold: number;

  // Maximum suggestions per session (default: 2)
  maxSuggestionsPerSession: number;

  // Minimum tool events in history before learned patterns activate (default: 20)
  minEventsForLearned: number;

  // Cooldown: minimum tool calls between suggestions (default: 5)
  suggestionCooldown: number;
}
```

**Why these defaults:**
- `0.6` threshold: High enough to avoid Clippy-style over-suggestion, low enough to occasionally surface useful matches. Research Pitfall 10 (over-suggestion fatigue) drives this.
- `2` max per session: Rate limiting prevents annoyance. A session where Laminark suggests 5+ tools is a session where the user disables the feature.
- `20` min events: Learned patterns need enough data to be meaningful. With fewer than 20 events, the heuristic tier handles everything.
- `5` cooldown: Prevents rapid-fire suggestions during intense coding bursts where tool calls happen every few seconds.

### Pattern 4: Session-Scoped Routing State

**What:** Routing state (suggestions made, cooldown counter, current session tool sequence) is tracked in-memory per session via a small SQLite table, NOT in-process memory. This is because the hook handler is a short-lived CLI process that exits after each event.

**When to use:** Always. The handler process cannot maintain state across invocations.

```sql
-- Routing state per session (lightweight, transient)
CREATE TABLE IF NOT EXISTS routing_state (
  session_id TEXT NOT NULL,
  project_hash TEXT NOT NULL,
  suggestions_made INTEGER NOT NULL DEFAULT 0,
  last_suggestion_at TEXT,
  tool_calls_since_suggestion INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, project_hash)
);
```

This table is created inline (like `pending_notifications`), not via a migration. It is transient -- old sessions can be cleaned up periodically.

### Anti-Patterns to Avoid

- **Auto-invocation:** NEVER call a tool on behalf of the user. Laminark suggests; Claude/user decides. Per ROUT-02, this is a hard constraint.
- **Routing in the MCP server process:** The MCP server process (index.ts) runs long-lived but only handles MCP tool calls. Routing decisions should happen in the hook handler (PostToolUse) because that is where conversation flow is observed. The MCP server's role is to deliver suggestions (via notification prepend), not to evaluate them.
- **Embedding-based routing in the hook handler:** The hook handler must complete in <30ms for PostToolUse. Loading the ONNX model or computing embeddings would blow the budget. Use lightweight SQL queries and string matching only.
- **Suggesting built-in tools:** Claude already knows Read, Write, Edit, Bash, etc. Never suggest built-in tools. Only suggest MCP tools, slash commands, and skills.
- **Suggesting Laminark's own tools:** The self-referential filter already prevents observing Laminark's own tool calls. Routing should also never suggest `mcp__laminark__*` or `mcp__plugin_laminark_laminark__*` tools.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Notification delivery | Custom stdout injection from hook handler | Existing `NotificationStore` | Already proven in Phase 6 topic shift notifications. Write in handler, read in MCP tools. |
| Tool availability filtering | Custom scope resolution | Existing `toolRegistry.getAvailableForSession()` | Phase 11 already solved scope-filtered tool queries. |
| Usage pattern data | Custom event log | Existing `tool_usage_events` table + `getUsageSince()` / `getRecentUsage()` | Phase 12 already provides per-event temporal tracking with session context. |
| Relevance scoring | Custom scoring from scratch | Extend existing `rankToolsByRelevance()` from injection.ts | Phase 13 already computes frequency-share scoring. Routing can reuse the same formula. |
| Keyword extraction | NLP library | Simple `string.split()` + stop word filter | Tool descriptions are short (max 200 chars per Pitfall 15). Heavy NLP is overkill. |

**Key insight:** Every data source routing needs already exists. The router is a consumer of Phases 10-13 infrastructure, not a producer of new infrastructure.

## Common Pitfalls

### Pitfall 1: Over-Suggestion Fatigue (The Clippy Problem)

**What goes wrong:** Laminark suggests tools too frequently, on conversations that do not need routing assistance. Users become annoyed and mentally ignore all suggestions.
**Why it happens:** Routing systems face asymmetric feedback -- missing a useful suggestion is invisible, but unwanted suggestions are immediately annoying.
**How to avoid:**
- High confidence threshold (0.6 minimum)
- Rate limiting (max 2 suggestions per session, 5 tool-call cooldown)
- Never suggest during the first 3 tool calls of a session (too early to detect a pattern)
- Negative signal: if a suggested tool is NOT used within the next 10 tool calls, log it as "ignored" for future pattern refinement
**Warning signs:** Users disabling Laminark, suggestions appearing on every session, suggestion count per session > 2

### Pitfall 2: Ghost Tool Suggestions (Suggesting Unavailable Tools)

**What goes wrong:** Router suggests a tool that is not available in the current session's scope. Claude tries to call it and gets an error.
**Why it happens:** Historical patterns come from tool_usage_events which span ALL projects. A tool used in project A might be suggested in project B where it is not available.
**How to avoid:**
- Always filter suggestions through `toolRegistry.getAvailableForSession(projectHash)` BEFORE emitting
- The router should produce candidate suggestions, then a final gating step checks availability
- Never suggest a tool without first confirming it exists in the current scope
**Warning signs:** Any routing path that emits a suggestion without an availability check

### Pitfall 3: Hook Handler Performance Budget Violation

**What goes wrong:** Routing logic in the PostToolUse handler adds too much latency, causing the handler to exceed its <30ms budget.
**Why it happens:** Complex SQL queries, string processing, or importing heavy modules.
**How to avoid:**
- Pre-compute routing patterns at SessionStart (when the budget is more generous at ~100ms) and cache in SQLite
- PostToolUse routing evaluation should be at most 2-3 simple SQL queries
- Never import the ONNX model or @modelcontextprotocol/sdk in the handler
- Profile the handler with `Date.now()` timing
**Warning signs:** PostToolUse handler taking >30ms, new imports added to handler.ts

### Pitfall 4: Self-Referential Routing Loop

**What goes wrong:** The router observes a Laminark MCP tool call, evaluates it for routing, and suggests another Laminark tool, creating a feedback loop.
**Why it happens:** The self-referential filter in handler.ts skips observation capture for Laminark tools, but if routing runs BEFORE the filter, it would evaluate Laminark tool calls.
**How to avoid:**
- Router evaluation MUST run AFTER the self-referential filter check
- Router should also explicitly exclude Laminark tools from suggestion candidates
- Add `isLaminarksOwnTool()` check in the suggestion candidate filtering
**Warning signs:** Laminark tool names appearing in routing suggestions or pattern data

### Pitfall 5: Cold Start Producing No Suggestions at All

**What goes wrong:** In a fresh installation, the heuristic fallback fails to match anything because tool descriptions are empty or too generic.
**Why it happens:** Many tools in the registry have `description: null` (organically discovered via PostToolUse, where descriptions are not available). The heuristic fallback depends on descriptions.
**How to avoid:**
- Fall back to tool NAME keyword matching when description is null
- For MCP server entries (`mcp__playwright__*`), the server name itself is a useful keyword
- For slash commands (`/gsd:plan-phase`), parse the command path into keywords ("gsd", "plan", "phase")
- Config-scanned tools DO have descriptions (from SKILL.md frontmatter) -- prefer these
**Warning signs:** Heuristic tier returning null on every evaluation despite tools being available

### Pitfall 6: Stale Historical Patterns After Tool Removal

**What goes wrong:** A tool is removed from the project config, but historical patterns still reference it. Router suggests the removed tool.
**Why it happens:** tool_usage_events is append-only and never cleaned up. Historical patterns derived from old events reference tools that no longer exist.
**How to avoid:**
- The availability gate (Pitfall 2 prevention) also handles this -- removed tools fail the availability check
- Phase 16 (Staleness Management) will add explicit staleness detection
- For Phase 14, the availability gate is sufficient
**Warning signs:** Routing patterns referencing tools not in tool_registry

## Code Examples

### Routing Evaluation in PostToolUse Handler

```typescript
// Source: Laminark codebase pattern (handler.ts + notifications.ts)
// This runs in the hook handler's PostToolUse path, AFTER observation capture

function evaluateRouting(
  db: BetterSqlite3.Database,
  projectHash: string,
  sessionId: string,
  toolName: string,
  toolRegistry: ToolRegistryRepository,
): void {
  // Skip self-referential and built-in tools
  if (isLaminarksOwnTool(toolName)) return;
  if (inferToolType(toolName) === 'builtin') return;

  // Load or create routing state for this session
  const state = getOrCreateRoutingState(db, sessionId, projectHash);

  // Increment tool call counter
  state.tool_calls_since_suggestion++;
  updateRoutingState(db, state);

  // Check rate limits
  if (state.suggestions_made >= MAX_SUGGESTIONS_PER_SESSION) return;
  if (state.tool_calls_since_suggestion < SUGGESTION_COOLDOWN) return;
  if (state.tool_calls_since_suggestion < MIN_CALLS_BEFORE_FIRST_SUGGESTION) return;

  // Get available tools (scope-filtered)
  const available = toolRegistry.getAvailableForSession(projectHash);
  const suggestable = available.filter(t =>
    t.tool_type !== 'builtin' &&
    !isLaminarksOwnTool(t.name)
  );

  if (suggestable.length === 0) return;

  // Try learned patterns first (if enough data)
  const eventCount = countRecentEvents(db, projectHash);
  let suggestion: RoutingSuggestion | null = null;

  if (eventCount >= MIN_EVENTS_FOR_LEARNED) {
    suggestion = evaluateLearnedPatterns(db, sessionId, projectHash, suggestable);
  }

  // Fall back to heuristic
  if (!suggestion) {
    suggestion = evaluateHeuristic(db, sessionId, projectHash, suggestable);
  }

  // Confidence gate
  if (!suggestion || suggestion.confidence < CONFIDENCE_THRESHOLD) return;

  // Emit notification
  const notifStore = new NotificationStore(db);
  const message = formatSuggestion(suggestion);
  notifStore.add(projectHash, message);

  // Update state
  state.suggestions_made++;
  state.last_suggestion_at = new Date().toISOString();
  state.tool_calls_since_suggestion = 0;
  updateRoutingState(db, state);
}
```

### Heuristic Fallback (Cold Start)

```typescript
// Source: Laminark design -- keyword matching against tool descriptions/names

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'this', 'that', 'these', 'those', 'it', 'its']);

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function extractToolKeywords(tool: ToolRegistryRow): string[] {
  const sources: string[] = [];

  // Description keywords (highest value)
  if (tool.description) {
    sources.push(...extractKeywords(tool.description));
  }

  // Server name as keyword (e.g., "playwright", "github")
  if (tool.server_name) {
    sources.push(tool.server_name.toLowerCase());
  }

  // Parse slash command path (e.g., "/gsd:plan-phase" -> ["gsd", "plan", "phase"])
  if (tool.tool_type === 'slash_command') {
    sources.push(...tool.name.replace(/^\//, '').split(/[:\-_]/).filter(Boolean));
  }

  // Skill name as keyword
  if (tool.tool_type === 'skill') {
    sources.push(...tool.name.split(/[\-_]/).filter(Boolean));
  }

  return [...new Set(sources)];
}

function evaluateHeuristic(
  db: BetterSqlite3.Database,
  sessionId: string,
  projectHash: string,
  suggestable: ToolRegistryRow[],
): RoutingSuggestion | null {
  // Get recent observations from this session
  const recentObs = db.prepare(`
    SELECT content FROM observations
    WHERE project_hash = ? AND session_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 5
  `).all(projectHash, sessionId) as { content: string }[];

  if (recentObs.length < 2) return null; // Too early to judge

  const contextKeywords = new Set(
    recentObs.flatMap(o => extractKeywords(o.content))
  );

  let bestMatch: { tool: ToolRegistryRow; score: number } | null = null;

  for (const tool of suggestable) {
    const toolKeywords = extractToolKeywords(tool);
    if (toolKeywords.length === 0) continue;

    const matchCount = toolKeywords.filter(kw => contextKeywords.has(kw)).length;
    const score = matchCount / toolKeywords.length;

    if (score > (bestMatch?.score ?? 0)) {
      bestMatch = { tool, score };
    }
  }

  if (!bestMatch || bestMatch.score < CONFIDENCE_THRESHOLD) return null;

  return {
    toolName: bestMatch.tool.name,
    toolDescription: bestMatch.tool.description,
    confidence: bestMatch.score,
    tier: 'heuristic',
    reason: `Keywords match between current work and tool description`,
  };
}
```

### Learned Pattern Matching

```typescript
// Source: Laminark design -- tool sequence pattern extraction

interface ToolPattern {
  targetTool: string;         // The tool that was eventually used
  precedingTools: string[];   // Tools used in the N calls before targetTool
  frequency: number;          // How many times this pattern appeared
}

function extractPatterns(
  db: BetterSqlite3.Database,
  projectHash: string,
  windowSize: number = 5,
): ToolPattern[] {
  // Get recent events grouped by session, ordered by time
  const events = db.prepare(`
    SELECT tool_name, session_id, created_at
    FROM tool_usage_events
    WHERE project_hash = ? AND success = 1
    ORDER BY session_id, created_at
  `).all(projectHash) as { tool_name: string; session_id: string; created_at: string }[];

  // Group by session
  const sessions = new Map<string, string[]>();
  for (const evt of events) {
    if (!sessions.has(evt.session_id)) {
      sessions.set(evt.session_id, []);
    }
    sessions.get(evt.session_id)!.push(evt.tool_name);
  }

  // Extract sliding-window patterns
  const patternCounts = new Map<string, { target: string; preceding: string[]; count: number }>();

  for (const [, toolSequence] of sessions) {
    for (let i = windowSize; i < toolSequence.length; i++) {
      const target = toolSequence[i];
      const preceding = toolSequence.slice(i - windowSize, i);

      // Skip built-in tools as targets (we don't suggest those)
      if (inferToolType(target) === 'builtin') continue;
      // Skip Laminark's own tools as targets
      if (isLaminarksOwnTool(target)) continue;

      const key = `${target}:${preceding.join(',')}`;
      const existing = patternCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        patternCounts.set(key, { target, preceding, count: 1 });
      }
    }
  }

  // Filter to patterns with minimum frequency (at least 2 occurrences)
  return Array.from(patternCounts.values())
    .filter(p => p.count >= 2)
    .map(p => ({
      targetTool: p.target,
      precedingTools: p.preceding,
      frequency: p.count,
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

function computeSequenceOverlap(
  currentTools: string[],
  patternTools: string[],
): number {
  // Compute Jaccard-like overlap between current session's recent tools
  // and the pattern's preceding tools
  const current = new Set(currentTools.slice(-patternTools.length));
  const pattern = new Set(patternTools);

  let matches = 0;
  for (const tool of pattern) {
    if (current.has(tool)) matches++;
  }

  return matches / pattern.size;
}
```

### Notification Formatting

```typescript
// Source: Laminark NotificationStore pattern from Phase 6

function formatSuggestion(suggestion: RoutingSuggestion): string {
  const usageHint = suggestion.usageCount
    ? ` (used ${suggestion.usageCount}x in similar contexts)`
    : '';
  const desc = suggestion.toolDescription
    ? ` -- ${suggestion.toolDescription}`
    : '';

  return `Tool suggestion: ${suggestion.toolName}${desc}${usageHint}`;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No tool awareness in context injection | Phase 13: Ranked "Available Tools" section in SessionStart | Phase 13 (2026-02-11) | Claude knows what tools are available from session start |
| Aggregate usage counts only (usage_count on tool_registry) | Phase 12: Per-event usage tracking (tool_usage_events) | Phase 12 (2026-02-11) | Temporal queries enable pattern extraction |
| Topic shift detection only | Conversation routing (Phase 14) | This phase | Proactive tool suggestions beyond passive context |

**Key evolution:** Phases 9-13 built the data infrastructure. Phase 14 is the first phase that uses that data to make proactive suggestions. This is a qualitative shift from "Laminark tells Claude what it knows" to "Laminark tells Claude what it should do."

## Data Flow: Routing in the PostToolUse Pipeline

```
Claude uses a tool (Write, Bash, MCP tool, etc.)
    |
    v
PostToolUse hook fires -> handler.ts reads stdin
    |
    v
Step 0: Organic discovery (tool_registry upsert + tool_usage_events insert)  [existing]
    |
    v
Step 1: Self-referential filter (skip Laminark's own tools)  [existing]
    |
    v
Step 2: Extract observation, privacy filter, admission filter  [existing]
    |
    v
Step 3: Store observation  [existing]
    |
    v
Step 4: ROUTING EVALUATION  [NEW - Phase 14]
    |
    +-- Load routing state for session (from routing_state table)
    +-- Check rate limits (max suggestions, cooldown)
    +-- Get available suggestable tools (scope-filtered, non-builtin, non-Laminark)
    +-- Try learned patterns (if enough history)
    +-- Fall back to heuristic (keyword matching)
    +-- Confidence gate (threshold check)
    +-- If above threshold: write to NotificationStore
    +-- Update routing state
    |
    v
Handler exits 0
```

**Timing budget:** Steps 0-3 currently take ~10-20ms. Step 4 must add no more than ~10ms. This means:
- 1-2 simple SQL queries for routing state and pattern lookup
- No file I/O, no embedding computation, no external calls
- Pre-computed patterns (computed at SessionStart, stored in SQLite) queried at PostToolUse time

## Data Flow: Pattern Pre-computation at SessionStart

```
Claude Code starts session
    |
    v
SessionStart hook fires -> handler.ts
    |
    v
Step 1: Create session record  [existing]
Step 2: Config scan for tools  [existing]
Step 3: Assemble context  [existing]
    |
    v
Step 4: PRE-COMPUTE ROUTING PATTERNS  [NEW - Phase 14]
    |
    +-- Extract tool sequence patterns from tool_usage_events
    +-- Store pre-computed patterns in routing_patterns table
    +-- These are consumed by PostToolUse routing evaluation
    |
    v
Step 5: Write context to stdout  [existing]
```

**Why pre-compute at SessionStart:** Pattern extraction scans tool_usage_events (potentially thousands of rows). This is too expensive for PostToolUse's 10ms budget. SessionStart has a more generous budget (~100-200ms total, and pattern extraction should take 5-20ms). Pre-computed patterns are stored in a simple table and queried cheaply at PostToolUse time.

## Database Schema Additions

### routing_state (transient, inline creation)

```sql
-- Created inline like pending_notifications (no migration needed)
CREATE TABLE IF NOT EXISTS routing_state (
  session_id TEXT NOT NULL,
  project_hash TEXT NOT NULL,
  suggestions_made INTEGER NOT NULL DEFAULT 0,
  last_suggestion_at TEXT,
  tool_calls_since_suggestion INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, project_hash)
);
```

### routing_patterns (transient, inline creation)

```sql
-- Pre-computed patterns refreshed at SessionStart
CREATE TABLE IF NOT EXISTS routing_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_hash TEXT NOT NULL,
  target_tool TEXT NOT NULL,
  preceding_tools TEXT NOT NULL,   -- JSON array of tool names
  frequency INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_patterns_project
  ON routing_patterns(project_hash);
```

**Why transient (inline) rather than migration:** These tables are ephemeral -- they are recomputed every SessionStart and hold no persistent user data. Using `CREATE TABLE IF NOT EXISTS` (the same pattern as `pending_notifications`) avoids adding migration 18 for data that does not need migration guarantees. Old rows are simply deleted and replaced on each SessionStart.

## Integration Points

| Component | How Routing Uses It | Direction |
|-----------|-------------------|-----------|
| `tool_usage_events` (Phase 12) | Source data for learned pattern extraction | Read |
| `tool_registry` (Phase 10) | Available tool list + descriptions for heuristic matching | Read |
| `getAvailableForSession()` (Phase 11) | Scope-filtered tool set for suggestion candidates | Read |
| `NotificationStore` (Phase 6) | Delivery mechanism for routing suggestions | Write |
| `observations` table | Recent session observations for heuristic keyword matching | Read |
| `handler.ts` PostToolUse path | Entry point for routing evaluation | Integration |
| `session-lifecycle.ts` SessionStart | Entry point for pattern pre-computation | Integration |
| `isLaminarksOwnTool()` (Phase 9) | Filter out self-referential suggestions | Read |
| `inferToolType()` (Phase 10) | Filter out built-in tool suggestions | Read |

## Open Questions

1. **Pattern window size tuning**
   - What we know: A window of 5 preceding tool calls is a reasonable starting point
   - What's unclear: Whether 3, 5, or 10 produces the best suggestions
   - Recommendation: Start with 5, make it configurable. Log pattern match quality for later tuning.

2. **Heuristic keyword quality for cold start**
   - What we know: Config-scanned tools have descriptions (from SKILL.md), organically discovered tools often do not
   - What's unclear: How many tools in a typical setup have usable descriptions
   - Recommendation: Fall back to server name / command path keywords when description is null. This should cover most cases.

3. **Negative feedback mechanism**
   - What we know: ROUT-03 says "no suggestion when uncertain." But there is no mechanism to learn from IGNORED suggestions.
   - What's unclear: Whether to track ignored suggestions for future pattern refinement
   - Recommendation: Phase 14 tracks whether suggested tools were subsequently used (simple check in PostToolUse: "was this tool recently suggested?"). Defer full negative feedback to a future phase.

4. **Cross-project pattern learning**
   - What we know: tool_usage_events includes project_hash. Patterns could be extracted across projects.
   - What's unclear: Whether cross-project patterns are useful or just noisy
   - Recommendation: Phase 14 uses project-scoped patterns only. Cross-project is a future enhancement after validating single-project routing quality.

## Sources

### Primary (HIGH confidence)
- Laminark codebase analysis: `src/hooks/handler.ts`, `src/storage/tool-registry.ts`, `src/storage/notifications.ts`, `src/context/injection.ts`, `src/hooks/session-lifecycle.ts`, `src/hooks/config-scanner.ts`, `src/hooks/tool-name-parser.ts`, `src/hooks/self-referential.ts`, `src/shared/tool-types.ts`, `src/index.ts`
- Phase 12 plan (12-01-PLAN.md): tool_usage_events schema, temporal query methods, event recording
- Phase 13 plan (13-01-PLAN.md): relevance ranking, 500-char sub-budget, frequency share scoring
- Architecture research (ARCHITECTURE.md): component boundaries, data flow diagrams, anti-patterns
- Feature research (FEATURES.md): routing design rationale, cold start handling, anti-features
- Pitfalls research (PITFALLS.md): ghost tools, over-suggestion, self-referential loops, handler performance
- Stack research (STACK.md): zero new dependencies, tool name parsing, config resolution

### Secondary (MEDIUM confidence)
- Routing design patterns from architecture research: notification-based delivery, scope filtering, heuristic fallback

### Tertiary (LOW confidence)
- Pattern window size (5) and threshold (0.6) are educated defaults, not empirically validated. These should be treated as tunable parameters.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - zero new dependencies, builds entirely on existing infrastructure verified through 13 prior phases
- Architecture: HIGH - notification delivery, scope filtering, and handler integration patterns are proven by Phases 6, 10-13
- Routing algorithm: MEDIUM - the two-tier approach (heuristic + learned) is well-established in intent routing literature, but the specific threshold/window values need empirical tuning
- Pitfalls: HIGH - grounded in Laminark's documented architectural constraints (handler performance, stdout contract, self-referential filtering)

**Research date:** 2026-02-10
**Valid until:** 30 days (stable domain -- routing patterns and delivery mechanism are unlikely to change)
