# Phase 3: Hook Integration and Capture - Research

**Researched:** 2026-02-08
**Domain:** Claude Code hooks, IPC between hook processes and MCP server, observation capture pipeline, noise filtering, privacy redaction
**Confidence:** HIGH

## Summary

Phase 3 bridges Claude Code lifecycle events to the Laminark storage engine. The core challenge is IPC: Claude Code hooks execute as **separate shell processes** spawned by the Claude Code host. They receive JSON on stdin and must communicate captured data to the running MCP server process, which owns the database connection. The old Phase 3 plans assumed an HTTP endpoint approach (shell scripts curl POST to localhost:37819). After thorough research, this document recommends a **simpler direct-database-write approach** instead: hook scripts invoke a lightweight CLI binary that opens its own database connection, writes directly to SQLite, and exits.

This is sound because: (1) SQLite with WAL mode explicitly supports concurrent readers and a single writer at a time, with `busy_timeout` handling contention; (2) better-sqlite3 connections are cheap to open (~2ms); (3) hook scripts are fire-and-forget for PostToolUse/SessionEnd/Stop, so the hook process can write and die; (4) it eliminates an entire HTTP server component, a port reservation, and the complexity of ensuring the HTTP server starts before hooks fire.

The admission filter (noise detection) and privacy filter (sensitive content redaction) remain as designed in the old plans -- they are pure logic modules that run within the hook CLI process before the database write. The hook configuration lives in `hooks/hooks.json` within the plugin directory structure, using `${CLAUDE_PLUGIN_ROOT}` for path references.

**Primary recommendation:** Replace the HTTP-based ingest architecture with a direct-database-write CLI. Hook scripts pipe stdin JSON to `node ${CLAUDE_PLUGIN_ROOT}/dist/hook-handler.js`, which parses the event, runs privacy and admission filters, and writes qualifying observations directly to SQLite. No HTTP server needed.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | SQLite database (from Phase 1) | Already installed. Hook handler opens its own connection for writes. WAL mode handles concurrent access with MCP server reads. |
| zod | ^4.3.6 | Input validation for hook payloads | Already installed. Validate incoming hook JSON structure. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | No new dependencies needed. Node.js built-in `process.stdin`, `crypto`, `fs` are sufficient. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct DB write from hook CLI | HTTP server (old plan) | HTTP adds complexity (port management, server lifecycle, liveness checking). Direct write is simpler but means each hook invocation opens a DB connection (~2ms overhead). Since hooks fire at human conversation speed (not thousands/sec), this overhead is negligible. |
| Direct DB write from hook CLI | Unix domain socket to MCP process | Lower latency than HTTP but requires the MCP server to listen on a socket (additional complexity). The MCP server already uses stdio for MCP protocol. Adding a second IPC channel adds complexity without clear benefit. |
| Direct DB write from hook CLI | Shared file/queue (append to JSONL, MCP reads) | Decouples write timing but adds polling complexity, eventual consistency lag, and file rotation concerns. Database write is atomic and immediately queryable. |

**Installation:**
```bash
# No new dependencies needed -- all libraries already installed from Phase 1
```

## Architecture Patterns

### Recommended Project Structure
```
laminark/
├── hooks/
│   └── hooks.json                  # Claude Code plugin hook configuration
├── src/
│   ├── hooks/
│   │   ├── handler.ts              # Hook entry point: reads stdin, dispatches by event
│   │   ├── capture.ts              # PostToolUse/Stop observation extraction
│   │   ├── session-lifecycle.ts    # SessionStart/SessionEnd handling
│   │   ├── admission-filter.ts    # Noise detection and relevance scoring
│   │   ├── noise-patterns.ts      # Pattern definitions for noise categories
│   │   ├── privacy-filter.ts      # Sensitive content redaction
│   │   └── __tests__/
│   │       ├── handler.test.ts
│   │       ├── capture.test.ts
│   │       ├── admission-filter.test.ts
│   │       └── privacy-filter.test.ts
│   ├── mcp/                        # Phase 2 (unchanged)
│   ├── storage/                    # Phase 1 (unchanged)
│   └── shared/
│       ├── types.ts                # Add hook-related types
│       ├── config.ts               # Add privacy config
│       └── debug.ts
├── .mcp.json                       # MCP server config (from Phase 2)
└── package.json                    # Add hook-handler bin entry
```

