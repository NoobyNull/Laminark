---
phase: 03-hook-integration-and-capture
plan: 02
subsystem: hooks
tags: [noise-detection, privacy, regex, filtering, redaction, tdd]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "debug() logging infrastructure for rejection/redaction events"
provides:
  - "shouldAdmit(toolName, content) -> boolean admission filter with noise detection"
  - "NOISE_PATTERNS and isNoise() noise pattern library"
  - "redactSensitiveContent(text, filePath?) -> string|null privacy filter"
  - "isExcludedFile(filePath) -> boolean file exclusion check"
affects: [03-hook-integration-and-capture, 04-embedding-and-semantic, 05-session-awareness]

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-function-filter, pattern-first-ordering, negative-lookahead-dedup, cached-config-loading]

key-files:
  created:
    - src/hooks/noise-patterns.ts
    - src/hooks/admission-filter.ts
    - src/hooks/privacy-filter.ts
    - src/hooks/__tests__/admission-filter.test.ts
    - src/hooks/__tests__/privacy-filter.test.ts
  modified: []

key-decisions:
  - "API key patterns applied before env_variable to prevent double-match; env_variable uses negative lookahead (?![REDACTED:) to skip already-redacted values"
  - "Write/Edit tools unconditionally admitted via HIGH_SIGNAL_TOOLS set -- content pattern matching only applies to Bash/Read output"
  - "Laminark self-referential MCP tools (mcp__laminark__*) rejected in admission filter to prevent observing own operations"
  - "Privacy patterns cached per-process with _resetPatternCache() escape hatch for testing"

patterns-established:
  - "Pattern ordering matters: specific patterns (api_key) before general (env_variable) with negative lookahead to prevent re-matching"
  - "Tool-type-first filtering: high-signal tools bypass content analysis entirely"
  - "Configurable patterns via ~/.laminark/config.json privacy section extending defaults"

# Metrics
duration: 5min
completed: 2026-02-08
---

# Phase 3 Plan 2: Admission Filter and Privacy Filter Summary

**Pure-function admission filter rejecting 4 noise categories and privacy filter redacting 7 secret patterns with user-extensible config**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-08T22:43:56Z
- **Completed:** 2026-02-08T22:49:18Z
- **Tasks:** 2
- **Files created:** 5

## Accomplishments
- Admission filter correctly rejects BUILD_OUTPUT, PACKAGE_INSTALL, LINTER_WARNING, and EMPTY_OUTPUT noise from Bash/Read tools while always admitting Write/Edit observations
- Privacy filter redacts 7 secret pattern types (env variables, OpenAI/GitHub/AWS API keys, JWTs, connection strings, private keys) and fully excludes sensitive files (.env, credentials, secrets, .pem, .key, id_rsa)
- User-extensible privacy patterns via ~/.laminark/config.json privacy.additionalPatterns
- 86 new tests (46 admission + 40 privacy) all passing, 222 total suite tests pass

## Task Commits

Each task was committed atomically with TDD RED-GREEN flow:

1. **Task 1: Admission Filter with Noise Detection**
   - RED: `17d4329` (test) - Failing tests for admission filter and noise patterns
   - GREEN: `d1f5ad7` (feat) - Implement admission filter with noise detection

2. **Task 2: Privacy Filter with Configurable Patterns**
   - RED: `20a7657` (test) - Failing tests for privacy filter
   - GREEN: `fd4bfa2` (feat) - Implement privacy filter with configurable patterns

## Files Created/Modified
- `src/hooks/noise-patterns.ts` - Noise pattern definitions (BUILD_OUTPUT, PACKAGE_INSTALL, LINTER_WARNING, EMPTY_OUTPUT) and isNoise() detector
- `src/hooks/admission-filter.ts` - shouldAdmit(toolName, content) admission gate with tool-type-first filtering
- `src/hooks/privacy-filter.ts` - redactSensitiveContent() with 7 default patterns, file exclusion, and user config extension
- `src/hooks/__tests__/admission-filter.test.ts` - 46 tests covering all noise categories and tool-type behavior
- `src/hooks/__tests__/privacy-filter.test.ts` - 40 tests covering all secret patterns, file exclusion, and user config

## Decisions Made
- API key patterns applied before env_variable pattern to prevent double-matching; env_variable uses negative lookahead `(?!\[REDACTED:)` to skip already-redacted values
- Write/Edit tools unconditionally admitted via HIGH_SIGNAL_TOOLS set -- content pattern matching only applies to Bash/Read output (per research pitfall #3)
- Laminark self-referential MCP tools (mcp__laminark__*) rejected in admission filter to prevent observing own operations (per research open question #3)
- Privacy patterns cached per-process with `_resetPatternCache()` escape hatch for testing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed env_variable pattern re-matching redacted values**
- **Found during:** Task 2 (Privacy Filter)
- **Issue:** When content like `API_KEY=sk-abc123...` was processed, the api_key pattern correctly redacted the value to `[REDACTED:api_key]`, but the subsequent env_variable pattern re-matched the redacted value `[REDACTED:api_key]` (which is 8+ chars) and overwrote it with `[REDACTED:env]`
- **Fix:** Added negative lookahead `(?!\[REDACTED:)` to env_variable regex so it skips values starting with `[REDACTED:`
- **Files modified:** src/hooks/privacy-filter.ts
- **Verification:** Multiple-patterns test now passes
- **Committed in:** fd4bfa2 (Task 2 GREEN commit)

**2. [Rule 1 - Bug] Fixed LINTER_WARNING consecutive warning regex**
- **Found during:** Task 1 (Admission Filter)
- **Issue:** The consecutive warning detection regex required trailing `\n` on every line, but the last line in a string often lacks a trailing newline
- **Fix:** Changed `\n` to `[\n]?` in the repetition group to make trailing newline optional
- **Files modified:** src/hooks/noise-patterns.ts
- **Verification:** All eslint-related linter warning tests pass
- **Committed in:** d1f5ad7 (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the two auto-fixed bugs documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Admission filter and privacy filter are pure functions ready for integration into hook handler pipeline (03-03)
- Both modules export clean interfaces: `shouldAdmit()`, `redactSensitiveContent()`, `isExcludedFile()`
- No blockers for remaining Phase 3 work

## Self-Check: PASSED

All 5 created files verified on disk. All 4 commit hashes verified in git log.

---
*Phase: 03-hook-integration-and-capture*
*Completed: 2026-02-08*
