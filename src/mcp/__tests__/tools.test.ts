import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { SearchEngine } from '../../storage/search.js';
import { generateTitle } from '../tools/save-memory.js';
import { createServer } from '../server.js';
import { registerSaveMemory } from '../tools/save-memory.js';
import { registerRecall } from '../tools/recall.js';
import {
  enforceTokenBudget,
  estimateTokens,
  FULL_VIEW_BUDGET,
  TOKEN_BUDGET,
} from '../token-budget.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

let tmp: string;
let config: DatabaseConfig;
let ldb: LaminarkDatabase;
let repo: ObservationRepository;
let search: SearchEngine;
const PROJECT_HASH = 'test_project_hash';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'laminark-tools-test-'));
  config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
  ldb = openDatabase(config);
  repo = new ObservationRepository(ldb.db, PROJECT_HASH);
  search = new SearchEngine(ldb.db, PROJECT_HASH);
});

afterEach(() => {
  try {
    ldb?.close();
  } catch {
    // already closed
  }
  rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// SC-1: Keyword search returns ranked results
// =============================================================================

describe('SC-1: keyword search', () => {
  it('returns BM25-ranked results for keyword query', () => {
    repo.create({
      content: 'TypeScript compiler options for strict mode',
      title: 'TypeScript compiler',
    });
    repo.create({
      content: 'Python web framework with Django and Flask',
      title: 'Python web',
    });
    repo.create({
      content: 'TypeScript type inference and generics patterns',
      title: 'TypeScript types',
    });

    const results = search.searchKeyword('TypeScript');

    expect(results).toHaveLength(2);
    expect(results[0].observation.content).toContain('TypeScript');
    expect(results[1].observation.content).toContain('TypeScript');
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[1].score).toBeGreaterThan(0);
    // Results sorted by relevance (score descending)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('searches both title and content', () => {
    repo.create({
      content: 'We decided to use JWT for session management',
      title: 'Auth decisions',
    });

    // Title match
    const titleResults = search.searchKeyword('Auth');
    expect(titleResults).toHaveLength(1);

    // Content match
    const contentResults = search.searchKeyword('JWT');
    expect(contentResults).toHaveLength(1);
  });

  it('returns empty array for no matches', () => {
    repo.create({
      content: 'Something about databases',
      title: 'Database notes',
    });

    const results = search.searchKeyword('kubernetes');
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      repo.create({
        content: `Test observation about search quality ${i}`,
        title: `Test ${i}`,
      });
    }

    const results = search.searchKeyword('search', { limit: 2 });
    expect(results).toHaveLength(2);
  });
});

// =============================================================================
// SC-2: save_memory persists with title
// =============================================================================

