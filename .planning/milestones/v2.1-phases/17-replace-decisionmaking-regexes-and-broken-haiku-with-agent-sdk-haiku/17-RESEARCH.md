# Phase 17: Replace Decisionmaking Regexes and Broken Haiku with Agent-SDK Haiku - Research

**Researched:** 2026-02-13
**Domain:** LLM-based observation analysis replacing regex pattern matching
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Replace ALL entity extraction with Haiku (including file paths, URLs, decisions, problems, solutions, projects) -- not just the fuzzy ones
- Replace relationship detection (modifies, caused_by, solved_by, etc.) with Haiku inference
- Replace signal classification (observation importance scoring) with Haiku
- Replace noise filtering (build output, linter spam, etc.) with Haiku
- Keep tool routing heuristics (heuristic-fallback.ts) as-is -- different domain, works fine
- Each concern gets its own separate Haiku agent/call -- not a single mega-pass. Entity extraction, relationship inference, signal classification, and noise filtering are separate agents that each do one thing well
- Use `@anthropic-ai/agent-sdk` as new dependency for direct Haiku API calls (NOTE: research indicates `@anthropic-ai/sdk` is the correct package for direct Messages API calls -- see Standard Stack section)
- Laminark requires its own separate API key configuration -- not sharing ANTHROPIC_API_KEY from Claude Code environment
- Haiku-only processing -- no local pre-analysis pass. Queue everything for Haiku agents
- Processing is async/background -- hooks return immediately, Haiku enrichment happens after
- No fallback to regexes needed: if Anthropic is down, Claude Code itself isn't running, so no hooks fire
- Replace MCP sampling (createMessage) with direct agent-sdk Haiku calls
- Process observations individually (one per Haiku call), not batched
- Remove the 5-minute auto-promote fallback
- Keep store-then-soft-delete for noise -- observations are stored first, classified by Haiku, then noise is soft-deleted

### Claude's Discretion

No discretion areas specified -- all decisions locked.

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within phase scope.
</user_constraints>

## Summary

This phase replaces five distinct regex/heuristic-based analysis systems and one broken MCP sampling classifier with direct Haiku API calls via the Anthropic SDK. The current system uses ~30 regex patterns across `extraction-rules.ts`, `relationship-detector.ts`, `signal-classifier.ts`, `noise-patterns.ts`, and `admission-filter.ts`, plus a non-functional `ObservationClassifier` that tries to call `mcpServer.server.createMessage()` (which Claude Code does not support from plugins).

The replacement architecture uses 4 separate Haiku agents, each doing one job well: (1) entity extraction, (2) relationship inference, (3) signal/noise classification, and (4) observation classification. Each agent gets its own focused prompt and structured output schema. Observations are stored immediately by hooks (unchanged), then a background processor sends them to Haiku agents for enrichment asynchronously.

**Primary recommendation:** Use `@anthropic-ai/sdk` (the standard Anthropic TypeScript SDK, v0.74.x) for direct `client.messages.create()` calls with model `claude-haiku-4-5-20251001`. Create a shared Anthropic client singleton in a new `src/intelligence/haiku-client.ts`, then implement 4 focused agent modules that each call Haiku with structured output prompts.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | ^0.74.0 | Direct Haiku API calls via Messages API | Official Anthropic TypeScript SDK. Provides `client.messages.create()` -- the simplest, most direct way to call Haiku. The user specified "agent-sdk" but the standard SDK is what provides direct model calls; the `claude-agent-sdk` is for building autonomous agents with Claude Code capabilities, which is overkill for structured extraction calls. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4.3.6 (already installed) | Validate Haiku JSON responses | Parse and validate structured output from Haiku before database writes |

### Why NOT `@anthropic-ai/claude-agent-sdk`

