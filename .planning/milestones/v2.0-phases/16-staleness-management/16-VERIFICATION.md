---
phase: 16-staleness-management
verified: 2026-02-10T23:59:00Z
status: passed
score: 6/6 must-haves verified
re_verification: false
---

# Phase 16: Staleness Management Verification Report

**Phase Goal:** The tool registry stays accurate over time by detecting removed tools, deprioritizing stale entries, and demoting tools that consistently fail
**Verified:** 2026-02-10T23:59:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                  | Status     | Evidence                                                                                  |
| --- | ---------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| 1   | Tools have a three-state status: active, stale, or demoted            | ✓ VERIFIED | Migration 19 adds status column, ToolRegistryRow.status field exists                      |
| 2   | On session start, tools removed from config are marked stale          | ✓ VERIFIED | detectRemovedTools function wired into handleSessionStart after config scan               |
| 3   | Tools not seen in 30+ days are ranked lower in suggestions            | ✓ VERIFIED | rankToolsByRelevance applies 0.5x age penalty for daysSinceLastSeen > 30                  |
| 4   | Tools with 3+ failures in last 5 events are demoted                   | ✓ VERIFIED | PostToolUse checks getRecentEventsForTool(5), counts failures, calls markDemoted          |
| 5   | A single successful use restores a demoted tool to active             | ✓ VERIFIED | PostToolUse success branch calls markActive                                               |
| 6   | Stale/demoted tools are excluded from routing suggestions             | ✓ VERIFIED | ConversationRouter filters suggestableTools to status === 'active'                        |
| 7   | Search results show status marker for stale/demoted tools             | ✓ VERIFIED | discover_tools formatToolResult adds statusTag when status !== 'active'                   |

**Score:** 7/7 truths verified

### Required Artifacts (Plan 16-01)

| Artifact                        | Expected                                                                           | Status     | Details                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `src/storage/migrations.ts`     | Migration 19: status column on tool_registry with index                           | ✓ VERIFIED | Line 537: ALTER TABLE tool_registry ADD COLUMN status TEXT NOT NULL DEFAULT 'active' + index             |
| `src/shared/tool-types.ts`      | status field on ToolRegistryRow interface                                          | ✓ VERIFIED | Line 41: status: string; // 'active' \| 'stale' \| 'demoted'                                             |
| `src/storage/tool-registry.ts`  | markStale, markDemoted, markActive, getConfigSourcedTools, getRecentEventsForTool | ✓ VERIFIED | All 5 methods exist (lines 335-394) with prepared statements and try/catch error handling                |

### Required Artifacts (Plan 16-02)

| Artifact                              | Expected                                                                | Status     | Details                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `src/hooks/session-lifecycle.ts`      | detectRemovedTools function and SessionStart wiring                     | ✓ VERIFIED | Lines 20-67: detectRemovedTools function; Line 111: called after config scan in handleSessionStart       |
| `src/hooks/handler.ts`                | Failure demotion check and success restoration in PostToolUse           | ✓ VERIFIED | Lines 92-106: STAL-03 block with getRecentEventsForTool, markDemoted on 3+ failures, markActive on success |
| `src/context/injection.ts`            | Age-based and status-based score penalty in rankToolsByRelevance        | ✓ VERIFIED | Lines 318-331: 0.25x penalty for stale/demoted, 0.5x penalty for 30+ days age (stacking)                 |
| `src/routing/conversation-router.ts`  | Stale/demoted tools filtered from suggestable set                       | ✓ VERIFIED | Line 120: filter condition t.status === 'active'                                                         |
| `src/mcp/tools/discover-tools.ts`     | Status indicator in search result formatting                            | ✓ VERIFIED | Line 50: statusTag shows [stale] or [demoted] for non-active tools                                       |

### Key Link Verification

| From                                    | To                             | Via                                                                   | Status     | Details                                                                                       |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `src/storage/tool-registry.ts`         | `src/storage/migrations.ts`    | Migration 19 adds status column that new prepared statements query    | ✓ WIRED    | stmtMarkStale/Demoted/Active all query status column; stmtGetAvailableForSession orders by it |
| `src/storage/tool-registry.ts`         | `src/shared/tool-types.ts`     | ToolRegistryRow type includes status field                            | ✓ WIRED    | ToolRegistryRow imported and used as return type; status field exists on interface            |
| `src/hooks/session-lifecycle.ts`       | `src/storage/tool-registry.ts` | detectRemovedTools calls getConfigSourcedTools, markStale, markActive | ✓ WIRED    | Lines 26, 39, (implicit via upsert restore): all methods called correctly                     |
| `src/hooks/handler.ts`                 | `src/storage/tool-registry.ts` | PostToolUse calls getRecentEventsForTool, markDemoted, markActive     | ✓ WIRED    | Lines 95-96, 100, 105: methods called with correct arguments in failure/success branches      |
| `src/context/injection.ts`             | `src/shared/tool-types.ts`     | rankToolsByRelevance reads row.status for score penalty               | ✓ WIRED    | Line 318: row.status checked against 'stale' and 'demoted' literals                           |
| `src/routing/conversation-router.ts`   | `src/shared/tool-types.ts`     | Filter suggestable tools by status === 'active'                       | ✓ WIRED    | Line 120: status field accessed on ToolRegistryRow type in filter predicate                   |

