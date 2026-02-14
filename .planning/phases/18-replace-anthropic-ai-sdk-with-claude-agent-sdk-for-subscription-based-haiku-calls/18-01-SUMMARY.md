---
phase: 18-replace-anthropic-ai-sdk-with-claude-agent-sdk-for-subscription-based-haiku-calls
plan: 01
subsystem: intelligence
tags: [claude-agent-sdk, haiku, v2-session, subscription-auth]

# Dependency graph
requires:
  - phase: 17-haiku-intelligence
    provides: "callHaiku contract, haiku-client.ts, haiku-config.ts, agent modules"
provides:
  - "callHaiku via Agent SDK V2 session (subscription auth, no API key)"
  - "isHaikuEnabled always true (no API key check)"
  - "Simplified HaikuConfig without apiKey/enabled fields"
  - "@anthropic-ai/claude-agent-sdk dependency"
affects: [18-02-test-updates]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/claude-agent-sdk ^0.2.42"]
  removed: ["@anthropic-ai/sdk ^0.74.0"]
  patterns: ["V2 session singleton with auto-recovery on expiration", "System prompt embedded in user message for multi-agent session reuse"]

key-files:
  modified:
    - "package.json"
    - "src/config/haiku-config.ts"
    - "src/intelligence/haiku-client.ts"

key-decisions:
  - "Used V2 session API (unstable_v2_createSession) over V1 query() to avoid 12s cold-start per call"
  - "Embedded system prompts in user messages rather than creating separate sessions per agent type"
  - "SDKSessionOptions model takes full model ID string, not short name (AgentDefinition short names are separate)"
  - "permissionMode bypassPermissions with allowedTools:[] for pure text completion"
  - "isHaikuEnabled() always returns true -- let errors propagate naturally rather than pre-checking auth"

patterns-established:
  - "V2 session singleton: lazy creation, auto-recovery on close/expiration errors"
  - "System prompt embedding: <instructions> tags wrap system prompt in user message"

# Metrics
duration: 2min
completed: 2026-02-14
---

# Phase 18 Plan 01: SDK Dependency Swap and Client Rewrite Summary

**Haiku calls routed through Claude Agent SDK V2 session using subscription auth instead of separate API key**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-14T16:31:58Z
- **Completed:** 2026-02-14T16:34:05Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Replaced @anthropic-ai/sdk with @anthropic-ai/claude-agent-sdk for subscription-based auth
- Rewrote haiku-client.ts to use V2 session API with persistent session singleton
- Simplified haiku-config.ts to pure model/maxTokens config (removed API key resolution)
- All three agent modules unchanged -- callHaiku contract preserved

## Task Commits

Each task was committed atomically:

1. **Task 1: Swap SDK dependency and simplify config** - `b9545cd` (chore)
2. **Task 2: Rewrite haiku-client.ts to use Agent SDK V2 session** - `d87daa5` (feat)

## Files Created/Modified
- `package.json` - Replaced @anthropic-ai/sdk with @anthropic-ai/claude-agent-sdk ^0.2.42
- `src/config/haiku-config.ts` - Simplified to ~20 lines, no API key resolution, just model+maxTokens
- `src/intelligence/haiku-client.ts` - V2 session singleton, callHaiku via send/stream, isHaikuEnabled always true

## Decisions Made
- Used full model ID string (`claude-haiku-4-5-20251001`) in SDKSessionOptions since `model` is typed as `string` (not the `AgentDefinition` short-name union)
- SDKSessionOptions does not have `maxTurns` or `allowDangerouslySkipPermissions` -- those are V1 Options only. Used `permissionMode: 'bypassPermissions'` and `allowedTools: []` instead
- Removed `getHaikuClient()` export entirely since no external callers exist (only used internally + tests)
- Session close errors ignored in catch block to avoid masking the original error

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed SDKSessionOptions fields to match actual type definitions**
- **Found during:** Task 2
- **Issue:** Plan specified `maxTurns`, `allowDangerouslySkipPermissions`, and `allowedTools: []` on createSession options, but SDKSessionOptions only has `model`, `permissionMode`, `allowedTools`, `disallowedTools` (no maxTurns or allowDangerouslySkipPermissions)
- **Fix:** Used only fields that exist on SDKSessionOptions type
- **Files modified:** src/intelligence/haiku-client.ts
- **Verification:** `npx tsc --noEmit` passes clean
- **Committed in:** d87daa5

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Corrected API surface to match actual SDK types. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. Auth handled by Claude Code subscription.

## Next Phase Readiness
- SDK swap complete, ready for 18-02 (test updates)
- Existing tests in haiku-client.test.ts need rewriting to mock Agent SDK instead of @anthropic-ai/sdk

---
*Phase: 18-replace-anthropic-ai-sdk-with-claude-agent-sdk-for-subscription-based-haiku-calls*
*Completed: 2026-02-14*