The `@anthropic-ai/claude-agent-sdk` (v0.2.42) is designed for building autonomous agents with Claude Code's capabilities (file editing, command execution, codebase understanding). Laminark needs simple, focused API calls to Haiku for text analysis -- `messages.create()` with a prompt and structured output. The standard `@anthropic-ai/sdk` provides exactly this with no unnecessary overhead.

If the user specifically wants `claude-agent-sdk` despite this, the standard SDK's `messages.create()` API is the correct primitive either way -- the agent SDK wraps it.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@anthropic-ai/sdk` | `@anthropic-ai/claude-agent-sdk` | Agent SDK adds Claude Code capabilities (file editing, command execution) we don't need; adds ~15MB dependency; overkill for structured extraction |
| Individual Haiku calls | Batched multi-observation calls | User explicitly decided individual calls -- simpler, more fault-tolerant, easier to parallelize |

**Installation:**
```bash
npm install @anthropic-ai/sdk
```

## Architecture Patterns

### Current Architecture (What We Replace)

The current pipeline has two paths that both need replacement:

**Path 1: Hook Handler -> Observation Storage (synchronous, fast)**
```
Hook fires -> handler.ts -> admission-filter.ts (noise-patterns.ts regexes)
           -> privacy-filter.ts -> save-guard.ts -> obsRepo.create()
```
This path stays mostly unchanged. The admission filter currently uses `noise-patterns.ts` regexes to reject noise before storage. Under the new architecture, ALL observations are stored (no pre-filtering by noise regexes), then Haiku classifies and soft-deletes noise after.

**Path 2: Background Embedding Loop -> Graph Extraction (async, in MCP server)**
```
embedTimer (index.ts:130-300) -> classifySignal() -> extractAndPersist()
                               -> detectAndPersist()
```
This path uses `signal-classifier.ts` (regex-based) to gate extraction, then `extraction-rules.ts` (6 regex rules) for entities, and `relationship-detector.ts` (regex-based context signals + type-pair defaults) for relationships.

**Path 3: Background ObservationClassifier (broken, async)**
```
classifier.start() -> runOnce() -> mcpServer.server.createMessage() -> FAILS
                   -> 5-min fallback auto-promotes as "discovery"
```

### New Architecture

```
src/
  intelligence/
    haiku-client.ts           # Shared Anthropic client singleton + config
    haiku-entity-agent.ts     # Entity extraction agent (replaces extraction-rules.ts)
    haiku-relationship-agent.ts  # Relationship inference (replaces relationship-detector.ts)
    haiku-classifier-agent.ts    # Signal + noise + observation classification (replaces signal-classifier.ts, noise-patterns.ts, observation-classifier.ts)
    haiku-processor.ts        # Background processor that orchestrates agents
  config/
    haiku-config.ts           # API key configuration (LAMINARK_API_KEY env var + config.json)
```

### Pattern 1: Shared Haiku Client Singleton

**What:** Single Anthropic SDK client instance, initialized once with Laminark's own API key.
**When to use:** Every Haiku call goes through this client.
**Example:**
```typescript
// Source: @anthropic-ai/sdk README (https://github.com/anthropics/anthropic-sdk-typescript)
import Anthropic from '@anthropic-ai/sdk';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let _client: Anthropic | null = null;

export function getHaikuClient(): Anthropic | null {
  if (_client) return _client;

  const apiKey = loadApiKey(); // LAMINARK_API_KEY env or config.json
  if (!apiKey) return null; // Graceful degradation -- no API key, no enrichment

  _client = new Anthropic({ apiKey });
  return _client;
}

export async function callHaiku(
  systemPrompt: string,
  userContent: string,
  maxTokens: number = 1024,
): Promise<string> {
  const client = getHaikuClient();
  if (!client) throw new Error('Haiku client not configured');

  const message = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  // Extract text from response
  const textBlock = message.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}
```

### Pattern 2: Focused Agent with Structured Output