### Pattern 1: Direct Database Write from Hook Process

**What:** Each hook invocation spawns a Node.js process that reads stdin JSON, processes it through filters, and writes directly to SQLite. No HTTP intermediary.
**When to use:** All observation capture and session lifecycle hooks.
**Why it works:** SQLite WAL mode allows concurrent readers (MCP server) and writers (hook process). `busy_timeout` of 5000ms (already configured in Phase 1) handles the rare case where the MCP server is also writing. Hook writes are small and fast (~1ms for an INSERT).

```typescript
// Source: Claude Code hooks documentation (https://code.claude.com/docs/en/hooks)
// src/hooks/handler.ts -- entry point for all hooks

import { openDatabase } from '../storage/database.js';
import { getDatabaseConfig, getProjectHash } from '../shared/config.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import { processPostToolUse } from './capture.js';
import { handleSessionStart, handleSessionEnd } from './session-lifecycle.js';
import { debug } from '../shared/debug.js';

async function main(): Promise<void> {
  // Read all stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  const eventName = input.hook_event_name;
  const projectHash = getProjectHash(input.cwd);

  // Open database -- cheap with WAL mode (~2ms)
  const laminarkDb = openDatabase(getDatabaseConfig());

  try {
    const obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
    const sessionRepo = new SessionRepository(laminarkDb.db, projectHash);

    switch (eventName) {
      case 'PostToolUse':
      case 'PostToolUseFailure':
        await processPostToolUse(input, obsRepo);
        break;
      case 'SessionStart':
        handleSessionStart(input, sessionRepo);
        break;
      case 'SessionEnd':
        handleSessionEnd(input, sessionRepo);
        break;
      case 'Stop':
        await processPostToolUse(input, obsRepo);
        break;
    }
  } finally {
    laminarkDb.close();
  }
}

main().catch((err) => {
  // Hooks must NEVER fail -- exit 0 always
  debug('hook', 'Hook handler error', { error: err.message });
});
// Always exit 0 -- hooks must never block Claude Code
```

### Pattern 2: Hook Configuration in Plugin hooks.json

**What:** Configure hooks in `hooks/hooks.json` using the Claude Code plugin hook format. Use `${CLAUDE_PLUGIN_ROOT}` for paths.
**When to use:** This is the standard plugin hook configuration format.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Key decisions in this configuration:**
- `async: true` for PostToolUse, PostToolUseFailure, SessionEnd, Stop -- non-blocking, fire-and-forget
- No `async` for SessionStart -- sync/blocking to allow future context injection (Phase 5)
- `matcher: ""` (empty string) matches all tool names -- capture everything, let the admission filter decide
- `timeout: 10` for async hooks, `timeout: 5` for SessionStart
- Single handler script for all events -- the handler reads `hook_event_name` from stdin JSON to dispatch

### Pattern 3: Observation Extraction from PostToolUse

**What:** Extract a semantic summary from the PostToolUse JSON payload, not the raw tool output.
**When to use:** Every PostToolUse event.

