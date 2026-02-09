---
phase: 07-knowledge-graph-and-advanced-intelligence
plan: 03
subsystem: intelligence
tags: [entity-extraction, knowledge-graph, nlp, pattern-matching, rule-based]

# Dependency graph
requires:
  - phase: 07-knowledge-graph-and-advanced-intelligence
    provides: "GraphNode/GraphEdge types, upsertNode mutation, initGraphSchema, EntityType union (Plan 01)"
provides:
  - "ExtractionRule type and 7 named rule exports for entity pattern matching"
  - "ALL_RULES array for pipeline iteration"
  - "extractEntities() pure function: text -> EntityExtractionResult with dedup and confidence filtering"
  - "extractAndPersist() transactional function: text -> GraphNode[] persisted to SQLite"
  - "EntityExtractionResult interface with entities, observationId, extractedAt"
  - "Curated KNOWN_TOOLS list (~80 dev tools) for Tool entity matching"
affects: [07-04, 07-05, 07-06, 07-07]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Rule-based extraction with per-type confidence scoring", "Same-type-only overlap resolution preserving cross-type entity coexistence", "Two-stage regex matching for case-sensitive name capture with case-insensitive verb detection"]

key-files:
  created:
    - src/graph/extraction-rules.ts
    - src/graph/entity-extractor.ts
    - src/graph/__tests__/entity-extractor.test.ts
  modified: []

key-decisions:
  - "Same-type-only overlap resolution: different entity types can coexist on overlapping text spans (e.g., Decision span containing Tool name)"
  - "Person rule uses two-stage matching: case-insensitive verb regex followed by case-sensitive capitalized name extraction"
  - "Project rule negative lookbehind for @ to prevent duplicate matches with scoped package rule"
  - "Test files placed in src/graph/__tests__/ following project convention (not tests/ directory from plan)"

patterns-established:
  - "ExtractionRule function signature: (text: string) => ExtractionMatch[] with name, type, confidence, span"
  - "Confidence tiers: File(0.95) > Tool(0.9) > Project(0.8) > Decision(0.7) > Problem/Solution(0.65) > Person(0.6)"
  - "Clause extraction pattern: find indicator phrase, extract following text up to sentence boundary"

# Metrics
duration: 6min
completed: 2026-02-09
---

# Phase 7 Plan 3: Entity Extraction Pipeline Summary

**Rule-based entity extraction for 7 types (File, Tool, Project, Decision, Problem, Solution, Person) with confidence-scored dedup and transactional graph persistence**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-09T05:18:57Z
- **Completed:** 2026-02-09T05:25:15Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- 7 entity type extraction rules with tiered confidence scoring (0.6-0.95) covering file paths, dev tools (~80 curated names), project references, decisions, problems, solutions, and persons
- Entity extraction pipeline with same-type overlap resolution, name+type deduplication, configurable confidence threshold, and confidence-sorted output
- Transactional persistence via extractAndPersist() that upserts extracted entities as graph nodes with observation_id linkage and graceful per-entity error handling
- 41 tests covering all rule types, pipeline behavior (dedup, overlap, threshold, sorting), and database persistence (create, merge, multi-type)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create extraction rules for each entity type** - `06f4519` (feat)
2. **Task 2: Create entity extraction pipeline and tests** - `1641b0e` (feat)

## Files Created/Modified
- `src/graph/extraction-rules.ts` - 7 ExtractionRule functions (filePathRule, decisionRule, toolRule, personRule, problemRule, solutionRule, projectRule) plus ALL_RULES array and curated KNOWN_TOOLS list
- `src/graph/entity-extractor.ts` - extractEntities (pure extraction with dedup/overlap/threshold), extractAndPersist (transactional graph storage), EntityExtractionResult interface
- `src/graph/__tests__/entity-extractor.test.ts` - 41 tests: per-rule unit tests, pipeline integration tests, persistence tests

