# Phase 18: Replace @anthropic-ai/sdk with Claude Agent SDK - Research

**Researched:** 2026-02-14
**Domain:** Claude Agent SDK migration, subscription-based LLM calls
**Confidence:** HIGH

## Summary

This phase replaces the `@anthropic-ai/sdk` direct API client with `@anthropic-ai/claude-agent-sdk` so that Haiku calls route through the user's Claude Code subscription instead of requiring a separate API key. The migration surface is small: only `haiku-client.ts` directly imports `@anthropic-ai/sdk`, and only three agent modules call `callHaiku()`.

The Agent SDK's `query()` function spawns a Claude Code subprocess per call, which carries ~12 seconds of cold-start overhead. However, the V2 preview API (`unstable_v2_createSession`) keeps a subprocess alive across multiple `send()` calls, reducing subsequent calls to ~2-3 seconds. Since the HaikuProcessor already batches observations and makes 1-3 sequential Haiku calls per observation (classify, extract entities, infer relationships), a session-based approach is the clear choice for acceptable performance.

**Primary recommendation:** Use the V2 session API (`unstable_v2_createSession`) with a persistent session that stays alive across batch processing cycles. Fall back to `unstable_v2_prompt()` only if V2 proves too unstable. The `query()` V1 API with string prompts is unacceptable for this use case due to 12s cold-start per call.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.42` | LLM calls via Claude Code subscription | Official SDK, uses subscription auth, no API key needed |

### Removed
| Library | Version | Purpose | Why Removed |
|---------|---------|---------|-------------|
| `@anthropic-ai/sdk` | `^0.74.0` | Direct Anthropic API client | Requires separate API key and billing |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| V2 session API | V1 `query()` with string prompt | V1 has 12s cold start per call -- unacceptable for 3 sequential calls per observation |
| V2 session API | V1 `query()` with AsyncIterable prompt (streaming input) | Works but complex generator coordination; V2 is cleaner |
| `unstable_v2_prompt()` | `unstable_v2_createSession()` | prompt() is simpler but still 12s per call; session reuse is critical |

**Installation:**
```bash
npm install @anthropic-ai/claude-agent-sdk
npm uninstall @anthropic-ai/sdk
```

## Architecture Patterns

### Current Architecture (What Changes)
```
src/
├── config/
│   └── haiku-config.ts          # SIMPLIFY: remove API key resolution
├── intelligence/
│   ├── haiku-client.ts          # REWRITE: query() -> V2 session
│   ├── haiku-classifier-agent.ts  # NO CHANGE (calls callHaiku)
│   ├── haiku-entity-agent.ts      # NO CHANGE (calls callHaiku)
│   ├── haiku-relationship-agent.ts # NO CHANGE (calls callHaiku)
│   ├── haiku-processor.ts        # MINOR: session lifecycle
│   └── __tests__/
│       ├── haiku-client.test.ts  # REWRITE tests
│       └── haiku-processor.test.ts # UPDATE mocks
```

### Pattern 1: V2 Session-Based Calls
**What:** Keep a Claude Agent SDK session alive across multiple Haiku calls within a processing batch.
**When to use:** Whenever making multiple sequential LLM calls (which is always in HaikuProcessor).

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
import {
  unstable_v2_createSession,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

// Create session once, reuse across calls
const session = unstable_v2_createSession({
  model: 'claude-haiku-4-5-20251001',
});

// Each call: send prompt, collect result
await session.send('Your prompt here');
let resultText = '';
for await (const msg of session.stream()) {
  if (msg.type === 'result' && msg.subtype === 'success') {
    resultText = msg.result;
  }
}

// Clean up when done
session.close();
```

### Pattern 2: callHaiku() Replacement with System Prompt
**What:** The new `callHaiku()` must pass a system prompt and user content, getting back a string.
**When to use:** This is the core replacement pattern.

```typescript
// Source: official docs - query options include systemPrompt
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

let _session: ReturnType<typeof unstable_v2_createSession> | null = null;

function getSession() {
  if (!_session) {
    _session = unstable_v2_createSession({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: undefined, // Set per-call via prompt content
      maxTurns: 1,
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
                         'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
                         'TodoWrite'],
      permissionMode: 'bypassPermissions',
    });
  }
  return _session;
}
```

### Pattern 3: System Prompt Handling
**What:** The V2 session API sets `systemPrompt` at session creation, but our three agents each need different system prompts. Two approaches:

**Option A -- Inline system prompt in user message:**
```typescript
// Embed system prompt as instruction prefix in the user message
const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\nUser content:\n${userContent}`;
await session.send(fullPrompt);
```

**Option B -- One session per call type:**
Create separate sessions for classifier, entity extractor, and relationship inferrer. More overhead but cleaner separation.

**Recommendation:** Option A (inline) since we want to minimize cold starts. The model will follow system-prompt-like instructions in the user message when `maxTurns: 1` and no tools are available.

### Pattern 4: Extracting Text Result
**What:** The SDK returns `SDKMessage` stream; we need the text string.
**When to use:** Every callHaiku replacement.

```typescript
// Source: official docs SDKResultMessage type
async function extractResult(session: Session): Promise<string> {
  let result = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        result = msg.result; // string field on success results
      } else {
        throw new Error(`Haiku call failed: ${msg.subtype} - ${msg.errors?.join(', ')}`);
      }
    }
  }
  return result;
}
```

### Anti-Patterns to Avoid
- **One query() per call (V1 string mode):** 12s overhead per call. Three calls per observation = 36s minimum. Unacceptable.
- **Keeping session alive forever:** Sessions auto-expire after 10 minutes of inactivity. The HaikuProcessor runs on a 30s timer, so sessions should stay warm during active processing but may expire during idle periods. Handle session expiration gracefully.
- **Using Claude Code's full tool suite:** We only need text completion. Disable ALL tools via `disallowedTools` to prevent the model from attempting file reads or bash commands.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Subscription auth | Custom OAuth/token flow | Agent SDK handles it | Uses Claude Code's existing login session |
| Process management | Custom subprocess spawning | Agent SDK V2 sessions | Handles process lifecycle, warm reuse |
| Session expiration | Manual process health checks | Try/catch + recreate session | SDK handles timeouts, we just need to catch errors |

## Common Pitfalls

### Pitfall 1: 12-Second Cold Start
**What goes wrong:** Each `query()` (V1 string mode) spawns a fresh subprocess taking ~12s. With 3 calls per observation, processing becomes unacceptably slow.
**Why it happens:** The SDK spawns a full Claude Code process per call with no reuse.
**How to avoid:** Use V2 session API (`unstable_v2_createSession`). First call ~12s, subsequent ~2-3s.
**Warning signs:** Processing time per observation exceeds 15 seconds.

### Pitfall 2: V2 API Instability
**What goes wrong:** The V2 interface is explicitly marked as "unstable preview" -- APIs may change.
**Why it happens:** Anthropic is iterating on the design.
**How to avoid:** Pin to a specific version of `@anthropic-ai/claude-agent-sdk`. Isolate all SDK usage behind `haiku-client.ts` so only one file needs updating if the API changes. Keep the V1 streaming-input fallback pattern documented.
**Warning signs:** Import errors or type mismatches after `npm update`.

### Pitfall 3: Session Expiration During Idle
**What goes wrong:** Sessions expire after ~10 minutes of inactivity. If the processor is idle then tries to reuse an expired session, calls fail.
**Why it happens:** The SDK auto-expires idle sessions to free resources.
**How to avoid:** Wrap session access in try/catch. On failure, null out the session singleton and create a fresh one. The 12s cold start only happens on first call of a new session.
**Warning signs:** Sporadic failures after idle periods.

### Pitfall 4: Model Name Compatibility
**What goes wrong:** The Agent SDK may not support all model names the same way the direct API does.
**Why it happens:** The SDK routes through Claude Code which may have its own model resolution.
**How to avoid:** Test that `claude-haiku-4-5-20251001` works as a model name in the SDK. The SDK `model` option accepts a string. Check `session.supportedModels()` if available.
**Warning signs:** Model not found errors.

### Pitfall 5: System Prompt Handling in V2
**What goes wrong:** V2 `createSession` takes `systemPrompt` at creation time, but we have 3 different system prompts for classifier/entity/relationship agents.
**Why it happens:** The session is designed for a single conversation context.
**How to avoid:** Either (a) embed system prompt in user message content, (b) create 3 sessions, or (c) create a new session per `processOnce()` call (accepting one 12s cold start per batch). Option (a) is simplest and most resilient.
**Warning signs:** Agent responses don't follow the expected JSON format.

### Pitfall 6: Tool Disabling
**What goes wrong:** If tools are not disabled, the model may attempt to use Read/Bash/etc., causing permission prompts or unexpected behavior.
**Why it happens:** Claude Code's default configuration includes all tools.
**How to avoid:** Set `disallowedTools` to block all built-in tools, or set `allowedTools: []` to allow none. Also set `permissionMode: 'bypassPermissions'` since there are no tools to approve.
**Warning signs:** Calls hang waiting for permission approval, or unexpected tool use messages in the stream.

### Pitfall 7: isHaikuEnabled() Behavior Change
**What goes wrong:** `isHaikuEnabled()` currently checks for API key presence. After migration, there is no API key to check. If it always returns true, the processor will attempt calls even when Claude Code auth is not available.
**Why it happens:** The check semantics change from "has API key" to "has subscription auth".
**How to avoid:** Either (a) always return true and let errors propagate naturally, or (b) make a lightweight SDK call at startup to verify auth works. Option (a) is simpler since the processor already handles call failures gracefully.
**Warning signs:** Error logs about auth failures when Claude Code is not logged in.

## Code Examples

### New callHaiku() Implementation (V2 Session)
```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

type Session = ReturnType<typeof unstable_v2_createSession>;

let _session: Session | null = null;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function getOrCreateSession(): Session {
  if (!_session) {
    _session = unstable_v2_createSession({
      model: HAIKU_MODEL,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowedTools: [],  // No tools needed for pure text completion
    });
  }
  return _session;
}