```typescript
// Source: Claude Code hooks documentation (https://code.claude.com/docs/en/hooks)
// PostToolUse input format (verified from official docs):
// {
//   session_id, transcript_path, cwd, permission_mode, hook_event_name,
//   tool_name: "Write",
//   tool_input: { file_path: "/path/to/file.txt", content: "file content" },
//   tool_response: { filePath: "/path/to/file.txt", success: true },
//   tool_use_id: "toolu_01ABC123..."
// }

interface PostToolUsePayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
}

function extractObservation(payload: PostToolUsePayload): string | null {
  const { tool_name, tool_input, tool_response } = payload;

  // Build semantic summary based on tool type
  switch (tool_name) {
    case 'Write':
      // High signal: file creation. Include path and first ~200 chars of content
      return `[Write] Created ${tool_input.file_path}\n${truncate(String(tool_input.content ?? ''), 200)}`;

    case 'Edit':
      // High signal: code change. Include path, old->new summary
      return `[Edit] Modified ${tool_input.file_path}: replaced "${truncate(String(tool_input.old_string ?? ''), 80)}" with "${truncate(String(tool_input.new_string ?? ''), 80)}"`;

    case 'Bash':
      // Medium signal: command execution. Include command and first ~200 chars of response
      const cmd = truncate(String(tool_input.command ?? ''), 100);
      const output = truncate(JSON.stringify(tool_response ?? ''), 200);
      return `[Bash] $ ${cmd}\n${output}`;

    case 'Read':
      // Low signal: file reads are usually noise. Return null (admission filter handles)
      return `[Read] ${tool_input.file_path}`;

    case 'Glob':
    case 'Grep':
      // Low signal: search operations
      return `[${tool_name}] pattern=${tool_input.pattern ?? ''} in ${tool_input.path ?? 'cwd'}`;

    default:
      // MCP tools and others -- capture tool name + input summary
      if (tool_name.startsWith('mcp__')) {
        return `[${tool_name}] ${truncate(JSON.stringify(tool_input), 200)}`;
      }
      return `[${tool_name}] ${truncate(JSON.stringify(tool_input), 200)}`;
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
```

### Pattern 4: Privacy Filter with Configurable Patterns

**What:** Redact sensitive content before storage, replacing values with `[REDACTED:category]` placeholders.
**When to use:** Every observation before admission filter and database write.

```typescript
// Built-in patterns that are always active
const DEFAULT_PRIVACY_PATTERNS = [
  {
    name: 'env_variable',
    // Match KEY=value where KEY is UPPER_SNAKE_CASE and value is 8+ chars
    regex: /\b([A-Z][A-Z0-9_]{2,})=(["']?)([^\s"']{8,})\2/g,
    replacement: '$1=[REDACTED:env]',
    category: 'env',
  },
  {
    name: 'api_key_openai',
    regex: /sk-[a-zA-Z0-9]{20,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'api_key_github',
    regex: /ghp_[a-zA-Z0-9]{36,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'aws_access_key',
    regex: /AKIA[A-Z0-9]{12,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'jwt_token',
    regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED:jwt]',
    category: 'jwt',
  },
  {
    name: 'connection_string',
    regex: /(postgresql|mongodb|mysql|redis):\/\/[^\s]+/g,
    replacement: '$1://[REDACTED:connection_string]',
    category: 'connection_string',
  },
  {
    name: 'private_key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
    category: 'private_key',
  },
];

// Files that should be fully excluded (observation returns null)
const DEFAULT_EXCLUDED_FILE_PATTERNS = [
  /\.env(\.|$)/,        // .env, .env.local, .env.production
  /credentials/i,        // credentials.json, etc.
  /secrets/i,           // secrets.yaml, etc.
  /\.pem$/,             // SSL certificates
  /\.key$/,             // Private keys
  /id_rsa/,             // SSH keys
];
```

### Pattern 5: Admission Filter with Noise Detection

**What:** Reject low-signal observations before database write. Score observations on relevance.
**When to use:** Every observation after privacy filtering.

```typescript
// Noise categories with detection patterns
const NOISE_PATTERNS = {
  BUILD_OUTPUT: [
    /npm WARN/i, /npm ERR/i, /Successfully compiled/i,
    /webpack compiled/i, /tsc.*error TS/i, /Build completed/i,
    /Compiling\b/i, /Module not found/i,
  ],
  PACKAGE_INSTALL: [
    /added \d+ packages?/i, /npm install/i, /up to date/i,
    /removed \d+ packages?/i, /audited \d+ packages?/i,
  ],
  LINTER_WARNING: [
    /eslint/i, /prettier/i, /\d+ problems?/i,
    // 3+ consecutive "warning:" lines = noise
  ],
  EMPTY_OUTPUT: [
    /^(OK|Success|Done|undefined|null)?\s*$/i,
  ],
};

// Relevance scoring factors
const RELEVANCE_FACTORS = {
  tool_type: { Write: 0.4, Edit: 0.4, Bash: 0.2, Read: 0.1 },
  content_length: { '10-200': 0.2, '200-500': 0.3, '500+': 0.1 },
  decision_indicators: 0.2, // "decided", "chose", "because", "instead of"
  error_indicators: 0.15,   // "error", "failed", "exception", "bug"
  file_path_present: 0.15,
};
```