### Requirements Coverage

**REQUIREMENTS MAPPED TO PHASE 16:**

| Requirement | Description                                                                                                      | Status       | Supporting Truths |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------ | ----------------- |
| STAL-01     | Config rescan staleness detection: mark tools removed from config as stale                                       | ✓ SATISFIED  | Truth 2           |
| STAL-02     | Age-based deprioritization: tools not seen in 30+ days ranked lower                                              | ✓ SATISFIED  | Truth 3           |
| STAL-03     | Failure-driven demotion: 3+ failures in last 5 events triggers demotion; single success restores                 | ✓ SATISFIED  | Truths 4, 5       |

**All requirements satisfied.**

### Anti-Patterns Found

**SCAN RESULTS:** 8 files scanned (migrations, tool-types, tool-registry, session-lifecycle, handler, injection, conversation-router, discover-tools)

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | - | - | - | No anti-patterns found |

**SCAN CLEAN:**
- No TODO/FIXME/PLACEHOLDER comments related to staleness
- No console.log debugging statements
- No empty implementations or stub functions
- All methods have proper error handling (try/catch with debug logging)
- All prepared statements properly initialized in constructor
- Idempotent status transitions (markStale, markActive) include guard clauses

### Implementation Quality Notes

**EXCELLENT PATTERNS:**

1. **Idempotent status transitions**: markStale and markActive use `AND status != 'stale'` / `AND status != 'active'` guards to avoid unnecessary updates
2. **Cascading staleness**: detectRemovedTools tracks removed MCP servers and marks individual tools from those servers stale
3. **Non-fatal error handling**: All staleness operations wrapped in try/catch with debug logging, ensuring staleness management never breaks core functionality
4. **Stacking penalties**: Status penalty (0.25x) and age penalty (0.5x) multiply independently, allowing fine-grained deprioritization
5. **Status-aware ordering**: getAvailableForSession prepends status-based CASE ordering before tool_type ordering, ensuring absolute priority
6. **Auto-restoration via upsert**: ON CONFLICT clause sets status='active', automatically restoring tools re-discovered via config scan

**COMPLETE WIRING:**

- detectRemovedTools correctly compares Set of scanned tool names against getConfigSourcedTools results
- PostToolUse failure branch counts failures from getRecentEventsForTool and calls markDemoted when threshold reached
- PostToolUse success branch unconditionally calls markActive, instantly restoring demoted tools
- rankToolsByRelevance reads row.status and computes daysSinceLastSeen from MAX(last_used_at/discovered_at, updated_at)
- ConversationRouter filters suggestable tools using strict equality (status === 'active')
- discover_tools shows [stale] or [demoted] tags for non-active tools in search results

### Human Verification Required

**NONE.** All functionality can be verified programmatically:
- Migration 19 execution can be tested via npx vitest run
- Status transitions can be verified via database queries
- Ranking penalties can be tested via unit tests on rankToolsByRelevance
- Routing exclusion can be tested via ConversationRouter._evaluate
- Search status display can be tested via formatToolResult

**OPTIONAL USER TESTING (not required for verification):**

1. **Config removal detection**
   - **Test:** Remove an MCP server from .claude/config.json, start a new session
   - **Expected:** Server and its individual tools marked stale in database
   - **Why optional:** Database state can be verified via SQL queries

2. **Failure demotion**
   - **Test:** Use a tool that fails 3+ times in succession
   - **Expected:** Tool marked demoted, excluded from routing suggestions
   - **Why optional:** Database state and filtering logic can be unit tested

3. **Search status display**
   - **Test:** Use discover_tools to search for a demoted or stale tool
   - **Expected:** Tool shows [stale] or [demoted] tag in results
   - **Why optional:** formatToolResult output can be verified via function call

---

## Verification Summary

**STATUS: PASSED**

All 7 observable truths verified. All 8 required artifacts exist and are substantive. All 6 key links wired correctly. All 3 requirements satisfied. Zero anti-patterns found.

**PHASE 16 GOAL ACHIEVED:**

The tool registry stays accurate over time by:
1. **Detecting removed tools**: detectRemovedTools compares config scan against registry at SessionStart, marking missing config-sourced tools (and child MCP tools) as stale
2. **Deprioritizing stale entries**: rankToolsByRelevance applies 0.25x penalty to stale/demoted tools and 0.5x penalty to tools not seen in 30+ days
3. **Demoting tools that consistently fail**: PostToolUse tracks last 5 events, demotes tools with 3+ failures, and restores to active on first success

**COMMITS VERIFIED:**
- 1b8c24e: Migration 19 and status field
- 38dc171: Staleness methods and status-aware ordering
- 2eb514b: detectRemovedTools at SessionStart
- 48ce258: Failure demotion and success restoration
- 784e0e6: Ranking penalties, routing exclusion, search status display

**READY TO PROCEED:** Phase 16 complete. All v2.0 Tool Intelligence milestone requirements satisfied.

---

_Verified: 2026-02-10T23:59:00Z_
_Verifier: Claude (gsd-verifier)_
