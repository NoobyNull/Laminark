---
phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku
plan: 02
subsystem: intelligence
tags: [haiku, background-processing, entity-extraction, relationship-inference, classification, pipeline-wiring]

requires:
  - phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku
    provides: "Haiku agent modules (classifier, entity, relationship) and shared client"
provides:
  - "HaikuProcessor background orchestrator for classification + entity extraction + relationship inference"
  - "Simplified admission filter (no regex noise patterns)"
  - "Embedding loop stripped to only handle embeddings, SSE, topic shift"
  - "Deprecated regex extraction rules removed from codebase"
  - "Broken MCP sampling ObservationClassifier removed"
affects: [17-03, graph-curation, entity-extractor, relationship-detector, admission-filter]

tech-stack:
  added: []
  patterns: ["Timer-based background processing with per-observation try/catch isolation", "Store-then-soft-delete pattern for noise observations", "Concurrency-limited parallel processing via Promise.all batches"]

key-files:
  created:
    - src/intelligence/haiku-processor.ts
  modified:
    - src/graph/entity-extractor.ts
    - src/graph/relationship-detector.ts
    - src/hooks/admission-filter.ts
    - src/hooks/noise-patterns.ts
    - src/graph/signal-classifier.ts
    - src/index.ts
  deleted:
    - src/graph/extraction-rules.ts
    - src/curation/observation-classifier.ts
    - src/graph/__tests__/entity-extractor.test.ts
    - src/curation/__tests__/observation-classifier.test.ts

key-decisions:
  - "Deleted regex extraction rules entirely rather than keeping as fallback -- HaikuProcessor is the sole extraction path"
  - "Deprecated sync extractEntities/extractAndPersist return empty results -- backward-compatible signatures preserved"
  - "Removed provenance and temporal edge creation from embedding loop -- will be added to HaikuProcessor in Plan 03 if needed"

patterns-established:
  - "HaikuProcessor pattern: timer -> batch query -> concurrency-limited parallel processing -> per-observation isolation"
  - "Store-then-classify: observations stored unconditionally, classified by Haiku background processor, noise soft-deleted"

duration: 6min
completed: 2026-02-14
---

# Phase 17 Plan 02: Pipeline Integration Summary

**HaikuProcessor replaces regex extraction and broken MCP classifier, simplifies admission filter, and removes 1500+ lines of obsolete regex/classifier code**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-14T06:55:24Z
- **Completed:** 2026-02-14T07:01:24Z
- **Tasks:** 3
- **Files modified:** 11 (1 created, 6 modified, 4 deleted)

## Accomplishments
- Created HaikuProcessor background orchestrator that classifies observations, extracts entities, and infers relationships via Haiku agents on a 30-second timer
- Simplified admission filter by removing regex noise pattern check (noise is now Haiku's job post-storage)
- Rewired index.ts: replaced ObservationClassifier with HaikuProcessor, removed entire graph extraction block from embedding loop
- Deleted extraction-rules.ts (352 lines of regex rules) and observation-classifier.ts (301 lines of broken MCP sampling code)
- Added async Haiku-delegating exports to entity-extractor.ts and relationship-detector.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Create HaikuProcessor and modify entity-extractor + relationship-detector** - `3130239` (feat)
2. **Task 2: Simplify admission filter and rewire index.ts** - `4470b79` (feat)
3. **Task 3: Delete obsolete files and clean up imports** - `816fd5a` (feat)

## Files Created/Modified
- `src/intelligence/haiku-processor.ts` - Background orchestrator: timer-based classification + entity extraction + relationship inference
- `src/graph/entity-extractor.ts` - Added extractEntitiesAsync(), deprecated sync functions now return empty results
- `src/graph/relationship-detector.ts` - Added detectRelationshipsAsync(), marked sync detectRelationships() as deprecated
- `src/hooks/admission-filter.ts` - Removed isNoise() regex call, kept cheap structural filters
- `src/hooks/noise-patterns.ts` - Marked deprecated (retained for reference)
- `src/graph/signal-classifier.ts` - Marked deprecated (retained for backward compatibility)
- `src/index.ts` - Replaced ObservationClassifier with HaikuProcessor, removed graph extraction from embedding loop
- `src/graph/extraction-rules.ts` - DELETED (regex entity extraction rules)
- `src/curation/observation-classifier.ts` - DELETED (broken MCP sampling classifier)
- `src/graph/__tests__/entity-extractor.test.ts` - DELETED (tested deleted regex rules)
- `src/curation/__tests__/observation-classifier.test.ts` - DELETED (tested deleted classifier)

## Decisions Made
- Deleted regex extraction rules entirely rather than keeping as inline fallback -- HaikuProcessor calls agents directly, no code path uses the regex rules anymore
- Deprecated sync extractEntities/extractAndPersist return empty results to preserve backward-compatible function signatures
- Removed provenance and temporal edge creation from embedding loop along with the rest of graph extraction -- these were tightly coupled to the regex entity extraction path

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed EntityType type mismatch in HaikuProcessor**
- **Found during:** Task 1
- **Issue:** HaikuProcessor declared entities as `Array<{type: string}>` which didn't match `QualityGateEntity` requiring `EntityType`
- **Fix:** Added EntityType import and used proper type annotation
- **Files modified:** src/intelligence/haiku-processor.ts
- **Committed in:** 3130239 (Task 1 commit)

**2. [Rule 3 - Blocking] Deleted test files for deleted modules**
- **Found during:** Task 3
- **Issue:** entity-extractor.test.ts imported from deleted extraction-rules.ts, observation-classifier.test.ts tested deleted module
- **Fix:** Deleted both test files along with their source modules
- **Files modified:** src/graph/__tests__/entity-extractor.test.ts, src/curation/__tests__/observation-classifier.test.ts
- **Committed in:** 816fd5a (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary for build to pass. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required (API key setup covered in Plan 01).

## Next Phase Readiness
- HaikuProcessor is live and wired into the MCP server lifecycle
- Plan 03 will handle configuration, testing, and any remaining integration concerns
- No blockers

## Self-Check: PASSED

---
*Phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku*
*Completed: 2026-02-14*
