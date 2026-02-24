import { describe, it, expect, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import Database from 'better-sqlite3';

import { evaluateProactiveSuggestions, loadContextSnapshot, findMatchingTool } from '../proactive-suggestions.js';
import type { ToolRegistryRow } from '../../shared/tool-types.js';

describe('proactive-suggestions', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        classification TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE TABLE thought_branches (
        id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        arc_stage TEXT NOT NULL,
        branch_type TEXT NOT NULL,
        observation_count INTEGER NOT NULL,
        tool_pattern TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE debug_paths (
        id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE path_waypoints (
        id TEXT PRIMARY KEY,
        path_id TEXT NOT NULL,
        waypoint_type TEXT NOT NULL
      );
      CREATE TABLE tool_registry (
        name TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        source TEXT NOT NULL,
        project_hash TEXT,
        description TEXT,
        server_name TEXT,
        trigger_hints TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  describe('loadContextSnapshot', () => {
    it('loads branch and debug path context', () => {
      const projectHash = 'proj1';
      const sessionId = 'sess1';

      db.prepare(`
        INSERT INTO thought_branches (id, project_hash, session_id, arc_stage, branch_type, observation_count, tool_pattern, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('branch1', projectHash, sessionId, 'diagnosis', 'feature', 3, '{"Read":2,"Grep":1}', 'active');

      db.prepare(`
        INSERT INTO observations (id, project_hash, session_id, content, classification)
        VALUES (?, ?, ?, ?, ?)
      `).run('obs1', projectHash, sessionId, 'error found', 'problem');

      const snapshot = loadContextSnapshot(db, projectHash, sessionId);

      expect(snapshot.branch).not.toBeNull();
      expect(snapshot.branch?.arcStage).toBe('diagnosis');
      expect(snapshot.recentClassifications).toContain('problem');
    });

    it('handles missing tables gracefully', () => {
      const emptyDb = new Database(':memory:');

      const snapshot = loadContextSnapshot(emptyDb, 'proj1', 'sess1');

      expect(snapshot.branch).toBeNull();
      expect(snapshot.debugPath).toBeNull();
      expect(snapshot.recentClassifications).toEqual([]);
    });
  });

  describe('findMatchingTool', () => {
    it('matches tools by trigger hints', () => {
      const tools: ToolRegistryRow[] = [
        {
          name: 'mcp__debug__*',
          tool_type: 'mcp_server',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Debug tool',
          server_name: 'debug',
          trigger_hints: 'debugging error failure test',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const match = findMatchingTool(['debug', 'error'], tools);

      expect(match).not.toBeNull();
      expect(match?.tool.name).toBe('mcp__debug__*');
      expect(match?.relevance).toBe(1.0);
    });

    it('matches tools by description', () => {
      const tools: ToolRegistryRow[] = [
        {
          name: 'test-runner',
          tool_type: 'skill',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Runs unit tests and integration tests',
          server_name: null,
          trigger_hints: null,
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const match = findMatchingTool(['test', 'validation'], tools);

      expect(match).not.toBeNull();
      expect(match?.tool.name).toBe('test-runner');
    });

    it('returns highest relevance when multiple tools match', () => {
      const tools: ToolRegistryRow[] = [
        {
          name: 'tool1',
          tool_type: 'slash_command',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Deploy tool',
          server_name: null,
          trigger_hints: 'deployment',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          name: 'tool2',
          tool_type: 'slash_command',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Build and deploy',
          server_name: null,
          trigger_hints: 'build deployment release',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const match = findMatchingTool(['build', 'deployment', 'release'], tools);

      expect(match?.tool.name).toBe('tool2');
      expect(match?.relevance).toBe(1.0);
    });

    it('returns null when no matches exist', () => {
      const tools: ToolRegistryRow[] = [
        {
          name: 'test-tool',
          tool_type: 'mcp_server',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'A test tool',
          server_name: null,
          trigger_hints: 'testing unit',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const match = findMatchingTool(['deployment', 'kubernetes'], tools);

      expect(match).toBeNull();
    });
  });

  describe('evaluateProactiveSuggestions', () => {
    it('returns null when no context rules match', () => {
      const ctx = {
        branch: null,
        debugPath: null,
        recentClassifications: [],
      };

      const tools: ToolRegistryRow[] = [];

      const result = evaluateProactiveSuggestions(ctx, tools, 0.6);

      expect(result).toBeNull();
    });

    it('triggers on debug-session rule when in diagnosis stage with problems', () => {
      const ctx = {
        branch: {
          arcStage: 'diagnosis',
          branchType: 'feature',
          observationCount: 3,
          toolPattern: { Read: 2, Grep: 1 },
        },
        debugPath: null,
        recentClassifications: ['problem'],
      };

      const tools: ToolRegistryRow[] = [
        {
          name: 'mcp__debug__*',
          tool_type: 'mcp_server',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Debug tool',
          server_name: 'debug',
          trigger_hints: 'error tracking issue investigation systematic debugging',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const result = evaluateProactiveSuggestions(ctx, tools, 0.5);

      expect(result).not.toBeNull();
      expect(result?.toolName).toBe('mcp__debug__*');
      expect(result?.tier).toBe('proactive');
    });

    it('respects confidence threshold', () => {
      const ctx = {
        branch: {
          arcStage: 'execution',
          branchType: 'feature',
          observationCount: 10,
          toolPattern: { Edit: 5 },
        },
        debugPath: null,
        recentClassifications: ['success', 'resolution'],
      };

      const tools: ToolRegistryRow[] = [
        {
          name: 'commit-tool',
          tool_type: 'slash_command',
          scope: 'global',
          source: 'config:test',
          project_hash: null,
          description: 'Commit changes',
          server_name: null,
          trigger_hints: 'commit save changes checkpoint',
          status: 'active',
          usage_count: 0,
          last_used_at: null,
          discovered_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const resultHigh = evaluateProactiveSuggestions(ctx, tools, 0.95);
      expect(resultHigh).toBeNull();

      const resultLow = evaluateProactiveSuggestions(ctx, tools, 0.5);
      expect(resultLow).not.toBeNull();
    });
  });
});