### Anti-Patterns to Avoid

- **HTTP server for hook-to-process communication:** Adds unnecessary complexity (port management, server lifecycle, liveness checks). Direct SQLite write via WAL is simpler and equally reliable.
- **Storing raw tool_response verbatim:** Tool responses can be enormous (full file contents, long grep results). Extract a semantic summary instead. Store tool_name + first ~200 chars of meaningful output + file paths.
- **Shell scripts as hook dispatchers:** The old plans used bash scripts calling curl. With the direct-write approach, use `node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js` directly -- it reads stdin, no shell scripting needed.
- **Opening database per-filter-module:** Open the database ONCE in the handler entry point. Pass the db connection to filter modules. Do NOT open multiple connections.
- **Failing hooks with non-zero exit codes:** Hooks MUST exit 0 always. A non-zero exit code from PostToolUse shows stderr to Claude as an error. Wrap everything in try/catch, log errors via debug(), exit 0.
- **Writing to stdout from hook scripts:** For PostToolUse hooks, exit code 0 with no stdout is the correct behavior. Any stdout JSON output is processed by Claude Code (decision control). For SessionStart, stdout becomes Claude context. Only write to stdout when you intentionally want Claude Code to act on it.
- **Using console.log in hook handler:** stdout must stay clean. Use `process.stderr.write()` or the existing `debug()` function for logging.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hook JSON parsing | Custom stdin reader | Node.js `process.stdin` async iteration + `JSON.parse()` | Standard Node.js pattern. No third-party library needed. |
| Database concurrent access | Custom locking/queuing | SQLite WAL mode + `busy_timeout` (already configured) | WAL mode handles reader-writer concurrency natively. busy_timeout handles the rare contention case. |
| Observation CRUD | Direct SQL in hook handler | `ObservationRepository` from Phase 1 | Already project-scoped, prepared-statement-optimized, debug-instrumented. |
| Session lifecycle | Direct SQL in hook handler | `SessionRepository` from Phase 1 | Already has create(), end(), getActive() methods. |
| Sensitive content detection | Custom regex from scratch | Well-tested regex patterns for common secret formats | Use patterns from established tools (detect-secrets, gitleaks). The patterns above are derived from these. |
| FTS5 query sanitization | Custom sanitizer | `SearchEngine.sanitizeQuery()` from Phase 1 | Already handles all FTS5 operator edge cases. |

**Key insight:** Phase 3 is glue code between Claude Code hooks and the Phase 1 storage layer. The admission and privacy filters are the only genuinely new logic. Everything else (database access, observation CRUD, session management) already exists.

## Common Pitfalls

### Pitfall 1: Hook Process Cold Start Overhead

**What goes wrong:** Each hook invocation spawns a new Node.js process. If the handler imports heavy modules (like the full MCP SDK or sqlite-vec), startup takes 200ms+ instead of <50ms.
**Why it happens:** Node.js module resolution and V8 compilation of large modules.
**How to avoid:** The hook handler should import ONLY what it needs: better-sqlite3, the storage modules, and the filter modules. Do NOT import @modelcontextprotocol/sdk or any MCP-related code in the hook handler. Keep the import tree lean. Consider using tsdown to bundle the hook handler into a single file for faster startup.
**Warning signs:** Hook scripts taking >100ms to complete (visible in `claude --debug` output).

### Pitfall 2: Database Busy Errors Under Rapid Tool Use

**What goes wrong:** During rapid tool use (e.g., Claude editing 10 files in quick succession), multiple hook processes may try to write to SQLite simultaneously. While WAL mode handles reader-writer concurrency, two concurrent writers will contend.
**Why it happens:** SQLite allows only one writer at a time. Two hook processes writing simultaneously means one must wait.
**How to avoid:** The `busy_timeout` of 5000ms (configured in Phase 1) handles this -- the second writer waits up to 5 seconds for the first to finish. Since hook writes are <10ms each, this is more than sufficient. If contention occurs, the write succeeds after a brief wait. The hook process exits cleanly.
**Warning signs:** Debug log messages about "SQLITE_BUSY" (should be extremely rare with 5s timeout and <10ms writes).