describe('SC-2: save_memory', () => {
  it('saves observation with user-provided title', () => {
    const obs = repo.create({
      content: 'Some text about the project architecture',
      title: 'My Title',
      source: 'manual',
    });

    expect(obs.title).toBe('My Title');

    const fetched = repo.getById(obs.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('My Title');
  });

  it('accepts null title (auto-title applied at tool level)', () => {
    const obs = repo.create({
      content: 'Some text without explicit title',
      source: 'manual',
    });

    // Title is null in DB since title generation happens in tool handler, not repo
    expect(obs.title).toBeNull();
  });

  describe('generateTitle', () => {
    it('extracts first sentence for short text', () => {
      expect(generateTitle('Hello world. More text.')).toBe('Hello world.');
    });

    it('returns full text when under 80 chars', () => {
      expect(generateTitle('Short text')).toBe('Short text');
    });

    it('truncates at 80 chars with ellipsis for long text', () => {
      const longText = 'A'.repeat(200);
      const result = generateTitle(longText);
      expect(result).toBe('A'.repeat(80) + '...');
    });

    it('handles text with no sentence boundary', () => {
      const noSentence = 'B'.repeat(200);
      const result = generateTitle(noSentence);
      expect(result.length).toBe(83); // 80 + '...'
      expect(result.endsWith('...')).toBe(true);
    });
  });
});

// =============================================================================
// SC-3: Purge/restore
// =============================================================================

describe('SC-3: purge and restore', () => {
  it('purge soft-deletes: memory disappears from normal search', () => {
    const obs = repo.create({
      content: 'unique_test_word_alpha in this observation',
      title: 'Unique test',
    });

    // Before purge: found in search
    const before = search.searchKeyword('unique_test_word_alpha');
    expect(before).toHaveLength(1);

    // Purge
    const deleted = repo.softDelete(obs.id);
    expect(deleted).toBe(true);

    // After purge: not found in search
    const after = search.searchKeyword('unique_test_word_alpha');
    expect(after).toHaveLength(0);
  });

  it('purged memory still exists in database', () => {
    const obs = repo.create({
      content: 'Memory that will be purged',
      title: 'Purged item',
    });
    repo.softDelete(obs.id);

    const found = repo.getByIdIncludingDeleted(obs.id);
    expect(found).not.toBeNull();
    expect(found!.deletedAt).not.toBeNull();
  });

  it('restore un-deletes: memory reappears in search', () => {
    const obs = repo.create({
      content: 'unique_restore_word_beta in this text',
      title: 'Restore test',
    });
    repo.softDelete(obs.id);

    // Confirm gone from search
    expect(search.searchKeyword('unique_restore_word_beta')).toHaveLength(0);

    // Restore
    const restored = repo.restore(obs.id);
    expect(restored).toBe(true);

    // Reappears in search
    const results = search.searchKeyword('unique_restore_word_beta');
    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe(obs.id);
  });

  it('softDelete returns false for non-existent ID', () => {
    const result = repo.softDelete('nonexistent_id_xyz');
    expect(result).toBe(false);
  });

  it('include_purged finds soft-deleted items', () => {
    const obs = repo.create({
      content: 'Item to be soft-deleted and listed',
      title: 'Listed purge',
    });
    repo.softDelete(obs.id);

    // Normal list excludes it
    const normalList = repo.list();
    expect(normalList.find((o) => o.id === obs.id)).toBeUndefined();

    // Including deleted finds it
    const allList = repo.listIncludingDeleted();
    const found = allList.find((o) => o.id === obs.id);
    expect(found).toBeDefined();
    expect(found!.deletedAt).not.toBeNull();
  });
});

// =============================================================================
// SC-4: Progressive disclosure and token budget
// =============================================================================

describe('SC-4: progressive disclosure and token budget', () => {
  it('compact format returns expected fields', () => {
    const obs = repo.create({
      content: 'Content about progressive disclosure formatting',
      title: 'Compact Test',
    });

    // Simulate compact formatting (same logic as recall tool)
    const idShort = obs.id.slice(0, 8);
    const title = obs.title ?? 'untitled';
    const date = obs.createdAt.slice(0, 10);
    const snippet = obs.content.replace(/\n/g, ' ').slice(0, 100);
    const compact = `[1] ${idShort} | ${title} | - | ${snippet} | ${date}`;

    expect(compact).toContain(idShort);
    expect(compact).toContain('Compact Test');
    expect(compact).toContain(date);
    expect(compact).toContain('progressive disclosure');
  });

  it('search results respect 2000 token budget', () => {
    // Insert 50 observations with substantial content matching "budget"
    // Each compact line is ~140 chars (~35 tokens); 50 items would be ~1750 tokens.
    // Use full-view format (~400 chars per item = ~100 tokens each) to guarantee budget overflow.
    const longContent = 'budget '.repeat(60);
    for (let i = 0; i < 50; i++) {
      repo.create({
        content: `${longContent} observation ${i}`,
        title: `Budget item ${i} - extended title for token budget testing`,
      });
    }

    const results = search.searchKeyword('budget', { limit: 50 });

    // Format with full content (simulating full view) to exceed budget
    const budgetResult = enforceTokenBudget(
      results.map((r) => r.observation),
      (obs) =>
        `--- ${obs.id.slice(0, 8)} | ${obs.title} | ${obs.createdAt} ---\n${obs.content}`,
      TOKEN_BUDGET,
    );

    // Should be truncated given 50 items with substantial content
    expect(budgetResult.truncated).toBe(true);
    expect(budgetResult.items.length).toBeLessThan(50);
    expect(budgetResult.tokenEstimate).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it('large result sets report truncation', () => {
    const longContent = 'truncation '.repeat(50);
    for (let i = 0; i < 30; i++) {
      repo.create({
        content: `${longContent} item ${i}`,
        title: `Truncation test ${i}`,
      });
    }

    const results = search.searchKeyword('truncation', { limit: 30 });
    const budgetResult = enforceTokenBudget(
      results.map((r) => r.observation),
      (obs) =>
        `--- ${obs.id.slice(0, 8)} | ${obs.title} | ${obs.createdAt} ---\n${obs.content}`,
      TOKEN_BUDGET,
    );

    expect(budgetResult.truncated).toBe(true);
  });

  it('single-item full view allows up to FULL_VIEW_BUDGET tokens', () => {
    // Create an observation with ~3000 tokens of content (12000 chars)
    const largeContent = 'A'.repeat(12000);
    const obs = repo.create({
      content: largeContent,
      title: 'Large observation',
    });

    // Format as full view
    const formatted = `--- ${obs.id.slice(0, 8)} | ${obs.title} | ${obs.createdAt} ---\n${obs.content}`;
    const tokens = estimateTokens(formatted);

    // ~3000 tokens should fit within FULL_VIEW_BUDGET (4000)
    expect(tokens).toBeLessThanOrEqual(FULL_VIEW_BUDGET);
    expect(tokens).toBeGreaterThan(TOKEN_BUDGET); // Exceeds compact budget
  });
});

// =============================================================================
// SC-5: Tool discoverability
// =============================================================================

describe('SC-5: tool discoverability', () => {
  it('MCP server registers both save_memory and recall tools', () => {
    const server = createServer();

    // Registration should not throw
    expect(() => {
      registerSaveMemory(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();

    expect(() => {
      registerRecall(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();
  });

  it('.mcp.json exists and is valid', () => {
    // Read .mcp.json from project root
    const manifestPath = join(__dirname, '..', '..', '..', '.mcp.json');
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    // Verify structure
    expect(manifest).toHaveProperty('laminark');
    expect(manifest.laminark.command).toBe('npx');
    expect(manifest.laminark.args).toContain('tsx');
    expect(manifest.laminark.args).toContain('src/index.ts');
  });
});