**What:** Each agent has a focused system prompt and returns structured JSON.
**When to use:** All 4 agent types follow this pattern.
**Example:**
```typescript
// Entity extraction agent
const ENTITY_SYSTEM_PROMPT = `You are an entity extractor for a developer knowledge graph.
Given an observation from a coding session, extract ALL entities present.

Entity types (ONLY these):
- File: file paths (e.g., src/auth/login.ts, package.json)
- Project: repository or package names (e.g., facebook/react, @anthropic-ai/sdk)
- Reference: URLs
- Decision: choices made (e.g., "use JWT instead of sessions")
- Problem: bugs, errors, obstacles
- Solution: fixes, resolutions, workarounds

Return a JSON array. Each entity: {"name": "...", "type": "...", "confidence": 0.0-1.0}
Return [] if no entities found. No explanatory text, ONLY the JSON array.`;

export async function extractEntitiesWithHaiku(
  observationText: string,
): Promise<Array<{ name: string; type: EntityType; confidence: number }>> {
  const response = await callHaiku(ENTITY_SYSTEM_PROMPT, observationText, 512);
  const parsed = JSON.parse(response);
  // Validate with Zod schema
  return EntityArraySchema.parse(parsed);
}
```

### Pattern 3: Background Processor Queue

**What:** Background loop that picks up unprocessed observations and runs them through Haiku agents.
**When to use:** Replaces both the embedding loop's graph extraction AND the broken ObservationClassifier.
**Example:**
```typescript
// Runs on a timer (similar to existing embedTimer in index.ts)
export class HaikuProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;

  async processOne(obs: Observation): Promise<void> {
    // 1. Noise classification first (cheapest, filters most)
    const classification = await classifyWithHaiku(obs);
    obsRepo.updateClassification(obs.id, classification.classification);
    if (classification.classification === 'noise') {
      obsRepo.softDelete(obs.id);
      return; // No graph extraction for noise
    }

    // 2. Entity extraction
    const entities = await extractEntitiesWithHaiku(obs.content);
    for (const entity of entities) {
      upsertNode(db, { type: entity.type, name: entity.name, ... });
    }

    // 3. Relationship inference (only if enough entities)
    if (entities.length >= 2) {
      const relationships = await inferRelationshipsWithHaiku(obs.content, entities);
      for (const rel of relationships) { ... }
    }
  }
}
```

### Anti-Patterns to Avoid
- **Single mega-prompt:** Do NOT combine entity extraction, relationship inference, and classification into one Haiku call. User explicitly decided separate agents for each concern.
- **Regex fallback:** Do NOT keep regexes as fallback. If Anthropic is down, Claude Code itself is not running, so no hooks fire. No fallback needed.
- **Blocking hooks:** Haiku calls must NEVER block hook processing. Hooks store observations synchronously; Haiku enrichment is fully async/background.
- **Sharing ANTHROPIC_API_KEY:** Laminark must use its own API key, not the one from Claude Code's environment. This is a locked decision.

## Files to Modify/Remove

### Files to REMOVE (regex-based, fully replaced by Haiku)
| File | Current Purpose | Replaced By |
|------|----------------|-------------|
| `src/graph/extraction-rules.ts` | 6 regex rules for entity extraction | `haiku-entity-agent.ts` |
| `src/curation/observation-classifier.ts` | Broken MCP sampling classifier | `haiku-classifier-agent.ts` |

