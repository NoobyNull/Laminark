---
phase: 07-knowledge-graph-and-advanced-intelligence
plan: 05
subsystem: intelligence
tags: [knowledge-graph, relationship-detection, constraint-enforcement, entity-dedup, graph-health]

# Dependency graph
requires:
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 01
    provides: "Graph schema, upsertNode, insertEdge, getEdgesForNode, countEdgesForNode, getNodeByNameAndType, EntityType/RelationshipType types, MAX_NODE_DEGREE constant"
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 03
    provides: "Entity extraction pipeline, EntityExtractionResult, extractEntities, ALL_RULES"
provides:
  - "detectRelationships() infers typed relationships between co-occurring entities"
  - "detectAndPersist() resolves entities to nodes and creates graph edges with max degree enforcement"
  - "RelationshipCandidate interface for relationship detection results"
  - "validateEntityType/validateRelationshipType runtime taxonomy guards"
  - "enforceMaxDegree() prunes lowest-weight edges when node exceeds 50-edge cap"
  - "mergeEntities() reroutes edges and merges observation_ids for entity deduplication"
  - "findDuplicateEntities() detects case-insensitive, abbreviation, and path duplicates"
  - "getGraphHealth() dashboard with node/edge counts, degree metrics, hotspots, duplicate candidates"
affects: [07-06, 07-07]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Context signal scanning with priority ordering for relationship type inference", "Expanded context window (50-char buffer around entity pair) for signal detection", "Transaction-wrapped constraint enforcement with pruning by weight", "Three-strategy duplicate detection (case-insensitive, abbreviation, path normalization)"]

key-files:
  created:
    - src/graph/relationship-detector.ts
    - src/graph/constraints.ts
    - src/graph/__tests__/relationship-detector.test.ts
  modified: []

key-decisions:
  - "Context signal priority: decided_by > solved_by > caused_by > depends_on > part_of > uses (most specific first to avoid false 'uses' matches)"
  - "Context window expanded to 50 chars before/after entity pair to capture signals like 'Decided by @matt to use Tailwind' where 'Decided' precedes both entities"
  - "Removed 'with' and 'from' and 'in' from context signals to reduce false positives (too common in general text)"
  - "Test file placed at src/graph/__tests__/relationship-detector.test.ts following project convention (not tests/graph/)"
  - "Constraints module logs pruning/merging to stderr with [laminark:graph] prefix for observability"

patterns-established:
  - "Relationship detection pattern: type-pair defaults + context signal override + proximity/sentence confidence boost"
  - "Constraint enforcement pattern: transaction-wrapped, lowest-weight-first pruning, log significant actions"
  - "Duplicate detection pattern: multi-strategy (case, abbreviation, path normalization) with suggestion-not-action API"

# Metrics
duration: 5min
completed: 2026-02-09
---

# Phase 7 Plan 5: Relationship Detection and Graph Constraints Summary

