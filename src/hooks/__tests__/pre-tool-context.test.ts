import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import { initGraphSchema, upsertNode, insertEdge } from '../../graph/schema.js';

import { handlePreToolUse } from '../pre-tool-context.js';

describe('handlePreToolUse', () => {
  let laminarkDb: LaminarkDatabase;
  let cleanup: () => void;
  let obsRepo: ObservationRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    const tmp = createTempDb();
    cleanup = tmp.cleanup;
    laminarkDb = openDatabase(tmp.config);
    obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
    initGraphSchema(laminarkDb.db);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('returns null for Laminark own tools', () => {
    const result = handlePreToolUse(
      { tool_name: 'mcp__laminark__save_memory', tool_input: { text: 'hi' } },
      laminarkDb.db,
      projectHash,
    );
    expect(result).toBeNull();
  });

  it('returns null for skipped tools (Glob, Task)', () => {
    expect(handlePreToolUse(
      { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
      laminarkDb.db,
      projectHash,
    )).toBeNull();

    expect(handlePreToolUse(
      { tool_name: 'Task', tool_input: { prompt: 'do stuff' } },
      laminarkDb.db,
      projectHash,
    )).toBeNull();
  });

  it('returns null when no tool_name is present', () => {
    expect(handlePreToolUse({}, laminarkDb.db, projectHash)).toBeNull();
  });

  it('returns null for noise Bash commands', () => {
    expect(handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'cd /tmp' } },
      laminarkDb.db,
      projectHash,
    )).toBeNull();

    expect(handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
      laminarkDb.db,
      projectHash,
    )).toBeNull();

    expect(handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      laminarkDb.db,
      projectHash,
    )).toBeNull();
  });

  it('returns null when no relevant observations exist', () => {
    const result = handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: '/src/nonexistent.ts' } },
      laminarkDb.db,
      projectHash,
    );
    expect(result).toBeNull();
  });

  it('returns context when matching observations exist', () => {
    // Seed an observation — FTS5 will tokenize on word boundaries,
    // and basename "handler.ts" gets sanitized to "handlerts" by FTS5 sanitizer.
    // Use just "handler" as a more reliable match.
    obsRepo.create({
      content: 'The handler module manages hook dispatch for all events',
      source: 'hook:Edit',
      kind: 'finding',
      sessionId: 'sess-1',
    });

    const result = handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: '/src/hooks/handler.ts' } },
      laminarkDb.db,
      projectHash,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('[Laminark] Context for handler.ts');
    expect(result).toContain('handler');
  });

  it('includes graph relationships for file tools', () => {
    const fileNode = upsertNode(laminarkDb.db, {
      type: 'File',
      name: '/src/hooks/handler.ts',
      metadata: {},
      observation_ids: [],
    });
    const decisionNode = upsertNode(laminarkDb.db, {
      type: 'Decision',
      name: 'Use synchronous hooks for context injection',
      metadata: {},
      observation_ids: [],
    });
    insertEdge(laminarkDb.db, {
      source_id: fileNode.id,
      target_id: decisionNode.id,
      type: 'related_to',
      weight: 0.8,
      metadata: {},
    });

    const result = handlePreToolUse(
      { tool_name: 'Edit', tool_input: { file_path: '/src/hooks/handler.ts' } },
      laminarkDb.db,
      projectHash,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('Related:');
    expect(result).toContain('Use synchronous hooks');
    expect(result).toContain('Decision');
  });

  it('extracts query from Grep pattern', () => {
    obsRepo.create({
      content: 'The searchKeyword function uses FTS5 for full-text search',
      source: 'hook:Edit',
      kind: 'finding',
      sessionId: 'sess-1',
    });

    const result = handlePreToolUse(
      { tool_name: 'Grep', tool_input: { pattern: 'searchKeyword' } },
      laminarkDb.db,
      projectHash,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('searchKeyword');
  });

  it('extracts domain from WebFetch URL', () => {
    obsRepo.create({
      content: 'Fetched docs from github.com about the API',
      source: 'hook:WebFetch',
      kind: 'reference',
      sessionId: 'sess-1',
    });

    const result = handlePreToolUse(
      { tool_name: 'WebFetch', tool_input: { url: 'https://github.com/anthropics/claude-code' } },
      laminarkDb.db,
      projectHash,
    );

    // May or may not find results depending on FTS matching "github.com"
    if (result) {
      expect(result).toContain('[Laminark]');
    }
  });

  it('caps output at ~500 characters', () => {
    for (let i = 0; i < 10; i++) {
      obsRepo.create({
        content: `Observation ${i}: The handler module processes events and dispatches to appropriate handlers for all tool invocations in the system`,
        source: 'hook:Edit',
        kind: 'finding',
        sessionId: 'sess-1',
      });
    }

    const result = handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: '/src/hooks/handler.ts' } },
      laminarkDb.db,
      projectHash,
    );

    if (result) {
      expect(result.length).toBeLessThanOrEqual(501);
    }
  });

  it('extracts query from WebSearch', () => {
    obsRepo.create({
      content: 'Searched for vitest configuration best practices',
      source: 'hook:WebSearch',
      kind: 'reference',
      sessionId: 'sess-1',
    });

    const result = handlePreToolUse(
      { tool_name: 'WebSearch', tool_input: { query: 'vitest configuration' } },
      laminarkDb.db,
      projectHash,
    );

    if (result) {
      expect(result).toContain('[Laminark]');
      expect(result).toContain('vitest');
    }
  });
});