### Files to MODIFY
| File | Current | Change |
|------|---------|--------|
| `src/graph/entity-extractor.ts` | Runs regex rules, deduplicates, persists | Replace `extractEntities()` internals to call Haiku agent; keep `extractAndPersist()` persistence logic |
| `src/graph/relationship-detector.ts` | Regex context signals + type-pair defaults | Replace `detectRelationships()` to call Haiku agent; keep `detectAndPersist()` persistence logic |
| `src/graph/signal-classifier.ts` | Regex-based source + content boost classification | Replace with Haiku-based classification; or fold into the classifier agent |
| `src/hooks/noise-patterns.ts` | Regex noise patterns for admission filter | Remove noise regex filtering from admission; Haiku classifies noise post-storage |
| `src/hooks/admission-filter.ts` | Uses `isNoise()` from noise-patterns.ts | Remove noise pattern check; keep other filters (empty, length, bash navigation) |
| `src/index.ts` | Wires embedTimer graph extraction + broken classifier | Replace graph extraction in embed loop with HaikuProcessor; remove ObservationClassifier instantiation |
| `src/shared/config.ts` | Config loader | Add `LAMINARK_API_KEY` env var support |

### Files to CREATE
| File | Purpose |
|------|---------|
| `src/intelligence/haiku-client.ts` | Shared Anthropic client, API key config, `callHaiku()` helper |
| `src/intelligence/haiku-entity-agent.ts` | Entity extraction via Haiku |
| `src/intelligence/haiku-relationship-agent.ts` | Relationship inference via Haiku |
| `src/intelligence/haiku-classifier-agent.ts` | Combined noise + observation classification via Haiku |
| `src/intelligence/haiku-processor.ts` | Background orchestrator that drives all agents |
| `src/config/haiku-config.ts` | API key loading from env var and config.json |

### Files UNCHANGED (explicitly out of scope)
- `src/routing/heuristic-fallback.ts` -- works fine, different domain
- `src/graph/write-quality-gate.ts` -- still useful post-Haiku (name length, vague name filtering)
- `src/graph/curation-agent.ts` -- graph maintenance, not extraction
- `src/graph/types.ts` -- entity/relationship types stay the same
- `src/graph/schema.ts` -- persistence layer stays the same

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Anthropic API client | Custom HTTP client for Haiku | `@anthropic-ai/sdk` `messages.create()` | Handles auth, retries, streaming, error types, rate limiting |
| JSON response parsing | Custom JSON extractors | `JSON.parse()` + Zod validation | Haiku is instructed to return pure JSON; validate with existing Zod |
| Rate limiting | Custom rate limiter | SDK built-in retry + simple concurrency limit | SDK handles 429s with exponential backoff |
| API key storage | Custom key management | Env var (`LAMINARK_API_KEY`) + config.json fallback | Same pattern as `LAMINARK_DEBUG` and `LAMINARK_DATA_DIR` |

**Key insight:** The Anthropic SDK handles all transport-level concerns (auth, retries, error classification). The implementation work is in the prompts, response validation, and wiring -- not in HTTP mechanics.

## Common Pitfalls

### Pitfall 1: Haiku JSON Response Unreliability
**What goes wrong:** Haiku sometimes wraps JSON in markdown code fences, adds explanatory text before/after, or returns malformed JSON.
**Why it happens:** Even with explicit "return ONLY JSON" instructions, LLMs occasionally deviate.
**How to avoid:** Strip markdown fences and surrounding text before parsing. Use a defensive extraction pattern: find the first `[` or `{` and last `]` or `}`, extract that substring. Validate with Zod after parsing. The existing `ObservationClassifier.parseResponse()` already does this (regex to find `\[[\s\S]*\]`).
**Warning signs:** JSON parse errors in logs during testing.

### Pitfall 2: API Key Not Available at Startup
**What goes wrong:** Laminark starts before the user has configured an API key. All Haiku calls fail, no enrichment happens.
**Why it happens:** Laminark is a plugin that starts automatically. API key requires user action.
**How to avoid:** Graceful degradation. If no API key, observations are stored but not enriched. Log a debug message. The `status` MCP tool should report whether Haiku is configured. Consider adding a one-time notification via NotificationStore.
**Warning signs:** All observations remain unclassified; no graph entities being created.