export async function callHaiku(
  systemPrompt: string,
  userContent: string,
  _maxTokens?: number, // Not directly supported in Agent SDK
): Promise<string> {
  const session = getOrCreateSession();

  // Embed system prompt in user message since session-level systemPrompt
  // is set at creation time and we need different prompts per agent
  const fullPrompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userContent}`;

  try {
    await session.send(fullPrompt);
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return msg.result;
        }
        const errorMsg = 'errors' in msg ? (msg.errors as string[]).join(', ') : msg.subtype;
        throw new Error(`Haiku call failed: ${errorMsg}`);
      }
    }
    return ''; // No result message received
  } catch (error) {
    // Session may have expired -- reset and rethrow
    _session?.close();
    _session = null;
    throw error;
  }
}

export function isHaikuEnabled(): boolean {
  return true; // Always enabled with subscription auth
}

export function resetHaikuClient(): void {
  _session?.close();
  _session = null;
}
```

### Simplified haiku-config.ts
```typescript
// After migration: no API key needed, just model/token config
export interface HaikuConfig {
  model: string;
  maxTokensPerCall: number;
}

export function loadHaikuConfig(): HaikuConfig {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxTokensPerCall: 1024,
  };
}
```

### V1 Fallback Pattern (if V2 proves unstable)
```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

export async function callHaiku(
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const fullPrompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userContent}`;

  const q = query({
    prompt: fullPrompt,
    options: {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const msg of q) {
    if (msg.type === 'result' && msg.subtype === 'success') {
      return msg.result;
    }
  }
  return '';
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@anthropic-ai/sdk` direct API | `@anthropic-ai/claude-agent-sdk` Agent SDK | 2025 | No API key needed, uses subscription |
| V1 string prompt query() | V2 session-based send()/stream() | Late 2025 (preview) | ~77% faster for sequential calls |
| Process-per-call | Session reuse with warm subprocess | Agent SDK 0.2.x | Critical for multi-call workflows |

**Deprecated/outdated:**
- `@anthropic-ai/sdk` for tools running inside Claude Code: Works but requires separate billing. The Agent SDK piggybacks on the subscription.
- V1 `query()` with string prompts for sequential calls: Still works but 12s overhead per call makes it unsuitable for batch processing.

## Open Questions

1. **maxTokens equivalent in Agent SDK**
   - What we know: The direct API has `max_tokens` parameter. The Agent SDK options do not expose `max_tokens` directly.
   - What's unclear: Whether the model respects token limits, or if we just rely on `maxTurns: 1` to constrain output.
   - Recommendation: Remove `maxTokens` parameter from `callHaiku()`. The agents already constrain output via system prompts ("ONLY the JSON object"). If output is too long, add explicit length constraints to prompts.

2. **V2 Session systemPrompt mutability**
   - What we know: `createSession` takes `systemPrompt` at creation time. We have 3 different system prompts.
   - What's unclear: Whether `systemPrompt` can be changed per-send, or if it's fixed for the session lifetime.
   - Recommendation: Embed system prompt in user message content. This is the safest approach and works regardless of session behavior.

3. **Haiku model availability through Agent SDK**
   - What we know: The SDK accepts a `model` string. The direct API uses `claude-haiku-4-5-20251001`.
   - What's unclear: Whether the Agent SDK supports Haiku model selection, or only Sonnet/Opus.
   - Recommendation: Test this first during implementation. If Haiku is not available, the model field may need to be `haiku` (short name) instead of the full model ID. The `AgentDefinition` type shows `model?: "sonnet" | "opus" | "haiku" | "inherit"` which suggests short names may be required.

4. **allowDangerouslySkipPermissions requirement**
   - What we know: `permissionMode: 'bypassPermissions'` exists. The docs also mention `allowDangerouslySkipPermissions: boolean` which "Required when using `permissionMode: 'bypassPermissions'`".
   - What's unclear: Whether this is actually enforced or just a safety acknowledgment.
   - Recommendation: Set both `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` to be safe.

## Sources

### Primary (HIGH confidence)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) - Full API reference including Options, SDKMessage types, query() function
- [V2 TypeScript Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) - Session-based API with send()/stream() patterns
- [GitHub Issue #34: 12s overhead](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) - Performance issue, confirmed resolved with streaming input/session mode

### Secondary (MEDIUM confidence)
- [npm @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) - Version 0.2.42, published 2026-02-13
- Current codebase: `src/intelligence/haiku-client.ts`, `src/config/haiku-config.ts` - Verified current implementation

### Tertiary (LOW confidence)
- Model name resolution in Agent SDK (untested -- `haiku` vs `claude-haiku-4-5-20251001`)
- V2 API stability (explicitly marked "unstable preview")

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official SDK, well-documented, actively maintained
- Architecture: HIGH - Small migration surface, clear patterns from official docs and V2 preview
- Pitfalls: HIGH - Performance issue well-documented with confirmed resolution; V2 instability is acknowledged by Anthropic
- Model compatibility: MEDIUM - Short model names suggested by AgentDefinition type but not confirmed for V2

**Research date:** 2026-02-14
**Valid until:** 2026-03-01 (V2 is unstable preview, API may change)