**Context-aware relationship inference between co-occurring entities with graph health enforcement (50-edge degree cap, entity deduplication, taxonomy validation)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-09T05:28:54Z
- **Completed:** 2026-02-09T05:34:28Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- Relationship detection pipeline inferring 7 typed relationships (uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by) from entity co-occurrence with priority-ordered context signal scanning
- Proximity boost (+0.1 within 50 chars) and sentence co-occurrence boost (+0.15) for confidence scoring, with expanded 50-char context window around entity pairs
- Graph constraint enforcement: runtime type taxonomy validation, 50-edge degree cap with lowest-weight pruning, entity dedup detection (case-insensitive, abbreviation, path normalization), and entity merging with edge rerouting
- Graph health dashboard reporting total nodes/edges, average/max degree, hotspot detection (>80% of cap), and duplicate candidate count
- 27 new tests covering all relationship types, confidence boosting, persistence, constraint enforcement, and graph health metrics (597 total, no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement relationship detection between co-occurring entities** - `6d7dac9` (feat)
2. **Task 2: Implement graph constraint enforcement** - `00cbabd` (feat)

## Files Created/Modified
- `src/graph/relationship-detector.ts` - detectRelationships (context-aware type inference), detectAndPersist (entity resolution + edge creation + degree enforcement), RelationshipCandidate interface
- `src/graph/constraints.ts` - validateEntityType/validateRelationshipType, enforceMaxDegree (lowest-weight pruning), mergeEntities (edge rerouting + observation_id union), findDuplicateEntities (3-strategy detection), getGraphHealth (dashboard metrics)
- `src/graph/__tests__/relationship-detector.test.ts` - 27 tests covering relationship detection (10), persistence (3), and constraint enforcement (14: validation, pruning, merging, duplicates, health)

## Decisions Made
- **Context signal priority ordering:** Reordered signals so "decided_by", "solved_by", "caused_by" are checked before "uses". This prevents false "uses" matches when text like "Decided by @matt to use Tailwind CSS" contains both "decided" and "use" -- the more specific signal ("decided") should win.
- **Expanded context window:** The initial approach of scanning only between entities missed context signals that preceded both entities. Expanded to include 50 chars before and after the entity pair span, correctly detecting "Decided by @matt to use Tailwind CSS" as a decided_by relationship.
- **Removed overly broad signals:** Dropped "with", "from", and "in" from context signal patterns -- these words are too common in general English and caused false positive relationship type overrides. Entity type-pair defaults handle these cases better.
- **Test file location:** Plan specified `tests/graph/relationship-detector.test.ts` but vitest config only scans `src/**/*.test.ts`. Used project convention at `src/graph/__tests__/relationship-detector.test.ts`.
- **Shared test file:** Constraint tests co-located with relationship detector tests since the modules are tightly coupled (relationship-detector imports from constraints). Single test file covers both modules.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Context signal priority ordering**
- **Found during:** Task 1 (test "detects decided_by between Decision and Person")
- **Issue:** The "uses" context signal matched before "decided_by" because "use" appeared in the entity text "use Tailwind CSS", overriding the type-pair default
- **Fix:** Reordered CONTEXT_SIGNALS array: most specific signals (decided_by, solved_by, caused_by) first, least specific (uses) last
- **Files modified:** src/graph/relationship-detector.ts
- **Verification:** Test "detects decided_by between Decision and Person" passes
- **Committed in:** 6d7dac9 (Task 1 commit)

**2. [Rule 1 - Bug] Context window too narrow for signal detection**
- **Found during:** Task 1 (test "detects decided_by between Decision and Person")
- **Issue:** Context signals preceding both entities (e.g., "Decided" before "@matt" and "use Tailwind CSS") were missed because only text between entity positions was scanned
- **Fix:** Expanded context window to include 50 characters before first entity and after last entity
- **Files modified:** src/graph/relationship-detector.ts
- **Verification:** All relationship type tests pass including decided_by, solved_by, part_of
- **Committed in:** 6d7dac9 (Task 1 commit)

**3. [Rule 1 - Bug] SQL HAVING clause on non-aggregate query**
- **Found during:** Task 2 (test "returns accurate graph health metrics")
- **Issue:** getGraphHealth used HAVING clause with a correlated subquery, but HAVING requires GROUP BY in SQLite
- **Fix:** Changed HAVING to WHERE with repeated correlated subquery
- **Files modified:** src/graph/constraints.ts
- **Verification:** Graph health tests pass with correct metrics
- **Committed in:** 00cbabd (Task 2 commit)

**4. [Rule 3 - Blocking] Test file path convention**
- **Found during:** Task 1 (test creation)
- **Issue:** Plan specified `tests/graph/relationship-detector.test.ts` but vitest config only scans `src/**/*.test.ts`
- **Fix:** Placed test at `src/graph/__tests__/relationship-detector.test.ts` following project convention
- **Files modified:** src/graph/__tests__/relationship-detector.test.ts
- **Verification:** `npx vitest run` discovers and runs all 27 tests
- **Committed in:** 6d7dac9 (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (3 bugs, 1 blocking)
**Impact on plan:** All fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Relationship detection pipeline ready for integration with entity extraction in observation ingestion flow
- detectAndPersist() can be called after extractAndPersist() to create edges between co-occurring entities
- Graph constraints prevent unbounded growth: type taxonomy validated, degree capped at 50, duplicates detectable
- mergeEntities() enables curation workflow for resolving detected duplicates
- getGraphHealth() provides the foundation for monitoring/diagnostics tooling in Plan 07

## Self-Check: PASSED

All files verified present, all commit hashes verified in git log.

---
*Phase: 07-knowledge-graph-and-advanced-intelligence*
*Completed: 2026-02-09*
