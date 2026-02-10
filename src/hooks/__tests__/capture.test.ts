import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import {
  extractObservation,
  processPostToolUse,
  truncate,
  type PostToolUsePayload,
} from '../capture.js';

// ---------------------------------------------------------------------------
// truncate()
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns text unchanged when under maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns text unchanged when exactly at maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ... when over maxLength', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractObservation()
// ---------------------------------------------------------------------------

describe('extractObservation', () => {
  function makePayload(overrides: Partial<PostToolUsePayload> = {}): PostToolUsePayload {
    return {
      session_id: 'sess-123',
      cwd: '/tmp/project',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {},
      ...overrides,
    };
  }

  it('extracts Write observation with file path and truncated content', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Write',
        tool_input: {
          file_path: '/src/app.ts',
          content: 'const x = 1;\n'.repeat(30),
        },
      }),
    );

    expect(result).toContain('[Write] Created /src/app.ts');
    expect(result).toContain('const x = 1;');
  });

  it('extracts Edit observation with old/new string summaries', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/src/utils.ts',
          old_string: 'function old() { return 1; }',
          new_string: 'function updated() { return 2; }',
        },
      }),
    );

    expect(result).toContain('[Edit] Modified /src/utils.ts');
    expect(result).toContain('function old()');
    expect(result).toContain('function updated()');
  });

  it('extracts Bash observation with command and response', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'All tests passed' },
      }),
    );

    expect(result).toContain('[Bash] $ npm test');
    expect(result).toContain('All tests passed');
  });

  it('extracts Read observation with file path', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Read',
        tool_input: { file_path: '/src/config.ts' },
      }),
    );

    expect(result).toBe('[Read] /src/config.ts');
  });

  it('extracts Glob observation with pattern and path', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.ts', path: '/src' },
      }),
    );

    expect(result).toBe('[Glob] pattern=**/*.ts in /src');
  });

  it('extracts Grep observation with pattern and path', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Grep',
        tool_input: { pattern: 'TODO', path: '/src' },
      }),
    );

    expect(result).toBe('[Grep] pattern=TODO in /src');
  });

  it('extracts Glob observation without path defaults to cwd', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'Glob',
        tool_input: { pattern: '*.js' },
      }),
    );

    expect(result).toBe('[Glob] pattern=*.js in cwd');
  });

  it('extracts default/MCP tool observation with JSON input', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'mcp__github__search',
        tool_input: { query: 'laminark repo' },
      }),
    );

    expect(result).toContain('[mcp__github__search]');
    expect(result).toContain('laminark repo');
  });

  it('extracts unknown tool observation with JSON input', () => {
    const result = extractObservation(
      makePayload({
        tool_name: 'CustomTool',
        tool_input: { data: 'some value' },
      }),
    );

    expect(result).toContain('[CustomTool]');
    expect(result).toContain('some value');
  });

  it('truncates long Write content to 200 chars', () => {
    const longContent = 'x'.repeat(300);
    const result = extractObservation(
      makePayload({
        tool_name: 'Write',
        tool_input: { file_path: '/test.ts', content: longContent },
      }),
    );

    // Content portion should be truncated
    const contentLine = result!.split('\n')[1];
    expect(contentLine!.length).toBeLessThanOrEqual(203); // 200 + '...'
  });

  it('truncates long Edit old_string/new_string to 80 chars', () => {
    const longString = 'a'.repeat(100);
    const result = extractObservation(
      makePayload({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/test.ts',
          old_string: longString,
          new_string: longString,
        },
      }),
    );

    // Each quoted portion should be truncated to 80 + '...'
    expect(result).toContain('a'.repeat(80) + '...');
  });
});

// ---------------------------------------------------------------------------
// processPostToolUse() -- integration tests with real database
// ---------------------------------------------------------------------------

describe('processPostToolUse', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let obsRepo: ObservationRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('creates an observation in the database for a Write tool', () => {
    processPostToolUse(
      {
        session_id: 'sess-1',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/src/app.ts', content: 'hello world' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:Write');
    expect(observations[0].content).toContain('[Write] Created /src/app.ts');
    expect(observations[0].sessionId).toBe('sess-1');
  });

  it('creates an observation for an Edit tool', () => {
    processPostToolUse(
      {
        session_id: 'sess-2',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/src/utils.ts',
          old_string: 'const x = 1',
          new_string: 'const x = 2',
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:Edit');
    expect(observations[0].content).toContain('[Edit] Modified /src/utils.ts');
  });

  it('skips mcp__laminark__ prefixed tools (self-referential capture)', () => {
    processPostToolUse(
      {
        session_id: 'sess-3',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__laminark__save_memory',
        tool_input: { content: 'some observation' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('skips mcp__laminark__recall tool', () => {
    processPostToolUse(
      {
        session_id: 'sess-4',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__laminark__recall',
        tool_input: { query: 'search term' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('skips input without tool_name', () => {
    processPostToolUse(
      {
        session_id: 'sess-5',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('creates observation with correct source format', () => {
    processPostToolUse(
      {
        session_id: 'sess-6',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_response: { stdout: 'total 8' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:Bash');
  });

  it('captures non-laminark MCP tools normally', () => {
    processPostToolUse(
      {
        session_id: 'sess-7',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__github__create_issue',
        tool_input: { title: 'Bug report' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:mcp__github__create_issue');
  });
});
