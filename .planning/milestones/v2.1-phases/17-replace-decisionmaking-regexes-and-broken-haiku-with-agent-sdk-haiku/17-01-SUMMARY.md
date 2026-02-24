---
phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku
plan: 01
subsystem: intelligence
tags: [anthropic-sdk, haiku, llm, entity-extraction, relationship-inference, classification, zod]

requires:
  - phase: 07-knowledge-graph-and-advanced-intelligence
    provides: "Entity/relationship type taxonomy (graph/types.ts) and graph infrastructure"
provides:
  - "@anthropic-ai/sdk installed for direct Haiku API calls"
  - "Haiku API key configuration with 3-tier resolution"
  - "Shared Haiku client singleton with callHaiku helper"
  - "Entity extraction agent (6 entity types)"
  - "Relationship inference agent (8 relationship types)"
  - "Combined noise/signal + observation classification agent"
affects: [17-02, 17-03, haiku-processor, entity-extractor, relationship-detector, signal-classifier, observation-classifier]

tech-stack:
  added: ["@anthropic-ai/sdk@0.74.0"]
  patterns: ["Focused Haiku agent with Zod-validated structured output", "Singleton client with graceful degradation", "Defensive JSON extraction from LLM responses"]

key-files:
  created:
    - src/config/haiku-config.ts
    - src/intelligence/haiku-client.ts
    - src/intelligence/haiku-entity-agent.ts
    - src/intelligence/haiku-relationship-agent.ts
    - src/intelligence/haiku-classifier-agent.ts
  modified:
    - package.json

key-decisions:
  - "Used @anthropic-ai/sdk (not claude-agent-sdk) for simple Messages API calls"
  - "Combined noise/signal + observation classification into one Haiku call (one concern, cheaper)"
  - "Defensive JSON extractor strips markdown fences and finds JSON arrays/objects in response text"

patterns-established:
  - "Haiku agent pattern: focused system prompt + callHaiku + extractJsonFromResponse + Zod validation"
  - "API key resolution: LAMINARK_API_KEY env > config.json apiKey > graceful disabled"

duration: 2min
completed: 2026-02-14
---

# Phase 17 Plan 01: Haiku Intelligence Foundation Summary

**Anthropic SDK with shared client singleton, API key config, and three focused Haiku agents for entity extraction, relationship inference, and observation classification**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-14T06:50:50Z
- **Completed:** 2026-02-14T06:53:08Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Installed @anthropic-ai/sdk v0.74.0 for direct Haiku API calls via Messages API
- Created 3-tier API key configuration following existing LAMINARK_DEBUG/LAMINARK_DATA_DIR patterns
- Built shared Haiku client with singleton pattern and defensive JSON response extraction
- Implemented three focused agent modules: entity extraction (6 types), relationship inference (8 types), and combined noise/signal + observation classification

## Task Commits

Each task was committed atomically:

1. **Task 1: Install SDK and create API key config + Haiku client** - `ce4b138` (feat)
2. **Task 2: Create all three Haiku agent modules** - `bbde774` (feat)

## Files Created/Modified
- `package.json` - Added @anthropic-ai/sdk dependency
- `src/config/haiku-config.ts` - API key loading with env var > config.json > disabled resolution
- `src/intelligence/haiku-client.ts` - Singleton Anthropic client, callHaiku, extractJsonFromResponse, isHaikuEnabled, resetHaikuClient
- `src/intelligence/haiku-entity-agent.ts` - Entity extraction agent with Zod-validated output
- `src/intelligence/haiku-relationship-agent.ts` - Relationship inference agent with entity context
- `src/intelligence/haiku-classifier-agent.ts` - Combined noise/signal and discovery/problem/solution classifier

## Decisions Made
- Used `@anthropic-ai/sdk` (standard SDK) instead of `@anthropic-ai/claude-agent-sdk` -- the standard SDK provides `messages.create()` which is all we need; the agent SDK adds Claude Code capabilities (file editing, command execution) that are unnecessary overhead
- Combined noise/signal classification and observation kind classification into a single Haiku call -- these are one concern (classification) that was historically split across two systems for legacy reasons
- Defensive JSON extraction handles markdown fences and surrounding text -- Haiku sometimes wraps JSON in code blocks despite explicit instructions

## Deviations from Plan

None - plan executed exactly as written.

## User Setup Required

**External service requires manual configuration.** Users must configure a Laminark API key:

1. Visit console.anthropic.com -> API Keys -> Create Key
2. Set `LAMINARK_API_KEY` environment variable in shell profile, OR
3. Add `"apiKey": "sk-ant-..."` to `~/.claude/plugins/cache/laminark/data/config.json`

Without an API key, Laminark functions normally but skips Haiku enrichment (graceful degradation).

## Next Phase Readiness
- All agent modules are standalone and ready for Plan 02 to wire into the existing processing pipeline
- Plan 02 will create the HaikuProcessor background orchestrator and modify handler/admission logic
- No blockers

## Self-Check: PASSED

All 5 created files verified on disk. Both task commits (ce4b138, bbde774) verified in git log.

---
*Phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku*
*Completed: 2026-02-14*