### Pitfall 3: Cost Runaway with Per-Observation Haiku Calls
**What goes wrong:** High-activity sessions generate hundreds of observations, each triggering 3-4 Haiku calls. Cost accumulates.
**Why it happens:** User decided individual processing (not batched), and 4 separate agents per observation.
**How to avoid:** Haiku is cheap (~$0.80/MTok input, ~$4/MTok output for claude-haiku-4-5). A typical observation is 100-500 tokens. At 4 calls/observation and ~500 tokens each, that's ~2000 tokens/observation. At 100 observations/session, that's ~200K tokens = ~$0.16/session input + ~$0.80/session output = ~$1/session. Still cheap, but monitor. Add a configurable per-session call cap as a safety valve.
**Warning signs:** API bill spikes, high token counts in debug logs.

### Pitfall 4: Blocking the Embedding Loop
**What goes wrong:** Haiku calls in the embedding loop block embedding processing, causing observation backlog.
**Why it happens:** Haiku calls take 100-500ms each. If wired inline in the embed loop, they serialize.
**How to avoid:** Run Haiku processing on a separate timer/loop from the embedding loop. The embedding loop processes observations for vector embeddings; the Haiku processor handles classification and graph extraction independently. They can run concurrently since they operate on different fields.
**Warning signs:** Embedding backlog growing, observations waiting longer for embeddings.

### Pitfall 5: Haiku Hallucinating Entities
**What goes wrong:** Haiku invents entities not present in the text, or misclassifies entity types.
**Why it happens:** LLMs can be creative with extraction, especially for fuzzy categories like "Decision" or "Problem."
**How to avoid:** Keep the write-quality-gate.ts as a post-Haiku filter. Validate entity names appear in the source text (for File, Reference, Project types). Set reasonable confidence thresholds. Log rejected entities for prompt tuning.
**Warning signs:** Graph nodes with names not found in any observation text.

### Pitfall 6: Breaking Existing Tests
**What goes wrong:** The codebase has extensive tests for regex-based extraction (entity-extractor.test.ts, relationship-detector.test.ts, signal-classifier.test.ts, observation-classifier.test.ts). All will need rewriting.
**Why it happens:** Tests are tightly coupled to regex behavior (specific matches, span positions, confidence scores).
**How to avoid:** Plan test rewrites as separate tasks. New tests should mock the Haiku client (mock `callHaiku()`) and test the agent logic independently. Integration tests can use fixture responses.
**Warning signs:** Test suite failures during implementation.

## Code Examples

### Example 1: API Key Configuration
```typescript
// src/config/haiku-config.ts
// Pattern follows existing LAMINARK_DEBUG / LAMINARK_DATA_DIR conventions

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../shared/config.js';
import { debug } from '../shared/debug.js';

export interface HaikuConfig {
  apiKey: string | null;
  model: string;
  maxTokensPerCall: number;
  enabled: boolean;
}

export function loadHaikuConfig(): HaikuConfig {
  // Priority: env var > config.json > disabled
  const envKey = process.env.LAMINARK_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      model: 'claude-haiku-4-5-20251001',
      maxTokensPerCall: 1024,
      enabled: true,
    };
  }

  // Check config.json
  try {
    const configPath = join(getConfigDir(), 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config.apiKey === 'string' && config.apiKey.length > 0) {
      return {
        apiKey: config.apiKey,
        model: (config.haikuModel as string) ?? 'claude-haiku-4-5-20251001',
        maxTokensPerCall: 1024,
        enabled: true,
      };
    }
  } catch {
    // Config file doesn't exist or is invalid
  }

  debug('config', 'No Laminark API key found -- Haiku enrichment disabled');
  return { apiKey: null, model: 'claude-haiku-4-5-20251001', maxTokensPerCall: 1024, enabled: false };
}
```

