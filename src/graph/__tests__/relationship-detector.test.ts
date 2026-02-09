import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  detectRelationships,
  detectAndPersist,
} from '../relationship-detector.js';
import {
  initGraphSchema,
  upsertNode,
  insertEdge,
  getEdgesForNode,
  getNodeByNameAndType,
  countEdgesForNode,
} from '../schema.js';
import {
  enforceMaxDegree,
  validateEntityType,
  validateRelationshipType,
  mergeEntities,
  findDuplicateEntities,
  getGraphHealth,
} from '../constraints.js';
import type { EntityType } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = join(
    tmpdir(),
    `laminark-rel-test-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
  initGraphSchema(db);
  return { db, tmpDir };
}

// ---------------------------------------------------------------------------
// Relationship Detection Tests
// ---------------------------------------------------------------------------

describe('detectRelationships', () => {
  it('detects "uses" relationship between File and Tool', () => {
    const text = 'src/app.ts uses the react framework';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('uses');
    expect(candidates[0].confidence).toBeGreaterThan(0.3);
  });

  it('detects "solved_by" between Problem and Solution', () => {
    const text =
      'The authentication bug was fixed by adding token refresh';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'authentication bug', type: 'Problem' },
      { name: 'adding token refresh', type: 'Solution' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('solved_by');
  });

  it('detects "decided_by" between Decision and Person', () => {
    const text = 'Decided by @matt to use Tailwind CSS';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'use Tailwind CSS', type: 'Decision' },
      { name: '@matt', type: 'Person' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('decided_by');
  });

  it('defaults to "related_to" for ambiguous co-occurrences', () => {
    const text = 'Updated the readme and cleaned up tests';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'readme', type: 'File' },
      { name: 'tests', type: 'File' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('related_to');
    // Lower confidence for default
    expect(candidates[0].confidence).toBeLessThan(0.8);
  });

  it('does not create self-relationships', () => {
    const text = 'eslint checks eslint config';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'eslint', type: 'Tool' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(0);
  });

  it('boosts confidence for proximate entities', () => {
    // Close entities (within 50 chars)
    const closeText = 'src/app.ts uses react for rendering';
    const closeEntities: Array<{ name: string; type: EntityType }> = [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ];
    const closeCandidates = detectRelationships(closeText, closeEntities);

    // Far entities (200+ chars apart)
    const padding = ' '.repeat(200);
    const farText = `src/app.ts${padding}uses react for rendering`;
    const farEntities: Array<{ name: string; type: EntityType }> = [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ];
    const farCandidates = detectRelationships(farText, farEntities);

    expect(closeCandidates).toHaveLength(1);
    expect(farCandidates).toHaveLength(1);
    // Closer entities should have higher confidence
    expect(closeCandidates[0].confidence).toBeGreaterThan(
      farCandidates[0].confidence,
    );
  });

  it('returns empty array for less than 2 entities', () => {
    const text = 'Just one entity here: eslint';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'eslint', type: 'Tool' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(0);
  });

  it('detects "depends_on" between File and File with import language', () => {
    const text = 'src/main.ts imports from src/utils.ts for helpers';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'src/main.ts', type: 'File' },
      { name: 'src/utils.ts', type: 'File' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('depends_on');
  });

  it('detects "part_of" between Problem and File', () => {
    const text = 'There is a null pointer bug in src/auth/login.ts causing failures';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'null pointer bug', type: 'Problem' },
      { name: 'src/auth/login.ts', type: 'File' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relationshipType).toBe('part_of');
  });

  it('provides evidence snippet in candidates', () => {
    const text = 'src/app.ts uses react for rendering';
    const entities: Array<{ name: string; type: EntityType }> = [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ];
    const candidates = detectRelationships(text, entities);
    expect(candidates[0].evidence).toBeDefined();
    expect(candidates[0].evidence.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence Tests (detectAndPersist)
// ---------------------------------------------------------------------------

describe('detectAndPersist', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists detected relationships as graph edges', () => {
    // Create nodes first
    upsertNode(db, {
      type: 'File',
      name: 'src/app.ts',
      metadata: {},
      observation_ids: ['obs-1'],
    });
    upsertNode(db, {
      type: 'Tool',
      name: 'react',
      metadata: {},
      observation_ids: ['obs-1'],
    });

    const edges = detectAndPersist(db, 'src/app.ts uses react framework', [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ]);

    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0].type).toBe('uses');
  });

  it('skips candidates when nodes do not exist in graph', () => {
    // Only create one node
    upsertNode(db, {
      type: 'File',
      name: 'src/app.ts',
      metadata: {},
      observation_ids: ['obs-1'],
    });

    const edges = detectAndPersist(db, 'src/app.ts uses react framework', [
      { name: 'src/app.ts', type: 'File' },
      { name: 'react', type: 'Tool' },
    ]);

    // Should skip because 'react' node doesn't exist
    expect(edges).toHaveLength(0);
  });

  it('enforces max degree after inserting edges', () => {
    // Create a hub node and 51 satellite nodes
    const hub = upsertNode(db, {
      type: 'Tool',
      name: 'hub-tool',
      metadata: {},
      observation_ids: ['obs-hub'],
    });

    for (let i = 0; i < 51; i++) {
      const satellite = upsertNode(db, {
        type: 'File',
        name: `file-${i}.ts`,
        metadata: {},
        observation_ids: [`obs-${i}`],
      });
      insertEdge(db, {
        source_id: hub.id,
        target_id: satellite.id,
        type: 'uses',
        weight: (i + 1) / 51, // Incrementing weight
        metadata: {},
      });
    }

    // Now add one more via detectAndPersist
    const newFile = upsertNode(db, {
      type: 'File',
      name: 'new-file.ts',
      metadata: {},
      observation_ids: ['obs-new'],
    });

    detectAndPersist(db, 'hub-tool uses new-file.ts for testing', [
      { name: 'hub-tool', type: 'Tool' },
      { name: 'new-file.ts', type: 'File' },
    ]);

    // After enforcement, hub should have at most 50 edges
    const edgeCount = countEdgesForNode(db, hub.id);
    expect(edgeCount).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Constraint Enforcement Tests
// ---------------------------------------------------------------------------

describe('constraints', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateEntityType', () => {
    it('returns true for valid entity types', () => {
      expect(validateEntityType('File')).toBe(true);
      expect(validateEntityType('Tool')).toBe(true);
      expect(validateEntityType('Person')).toBe(true);
      expect(validateEntityType('Decision')).toBe(true);
      expect(validateEntityType('Problem')).toBe(true);
      expect(validateEntityType('Solution')).toBe(true);
      expect(validateEntityType('Project')).toBe(true);
    });

    it('returns false for invalid entity types', () => {
      expect(validateEntityType('Module')).toBe(false);
      expect(validateEntityType('file')).toBe(false);
      expect(validateEntityType('')).toBe(false);
      expect(validateEntityType('Concept')).toBe(false);
    });
  });

  describe('validateRelationshipType', () => {
    it('returns true for valid relationship types', () => {
      expect(validateRelationshipType('uses')).toBe(true);
      expect(validateRelationshipType('depends_on')).toBe(true);
      expect(validateRelationshipType('decided_by')).toBe(true);
      expect(validateRelationshipType('related_to')).toBe(true);
      expect(validateRelationshipType('part_of')).toBe(true);
      expect(validateRelationshipType('caused_by')).toBe(true);
      expect(validateRelationshipType('solved_by')).toBe(true);
    });

    it('returns false for invalid relationship types', () => {
      expect(validateRelationshipType('connects')).toBe(false);
      expect(validateRelationshipType('Uses')).toBe(false);
      expect(validateRelationshipType('')).toBe(false);
    });
  });

  describe('enforceMaxDegree', () => {
    it('prunes lowest-weight edges when exceeding max degree', () => {
      const node = upsertNode(db, {
        type: 'Tool',
        name: 'central-tool',
        metadata: {},
        observation_ids: ['obs-1'],
      });

      // Create 55 satellite nodes and edges with incrementing weights
      for (let i = 0; i < 55; i++) {
        const satellite = upsertNode(db, {
          type: 'File',
          name: `satellite-${i}.ts`,
          metadata: {},
          observation_ids: [`obs-s-${i}`],
        });
        insertEdge(db, {
          source_id: node.id,
          target_id: satellite.id,
          type: 'uses',
          weight: (i + 1) / 100, // 0.01, 0.02, ..., 0.55
          metadata: {},
        });
      }

      expect(countEdgesForNode(db, node.id)).toBe(55);

      const result = enforceMaxDegree(db, node.id);

      expect(result.pruned).toBe(5);
      expect(result.remaining).toBe(50);
      expect(countEdgesForNode(db, node.id)).toBe(50);

      // Verify the lowest-weight edges were removed (satellites 0-4)
      const edges = getEdgesForNode(db, node.id);
      const weights = edges.map((e) => e.weight);
      // All remaining weights should be >= 0.06 (satellite-5)
      for (const w of weights) {
        expect(w).toBeGreaterThanOrEqual(0.06);
      }
    });

    it('does nothing when under max degree', () => {
      const node = upsertNode(db, {
        type: 'Tool',
        name: 'small-tool',
        metadata: {},
        observation_ids: ['obs-1'],
      });

      for (let i = 0; i < 10; i++) {
        const satellite = upsertNode(db, {
          type: 'File',
          name: `small-${i}.ts`,
          metadata: {},
          observation_ids: [`obs-${i}`],
        });
        insertEdge(db, {
          source_id: node.id,
          target_id: satellite.id,
          type: 'uses',
          weight: 0.5,
          metadata: {},
        });
      }

      const result = enforceMaxDegree(db, node.id);
      expect(result.pruned).toBe(0);
      expect(result.remaining).toBe(10);
    });

    it('supports custom max degree', () => {
      const node = upsertNode(db, {
        type: 'Tool',
        name: 'custom-tool',
        metadata: {},
        observation_ids: ['obs-1'],
      });

      for (let i = 0; i < 10; i++) {
        const satellite = upsertNode(db, {
          type: 'File',
          name: `custom-${i}.ts`,
          metadata: {},
          observation_ids: [`obs-${i}`],
        });
        insertEdge(db, {
          source_id: node.id,
          target_id: satellite.id,
          type: 'uses',
          weight: (i + 1) / 10,
          metadata: {},
        });
      }

      const result = enforceMaxDegree(db, node.id, 5);
      expect(result.pruned).toBe(5);
      expect(result.remaining).toBe(5);
    });
  });

  describe('mergeEntities', () => {
    it('reroutes edges and deletes merged node', () => {
      // Create two nodes representing the same entity
      const keepNode = upsertNode(db, {
        type: 'Tool',
        name: 'React',
        metadata: { source: 'extraction-1' },
        observation_ids: ['obs-1'],
      });
      const mergeNode = upsertNode(db, {
        type: 'Tool',
        name: 'react',
        metadata: { source: 'extraction-2' },
        observation_ids: ['obs-2'],
      });

      // Create a satellite node with edges to both
      const satellite = upsertNode(db, {
        type: 'File',
        name: 'src/app.ts',
        metadata: {},
        observation_ids: ['obs-3'],
      });

      insertEdge(db, {
        source_id: satellite.id,
        target_id: keepNode.id,
        type: 'uses',
        weight: 0.6,
        metadata: {},
      });
      insertEdge(db, {
        source_id: satellite.id,
        target_id: mergeNode.id,
        type: 'depends_on',
        weight: 0.7,
        metadata: {},
      });

      mergeEntities(db, keepNode.id, mergeNode.id);

      // Merged node should be deleted
      const mergedLookup = getNodeByNameAndType(db, 'react', 'Tool');
      // 'react' might still exist as 'React' since keepNode was 'React'
      // The mergeNode 'react' should be gone
      const allTools = db
        .prepare('SELECT * FROM graph_nodes WHERE type = ?')
        .all('Tool');
      expect(allTools).toHaveLength(1);

      // Keep node should have merged observation_ids
      const updated = getNodeByNameAndType(db, 'React', 'Tool');
      expect(updated).not.toBeNull();
      expect(updated!.observation_ids).toContain('obs-1');
      expect(updated!.observation_ids).toContain('obs-2');

      // Edges should point to keep node
      const edges = getEdgesForNode(db, keepNode.id);
      expect(edges.length).toBeGreaterThanOrEqual(1);
    });

    it('handles duplicate edge conflicts by keeping higher weight', () => {
      const keepNode = upsertNode(db, {
        type: 'Tool',
        name: 'TypeScript',
        metadata: {},
        observation_ids: ['obs-1'],
      });
      const mergeNode = upsertNode(db, {
        type: 'Tool',
        name: 'typescript',
        metadata: {},
        observation_ids: ['obs-2'],
      });
      const file = upsertNode(db, {
        type: 'File',
        name: 'src/index.ts',
        metadata: {},
        observation_ids: ['obs-3'],
      });

      // Both have 'uses' edge from the same file
      insertEdge(db, {
        source_id: file.id,
        target_id: keepNode.id,
        type: 'uses',
        weight: 0.5,
        metadata: {},
      });
      insertEdge(db, {
        source_id: file.id,
        target_id: mergeNode.id,
        type: 'uses',
        weight: 0.8,
        metadata: {},
      });

      mergeEntities(db, keepNode.id, mergeNode.id);

      // Should have one edge with the higher weight
      const edges = getEdgesForNode(db, keepNode.id);
      const usesEdge = edges.find(
        (e) => e.source_id === file.id && e.type === 'uses',
      );
      expect(usesEdge).toBeDefined();
      expect(usesEdge!.weight).toBe(0.8);
    });
  });

  describe('findDuplicateEntities', () => {
    it('detects case-insensitive name duplicates', () => {
      upsertNode(db, {
        type: 'Tool',
        name: 'React',
        metadata: {},
        observation_ids: ['obs-1'],
      });
      upsertNode(db, {
        type: 'Tool',
        name: 'react',
        metadata: {},
        observation_ids: ['obs-2'],
      });

      const dupes = findDuplicateEntities(db);
      expect(dupes.length).toBeGreaterThanOrEqual(1);

      const reactDupe = dupes.find((d) =>
        d.entities.some((e) => e.name === 'React') &&
        d.entities.some((e) => e.name === 'react'),
      );
      expect(reactDupe).toBeDefined();
      expect(reactDupe!.reason.toLowerCase()).toContain('case');
    });

    it('detects common abbreviation duplicates', () => {
      upsertNode(db, {
        type: 'Tool',
        name: 'TypeScript',
        metadata: {},
        observation_ids: ['obs-1'],
      });
      upsertNode(db, {
        type: 'Tool',
        name: 'TS',
        metadata: {},
        observation_ids: ['obs-2'],
      });

      const dupes = findDuplicateEntities(db);
      const tsDupe = dupes.find((d) =>
        d.entities.some((e) => e.name === 'TypeScript') &&
        d.entities.some((e) => e.name === 'TS'),
      );
      expect(tsDupe).toBeDefined();
      expect(tsDupe!.reason).toContain('abbreviation');
    });

    it('filters by entity type when specified', () => {
      upsertNode(db, {
        type: 'Tool',
        name: 'React',
        metadata: {},
        observation_ids: ['obs-1'],
      });
      upsertNode(db, {
        type: 'Tool',
        name: 'react',
        metadata: {},
        observation_ids: ['obs-2'],
      });
      upsertNode(db, {
        type: 'File',
        name: 'readme',
        metadata: {},
        observation_ids: ['obs-3'],
      });
      upsertNode(db, {
        type: 'File',
        name: 'README',
        metadata: {},
        observation_ids: ['obs-4'],
      });

      const toolDupes = findDuplicateEntities(db, { type: 'Tool' });
      expect(toolDupes.length).toBeGreaterThanOrEqual(1);
      // All dupes should be Tool type only
      for (const group of toolDupes) {
        for (const entity of group.entities) {
          expect(entity.type).toBe('Tool');
        }
      }
    });
  });

  describe('getGraphHealth', () => {
    it('returns accurate graph health metrics', () => {
      const node1 = upsertNode(db, {
        type: 'Tool',
        name: 'react',
        metadata: {},
        observation_ids: ['obs-1'],
      });
      const node2 = upsertNode(db, {
        type: 'File',
        name: 'src/app.ts',
        metadata: {},
        observation_ids: ['obs-2'],
      });
      const node3 = upsertNode(db, {
        type: 'Person',
        name: '@alice',
        metadata: {},
        observation_ids: ['obs-3'],
      });

      insertEdge(db, {
        source_id: node2.id,
        target_id: node1.id,
        type: 'uses',
        weight: 0.8,
        metadata: {},
      });
      insertEdge(db, {
        source_id: node2.id,
        target_id: node3.id,
        type: 'related_to',
        weight: 0.5,
        metadata: {},
      });

      const health = getGraphHealth(db);
      expect(health.totalNodes).toBe(3);
      expect(health.totalEdges).toBe(2);
      expect(health.avgDegree).toBeCloseTo(4 / 3, 1); // (2+2+0)/3 -- node2 has 2 edges
      expect(health.hotspots).toHaveLength(0); // No nodes near limit
      expect(health.duplicateCandidates).toBeGreaterThanOrEqual(0);
    });

    it('identifies hotspot nodes approaching degree limit', () => {
      const hub = upsertNode(db, {
        type: 'Tool',
        name: 'hub-tool',
        metadata: {},
        observation_ids: ['obs-1'],
      });

      // Create 42 edges (> 0.8 * 50 = 40)
      for (let i = 0; i < 42; i++) {
        const satellite = upsertNode(db, {
          type: 'File',
          name: `hotspot-${i}.ts`,
          metadata: {},
          observation_ids: [`obs-${i}`],
        });
        insertEdge(db, {
          source_id: hub.id,
          target_id: satellite.id,
          type: 'uses',
          weight: 0.5,
          metadata: {},
        });
      }

      const health = getGraphHealth(db);
      expect(health.hotspots.length).toBeGreaterThanOrEqual(1);
      const hubHotspot = health.hotspots.find(
        (h) => h.node.name === 'hub-tool',
      );
      expect(hubHotspot).toBeDefined();
      expect(hubHotspot!.degree).toBe(42);
    });
  });
});