## Decisions Made
- **Same-type-only overlap resolution:** The plan specified "higher confidence wins" for overlapping spans, but this was too aggressive -- it would remove a Decision entity whenever a Tool name appeared within the decision text. Changed to only resolve overlaps between same-type entities, allowing cross-type coexistence. This correctly preserves "Decided to use Tailwind CSS" as both a Decision and a Tool extraction.
- **Two-stage person matching:** The "with [Name]" regex originally used the `gi` flag which broke case-sensitive name capture (uppercase requirement). Fixed with two-stage approach: case-insensitive verb regex followed by anchored case-sensitive name extraction.
- **Project rule @-exclusion:** The org/repo regex (`org/name`) was matching scoped packages (`@org/name`) without the `@`, causing duplicates. Added negative lookbehind for `@`.
- **Test location:** Plan specified `tests/graph/entity-extractor.test.ts` but project convention is `src/**/__tests__/*.test.ts` (vitest config includes `src/**/*.test.ts`). Used project convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Same-type-only overlap resolution**
- **Found during:** Task 2 (test "extracts Decision entity from decision language")
- **Issue:** Overlap resolver was removing Decision entity when Tool name "tailwind" appeared inside the decision span, since Tool had higher confidence (0.9 vs 0.7)
- **Fix:** Changed resolveOverlaps() to only check for conflicts between same-type entities
- **Files modified:** src/graph/entity-extractor.ts
- **Verification:** Test passes -- Decision and Tool entities coexist from same observation
- **Committed in:** 1641b0e (Task 2 commit)

**2. [Rule 1 - Bug] Case-insensitive person verb matching**
- **Found during:** Task 2 (test "extracts worked with [Name] pattern")
- **Issue:** The `gi` flag on the withRegex caused `[A-Z]` and `[a-z]` character classes to lose case distinction, matching "on" as a capitalized name word
- **Fix:** Two-stage matching: case-insensitive verb regex for the prefix, then anchored case-sensitive regex for the capitalized name
- **Files modified:** src/graph/extraction-rules.ts
- **Verification:** "Paired with Alice Johnson on the feature" correctly extracts "Alice Johnson" only
- **Committed in:** 1641b0e (Task 2 commit)

**3. [Rule 1 - Bug] Project rule duplicate with scoped packages**
- **Found during:** Task 2 (test "extracts scoped npm package")
- **Issue:** org/repo regex matched "laminark/memory" from "@laminark/memory", creating duplicate Project entity alongside the scoped package match
- **Fix:** Added negative lookbehind `(?<![@a-zA-Z0-9])` to org/repo regex
- **Files modified:** src/graph/extraction-rules.ts
- **Verification:** "@laminark/memory" produces exactly one Project entity
- **Committed in:** 1641b0e (Task 2 commit)

**4. [Rule 3 - Blocking] Test file path convention**
- **Found during:** Task 2 (test creation)
- **Issue:** Plan specified `tests/graph/entity-extractor.test.ts` but vitest config includes `src/**/*.test.ts` only
- **Fix:** Created tests at `src/graph/__tests__/entity-extractor.test.ts` following project convention
- **Files modified:** src/graph/__tests__/entity-extractor.test.ts (created at correct path)
- **Verification:** `npx vitest run` discovers and runs all 41 tests
- **Committed in:** 1641b0e (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (3 bugs, 1 blocking)
**Impact on plan:** All fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Entity extraction pipeline ready for integration with observation ingestion (07-04+)
- extractAndPersist() provides the bridge from raw observation text to knowledge graph nodes
- ALL_RULES array is extensible -- new entity types can be added by appending to the array
- 558 total tests passing (41 new + 517 existing), no regressions

## Self-Check: PASSED

All files verified present, all commit hashes verified in git log.

---
*Phase: 07-knowledge-graph-and-advanced-intelligence*
*Completed: 2026-02-09*