### Example 2: Haiku Client with Defensive Response Parsing
```typescript
// Source: @anthropic-ai/sdk (https://github.com/anthropics/anthropic-sdk-typescript)
import Anthropic from '@anthropic-ai/sdk';
import { loadHaikuConfig } from '../config/haiku-config.js';
import { debug } from '../shared/debug.js';

let _client: Anthropic | null = null;
let _config: ReturnType<typeof loadHaikuConfig> | null = null;

export function getHaikuClient(): Anthropic | null {
  if (_client) return _client;
  _config = loadHaikuConfig();
  if (!_config.apiKey) return null;
  _client = new Anthropic({ apiKey: _config.apiKey });
  return _client;
}

export async function callHaiku(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
): Promise<string> {
  const client = getHaikuClient();
  if (!client || !_config) throw new Error('Haiku not configured');

  const message = await client.messages.create({
    model: _config.model,
    max_tokens: maxTokens ?? _config.maxTokensPerCall,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = message.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * Defensive JSON extraction from Haiku response.
 * Handles: bare JSON, markdown-fenced JSON, JSON with surrounding text.
 */
export function extractJsonFromResponse(text: string): unknown {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Try to find JSON array
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) return JSON.parse(arrayMatch[0]);

  // Try to find JSON object
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) return JSON.parse(objMatch[0]);

  throw new Error('No JSON found in Haiku response');
}
```

### Example 3: Entity Extraction Agent
```typescript
// src/intelligence/haiku-entity-agent.ts
import { z } from 'zod';
import { ENTITY_TYPES, type EntityType } from '../graph/types.js';
import { callHaiku, extractJsonFromResponse } from './haiku-client.js';

const EntitySchema = z.object({
  name: z.string().min(1),
  type: z.enum(ENTITY_TYPES),
  confidence: z.number().min(0).max(1),
});
const EntityArraySchema = z.array(EntitySchema);

const SYSTEM_PROMPT = `You extract structured entities from developer observations.