### Pitfall 3: Admission Filter False Positives on Code Content

**What goes wrong:** The admission filter rejects legitimate code changes because the content matches noise patterns (e.g., a file that mentions "webpack" in a comment gets flagged as BUILD_OUTPUT).
**Why it happens:** Pattern matching on content without considering the tool_name context. A Write tool creating a webpack config file is high signal, even though the content mentions "webpack."
**How to avoid:** The admission filter should NEVER reject Write or Edit tool observations based on content patterns alone. Tool type is the primary signal. Content pattern matching should only apply to Bash/Read tool output.
**Warning signs:** Missing observations for file edits in the database.

### Pitfall 4: Privacy Filter Over-Redaction

**What goes wrong:** The privacy filter redacts legitimate content that happens to match secret patterns (e.g., a variable name `AKIA_PREFIX = "test"` or a UUID that looks like a JWT).
**Why it happens:** Regex patterns for secrets are inherently heuristic and can have false positives.
**How to avoid:** Apply minimum length thresholds for matches (API keys must be 20+ chars, env values must be 8+ chars). Test with a corpus of real code content. Allow users to configure custom exclusion patterns. Log redaction events at debug level so users can spot false positives.
**Warning signs:** Observations containing `[REDACTED:...]` placeholders where the original content was not actually sensitive.

### Pitfall 5: SessionStart Hook Blocking Too Long

**What goes wrong:** The SessionStart hook is synchronous (no `async` flag). If the hook handler takes too long, it delays Claude Code session startup noticeably.
**Why it happens:** Opening the database, running migrations (if first run), and querying for session data all take time.
**How to avoid:** In Phase 3, the SessionStart handler should ONLY create a session record (fast INSERT). Context injection (querying last session summary, recent observations) is Phase 5's responsibility. Keep Phase 3's SessionStart handler under 100ms. Set `timeout: 5` in the hook config.
**Warning signs:** Users noticing a delay when starting Claude Code sessions.

### Pitfall 6: Hook Script Fails Because Node.js Not Found

**What goes wrong:** The hook command `node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js` fails because `node` is not in PATH when Claude Code spawns the hook process.
**Why it happens:** Claude Code may spawn hooks with a different PATH than the user's interactive shell.
**How to avoid:** Use the full path or ensure the `bin` entry in package.json is used. Alternatively, use `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/hooks/handler.ts` for development (tsx is already a dev dependency). For production, the built dist/ output should be used.
**Warning signs:** Hooks silently failing (exit code != 0 logged in `claude --debug` but hook appears to do nothing).

### Pitfall 7: Duplicate Observations from Same Tool Call

**What goes wrong:** The same tool call generates multiple observations because both PostToolUse and Stop hooks fire for the last tool call in a response.
**Why it happens:** Stop fires when Claude finishes responding. If the last action was a tool call, PostToolUse already captured it.
**How to avoid:** Deduplicate by `tool_use_id`. The PostToolUse payload includes `tool_use_id`. Store a short-lived LRU of recently processed tool_use_ids (last 50) and skip duplicates. Alternatively, only capture observations from PostToolUse (not Stop) -- the Stop event is more useful for session summary generation (Phase 5).
**Warning signs:** Duplicate observations with identical content appearing in the database.

## Code Examples

Verified patterns from official Claude Code documentation:

### PostToolUse Hook Input (Official Format)

```json
// Source: https://code.claude.com/docs/en/hooks#posttooluse
// This is what the hook handler receives on stdin for PostToolUse events
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "success": true
  },
  "tool_use_id": "toolu_01ABC123..."
}
```

### SessionStart Hook Input (Official Format)

```json
// Source: https://code.claude.com/docs/en/hooks#sessionstart
// SessionStart receives source, model, and common fields
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-4-5-20250929"
}
```

### SessionEnd Hook Input (Official Format)

```json
// Source: https://code.claude.com/docs/en/hooks#sessionend
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

### PostToolUseFailure Hook Input (Official Format)

```json
// Source: https://code.claude.com/docs/en/hooks#posttoolusefailure
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run test suite"
  },
  "tool_use_id": "toolu_01ABC123...",
  "error": "Command exited with non-zero status code 1",
  "is_interrupt": false
}
```

### Stop Hook Input (Official Format)

```json
// Source: https://code.claude.com/docs/en/hooks#stop
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