Entity types (use ONLY these exact strings):
- File: file paths (src/foo/bar.ts, package.json, ./config.yml)
- Project: repository names (org/repo), npm packages (@scope/pkg)
- Reference: URLs (https://...)
- Decision: explicit choices made ("decided to use X", "chose Y over Z")
- Problem: bugs, errors, failures, obstacles encountered
- Solution: fixes, resolutions, workarounds applied

Rules:
- Extract ALL entities present in the text
- For Decision/Problem/Solution, extract the descriptive phrase (not just the keyword)
- Confidence: 0.9+ for unambiguous (file paths, URLs), 0.7-0.8 for clear context, 0.5-0.6 for inferred
- Return a JSON array: [{"name": "...", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no entities found
- No markdown, no explanation, ONLY the JSON array`;

export async function extractEntities(
  text: string,
): Promise<Array<{ name: string; type: EntityType; confidence: number }>> {
  const response = await callHaiku(SYSTEM_PROMPT, text, 512);
  const parsed = extractJsonFromResponse(response);
  return EntityArraySchema.parse(parsed);
}
```

### Example 4: Relationship Inference Agent
```typescript
// src/intelligence/haiku-relationship-agent.ts
import { z } from 'zod';
import { RELATIONSHIP_TYPES, type RelationshipType, type EntityType } from '../graph/types.js';

const SYSTEM_PROMPT = `You infer relationships between entities extracted from a developer observation.

Given observation text and a list of entities, determine which entities are related and how.

Relationship types (use ONLY these exact strings):
- modifies: entity A changed/edited/created entity B
- informed_by: entity A was researched/consulted using entity B
- verified_by: entity A was tested/confirmed by entity B
- caused_by: entity A was caused by entity B
- solved_by: entity A was resolved by entity B
- references: entity A references/links to entity B
- preceded_by: entity A came after entity B temporally
- related_to: generic relationship (use sparingly, prefer specific types)

Rules:
- Only infer relationships with clear textual evidence
- Source and target must both be in the provided entity list
- Confidence: 0.8+ for explicit language, 0.5-0.7 for implied
- Return JSON array: [{"source": "name", "target": "name", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no relationships found`;

const RelSchema = z.array(z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(RELATIONSHIP_TYPES),
  confidence: z.number().min(0).max(1),
}));
```

### Example 5: Unified Classification Agent (noise + observation kind)
```typescript
// src/intelligence/haiku-classifier-agent.ts
// Combines noise filtering and observation classification in one call
// (two questions, one Haiku call -- cheaper than two separate calls)

const SYSTEM_PROMPT = `You classify developer observations for a knowledge management system.

For each observation, determine:
1. signal: Is this noise or signal?
   - "noise": build output, linter spam, package install logs, empty/trivial content, routine navigation
   - "signal": meaningful findings, decisions, problems, solutions, reference material

2. classification (only if signal): What kind of observation is this?
   - "discovery": new understanding, finding, or insight
   - "problem": error, bug, failure, or obstacle
   - "solution": fix, resolution, workaround, or decision that resolved something

Return JSON: {"signal": "noise"|"signal", "classification": "discovery"|"problem"|"solution"|null, "reason": "..."}
If noise, classification should be null.`;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MCP sampling (`server.createMessage()`) | Direct API calls via `@anthropic-ai/sdk` | Claude Code never supported createMessage from plugins | Current classifier is completely non-functional |
| Claude 3 Haiku (2024) | Claude Haiku 4.5 (Oct 2025) | Oct 2025 | Better coding performance, faster, same cost tier |
| Regex entity extraction | LLM-based extraction | This phase | Handles ambiguity, context, multi-language |
| `@anthropic-ai/sdk` was at ~v0.30 | Now at v0.74.0 | Ongoing | More stable, better TypeScript types |

**Deprecated/outdated:**
- `mcpServer.server.createMessage()`: Never worked in Claude Code plugin context. Must be replaced.
- Claude 3 Haiku (`claude-3-haiku-20240307`): Superseded by Claude Haiku 4.5 (`claude-haiku-4-5-20251001`).
- The 5-minute auto-promote fallback in `ObservationClassifier`: Workaround for broken classifier. Remove entirely.

## API Key Configuration Design

Laminark needs its own API key, separate from Claude Code's `ANTHROPIC_API_KEY`. The configuration follows existing Laminark patterns:

**Resolution order (mirrors `LAMINARK_DEBUG` pattern):**
1. `LAMINARK_API_KEY` environment variable (highest priority)
2. `~/.claude/plugins/cache/laminark/data/config.json` field `apiKey`
3. Not configured (graceful degradation -- no enrichment)

**User sets it via:**
- `export LAMINARK_API_KEY=sk-ant-...` in shell profile, OR
- Add `"apiKey": "sk-ant-..."` to `~/.claude/plugins/cache/laminark/data/config.json`

**Graceful degradation:** When no API key is configured, Laminark functions normally for storage/retrieval but skips Haiku enrichment entirely. Observations are stored without classification or graph extraction. The `status` tool reports whether Haiku is enabled.

## Observation Processing Flow (New)

```
Hook fires
  -> handler.ts stores observation (UNCHANGED, fast, sync)
  -> observation sits in DB with classification=NULL

HaikuProcessor timer fires (every ~30s)
  -> queries observations WHERE classification IS NULL
  -> for each observation:
     1. callHaiku(classifier) -> noise? soft-delete and done
     2. callHaiku(entity-extractor) -> upsert graph nodes
     3. callHaiku(relationship-agent) -> insert graph edges (if 2+ entities)
     4. mark observation as classified

No embedding loop changes needed -- embedding and Haiku processing are independent.
```

## Concurrency and Performance

- **Haiku latency:** ~100-300ms per call (Haiku 4.5 is optimized for speed)
- **Calls per observation:** 2-3 (classifier + entity extraction + optional relationship inference)
- **Sequential per observation:** Classifier must complete before entity extraction (noise skips extraction)
- **Parallel across observations:** Can process multiple observations concurrently with `Promise.all()` (limit concurrency to 3-5 to avoid rate limits)
- **Timer interval:** ~30 seconds (similar to existing embed loop)
- **Batch size:** Process up to 10 observations per cycle

## Open Questions

1. **Combine signal + noise + observation classification into one agent or keep separate?**
   - What we know: User said "each concern gets its own separate Haiku agent/call." Signal classification, noise filtering, and observation classification are conceptually related (all answer "is this worth keeping, and what kind is it?").
   - What's unclear: Whether "noise filtering" and "observation classification" are one concern or two in the user's mental model. They were separate systems (hooks vs. background) but serve the same purpose.
   - Recommendation: Implement as ONE classifier agent that answers both questions in a single call. It returns `{signal: "noise"|"signal", classification: ...}`. This is one concern (classification), just currently split across two systems for historical reasons. Entity extraction and relationship inference remain separate agents as decided.

2. **What happens to `admission-filter.ts` noise checks?**
   - What we know: Currently, `shouldAdmit()` uses `isNoise()` from `noise-patterns.ts` to reject noise BEFORE storage. The new design stores everything first, then Haiku classifies noise post-storage.
   - What's unclear: Should we remove ALL admission filter logic, or keep the non-noise parts (empty content, bash navigation, long content without indicators)?
   - Recommendation: Keep the cheap, obvious filters (empty content, bash navigation commands) in the admission filter as pre-storage gates. These are deterministic, zero-cost, and don't need LLM judgment. Remove only the `isNoise()` call -- that's the regex-based filtering Haiku replaces.

3. **Should `write-quality-gate.ts` stay as a post-Haiku filter?**
   - What we know: It filters by name length, vague prefixes, per-type confidence thresholds, and file caps. Haiku will set its own confidence scores.
   - What's unclear: Whether Haiku's confidence calibration will match the current thresholds.
   - Recommendation: Keep it initially as a safety net. Haiku confidence thresholds may need recalibration. The vague-name and length filters remain useful regardless of source.

## Sources

### Primary (HIGH confidence)
- `@anthropic-ai/sdk` GitHub README (https://github.com/anthropics/anthropic-sdk-typescript) -- SDK API patterns, `messages.create()` usage
- Anthropic Claude Haiku 4.5 announcement (https://www.anthropic.com/news/claude-haiku-4-5) -- model ID `claude-haiku-4-5-20251001`
- Codebase analysis: `src/graph/extraction-rules.ts`, `src/graph/entity-extractor.ts`, `src/graph/relationship-detector.ts`, `src/graph/signal-classifier.ts`, `src/curation/observation-classifier.ts`, `src/hooks/noise-patterns.ts`, `src/hooks/admission-filter.ts`, `src/hooks/handler.ts`, `src/index.ts`

### Secondary (MEDIUM confidence)
- `@anthropic-ai/claude-agent-sdk` GitHub (https://github.com/anthropics/claude-agent-sdk-typescript) -- confirmed it's for autonomous agents, NOT simple API calls
- Claude Haiku 4.5 pricing from third-party docs (https://docs.aimlapi.com/api-references/text-models-llm/anthropic/claude-4.5-haiku) -- approximate pricing

### Tertiary (LOW confidence)
- Exact `@anthropic-ai/sdk` version 0.74.0 -- from web search, may have updated since. Verify with `npm info @anthropic-ai/sdk version` at implementation time.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- `@anthropic-ai/sdk` is the official, well-documented Anthropic TypeScript SDK
- Architecture: HIGH -- follows existing Laminark patterns (background processors, config loading, graceful degradation)
- Pitfalls: HIGH -- identified from codebase analysis and LLM integration experience
- Haiku model ID: HIGH -- `claude-haiku-4-5-20251001` confirmed from multiple sources
- Pricing estimates: MEDIUM -- based on third-party documentation, may vary

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (stable domain, SDK and model IDs may update)