### Plugin hooks.json Format (Verified)

```json
// Source: https://code.claude.com/docs/en/plugins-reference#hooks
// Plugin hooks go in hooks/hooks.json at plugin root
// Use ${CLAUDE_PLUGIN_ROOT} for paths to plugin scripts
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Reading Stdin in Node.js Hook Handler

```typescript
// Standard Node.js stdin reading for hook handlers
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Usage in hook handler
const raw = await readStdin();
const payload = JSON.parse(raw);
// payload.hook_event_name tells us which event fired
// payload.session_id, payload.cwd are always present
```

## State of the Art

| Old Approach (previous Phase 3 plans) | Current Approach (this research) | Why Changed | Impact |
|---|---|---|---|
| Shell scripts (hook-dispatcher.sh, session-start.sh) curling HTTP endpoints | Single Node.js handler invoked directly by hooks | Shell scripts add an unnecessary layer. Node.js reads stdin directly. | Eliminates 3 shell scripts, 1 HTTP server module. Simpler pipeline. |
| HTTP ingest server on localhost:37819 | Direct SQLite write from hook process | HTTP server adds port management, lifecycle complexity, and a race condition (hooks may fire before HTTP server starts). | Eliminates entire `src/ingest/receiver.ts` module. No port conflicts. |
| Separate normalizer module (src/ingest/normalizer.ts) | Observation extraction inline in capture.ts | The normalizer was converting between HookPayload and RawObservation types. With direct write, the extraction logic is simpler. | Fewer modules, simpler type system. |
| hooks.json in a separate `hooks/` directory with bash scripts | hooks.json in plugin `hooks/` directory referencing Node.js handler | Plugin format uses `${CLAUDE_PLUGIN_ROOT}` and supports `async` flag natively. | Aligns with official plugin structure. |

**Deprecated/outdated (from old plans):**
- `scripts/hook-dispatcher.sh`, `scripts/session-start.sh`, `scripts/session-end.sh`: Not needed. Node.js handler reads stdin directly.
- `src/ingest/receiver.ts` (HTTP server): Not needed. Direct database write.
- `src/ingest/normalizer.ts`: Merged into `src/hooks/capture.ts`.
- `src/ingest/pipeline.ts`: Not needed. The handler IS the pipeline.
- `src/ingest/queue.ts`: Not needed. No queuing -- write immediately.
- `localhost:37819` port reservation: Not needed.

## Critical Design Decision: Hook Handler as Separate Entry Point

The hook handler (`src/hooks/handler.ts`) is a **separate entry point** from the MCP server (`src/index.ts`). They are different processes:

- **MCP server process** (`src/index.ts`): Long-running. Started by Claude Code via `.mcp.json`. Communicates via stdio JSON-RPC. Handles `save_memory`, `recall` tools. Has its own database connection.
- **Hook handler process** (`src/hooks/handler.ts`): Short-lived. Spawned by Claude Code for each hook event. Reads stdin JSON, writes to database, exits. Has its own database connection (opened, used, closed within milliseconds).

Both processes access the same `~/.laminark/data.db` file. This is safe because:
1. SQLite WAL mode allows concurrent readers and handles writer contention via busy_timeout
2. Hook handler writes are tiny (single INSERT) and complete in <10ms
3. MCP server reads are non-blocking in WAL mode
4. MCP server writes (save_memory) are also tiny and rare (user-initiated)

The `package.json` should add a `bin` entry for the hook handler:
```json
{
  "bin": {
    "laminark-server": "./dist/index.js",
    "laminark-hook": "./dist/hooks/handler.js"
  }
}
```

## Open Questions

1. **Hook handler bundling strategy**
   - What we know: Each hook invocation spawns a new Node.js process. Import time matters. tsdown can bundle into a single file.
   - What's unclear: Whether the current tsdown config produces a single-file bundle for the hook handler, or if it needs a separate entry point config.
   - Recommendation: Configure tsdown with two entry points (`src/index.ts` for MCP server, `src/hooks/handler.ts` for hook handler). Verify bundle size and startup time. Target <50ms for hook handler cold start.

2. **Stop hook: capture or skip?**
   - What we know: The Stop event fires when Claude finishes responding. It does NOT include tool_name/tool_input/tool_response -- it only has stop_hook_active.
   - What's unclear: Whether there is value in capturing a "Claude stopped" observation. The old plans captured it as a tool use event, but Stop is NOT a tool use event.
   - Recommendation: Handle Stop in Phase 3 only for future Phase 5 session summary triggers. Do NOT create observations from Stop events (no tool data to extract). Mark the session as having a "stop" event for session summary generation later.

3. **MCP tool calls via hooks: capture Laminark's own tools?**
   - What we know: PostToolUse hooks fire for MCP tools too (tool_name like `mcp__laminark__save_memory`). If hooks capture everything, Laminark would observe its own save_memory calls.
   - What's unclear: Whether self-referential observations are useful or noise.
   - Recommendation: Filter out tools matching `mcp__laminark__` prefix in the admission filter. Laminark should not observe its own operations.

4. **Deduplication across PostToolUse events**
   - What we know: PostToolUse fires for every tool call. During rapid editing (Claude writes 5 files in sequence), 5 hook processes may run nearly simultaneously.
   - What's unclear: Whether any deduplication by tool_use_id is needed, or if each tool call is genuinely distinct.
   - Recommendation: Each tool call IS distinct (different tool_use_id). No deduplication needed for PostToolUse. Only deduplicate if the same tool_use_id appears in both PostToolUse and Stop (which it won't -- Stop has no tool_use_id).

5. **Privacy config file location and format**
   - What we know: Phase 1 established `~/.laminark/config.json` for debug mode. Privacy patterns should be configurable.
   - What's unclear: Whether privacy config goes in the same file or a separate one.
   - Recommendation: Extend `~/.laminark/config.json` with a `privacy` section: `{ "debug": true, "privacy": { "additionalPatterns": [...], "excludedFiles": [...] } }`. Keep the existing config format.

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- Complete hook event documentation, JSON input/output formats, async behavior, exit code semantics. **Verified 2026-02-08.** This is the authoritative source for all hook-related design decisions.
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide) -- Practical examples, configuration walkthrough, troubleshooting.
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) -- Plugin structure, hooks.json format, ${CLAUDE_PLUGIN_ROOT}, .mcp.json format. **Verified 2026-02-08.**
- [Claude Code Plugins Guide](https://code.claude.com/docs/en/plugins) -- Plugin creation, directory structure, testing with --plugin-dir.
- Phase 1 codebase (`src/storage/`, `src/shared/`) -- Database connection, repositories, config, debug logging. Examined in full.
- Phase 2 research (`02-RESEARCH.md`) -- MCP server architecture, registerTool API, .mcp.json format.

### Secondary (MEDIUM confidence)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- MCP server configuration within Claude Code.
- Old Phase 3 plans (`03-01-PLAN.md` through `03-04-PLAN.md`) -- Previous architecture decisions, reviewed and superseded.

### Tertiary (LOW confidence)
- Community examples of Claude Code hook implementations (GitHub repositories) -- Used for validation of patterns, not as authoritative source.

## Metadata

**Confidence breakdown:**
- Hook JSON format and behavior: HIGH -- Verified from official Claude Code documentation (https://code.claude.com/docs/en/hooks), including exact field names, async behavior, exit code semantics, and plugin hook configuration
- Direct DB write architecture: HIGH -- SQLite WAL concurrent access is well-documented and already proven in Phase 1 concurrency tests
- Admission filter patterns: MEDIUM -- Noise pattern definitions are heuristic and will need tuning with real usage data
- Privacy filter patterns: MEDIUM -- Regex patterns are derived from established tools (detect-secrets, gitleaks) but false positive rates need validation
- Hook handler startup performance: MEDIUM -- Node.js cold start with better-sqlite3 import should be <50ms but needs measurement

**Research date:** 2026-02-08
**Valid until:** 2026-03-10 (30 days -- Claude Code hook system is stable, unlikely to change significantly)
