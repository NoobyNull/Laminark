import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the haiku-client module before importing agents
// ---------------------------------------------------------------------------

vi.mock('../haiku-client.js', () => ({
  callHaiku: vi.fn(),
  extractJsonFromResponse: vi.fn(),
}));

import { callHaiku, extractJsonFromResponse } from '../haiku-client.js';
import { extractEntitiesWithHaiku } from '../haiku-entity-agent.js';
import { inferRelationshipsWithHaiku } from '../haiku-relationship-agent.js';
import { classifyWithHaiku } from '../haiku-classifier-agent.js';

const mockCallHaiku = vi.mocked(callHaiku);
const mockExtractJson = vi.mocked(extractJsonFromResponse);

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Entity Agent Tests
// ===========================================================================

describe('extractEntitiesWithHaiku', () => {
  it('returns empty array for empty text response', async () => {
    mockCallHaiku.mockResolvedValue('[]');
    mockExtractJson.mockReturnValue([]);

    const result = await extractEntitiesWithHaiku('nothing here');
    expect(result).toEqual([]);
    expect(mockCallHaiku).toHaveBeenCalledOnce();
  });

  it('extracts File entities from Haiku response', async () => {
    const entities = [
      { name: 'src/index.ts', type: 'File', confidence: 0.95 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(entities));
    mockExtractJson.mockReturnValue(entities);

    const result = await extractEntitiesWithHaiku('Modified src/index.ts');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'src/index.ts',
      type: 'File',
      confidence: 0.95,
    });
  });

  it('extracts mixed entity types', async () => {
    const entities = [
      { name: 'src/auth.ts', type: 'File', confidence: 0.9 },
      { name: 'Use JWT tokens', type: 'Decision', confidence: 0.75 },
      { name: 'Auth bypass bug', type: 'Problem', confidence: 0.8 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(entities));
    mockExtractJson.mockReturnValue(entities);

    const result = await extractEntitiesWithHaiku('Fixed auth bypass bug in src/auth.ts by using JWT tokens');
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('File');
    expect(result[1].type).toBe('Decision');
    expect(result[2].type).toBe('Problem');
  });

  it('rejects invalid entity types via Zod validation', async () => {
    const invalidEntities = [
      { name: 'something', type: 'Unknown', confidence: 0.9 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(invalidEntities));
    mockExtractJson.mockReturnValue(invalidEntities);

    await expect(
      extractEntitiesWithHaiku('some text'),
    ).rejects.toThrow();
  });

  it('rejects entities with confidence out of range', async () => {
    const invalidEntities = [
      { name: 'src/foo.ts', type: 'File', confidence: 1.5 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(invalidEntities));
    mockExtractJson.mockReturnValue(invalidEntities);

    await expect(
      extractEntitiesWithHaiku('some text'),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Relationship Agent Tests
// ===========================================================================

describe('inferRelationshipsWithHaiku', () => {
  it('returns empty array when fewer than 2 entities provided', async () => {
    mockCallHaiku.mockResolvedValue('[]');
    mockExtractJson.mockReturnValue([]);

    const result = await inferRelationshipsWithHaiku('text', [
      { name: 'src/index.ts', type: 'File' },
    ]);
    expect(result).toEqual([]);
  });

  it('infers modifies relationship between File and Decision', async () => {
    const relationships = [
      { source: 'Use JWT', target: 'src/auth.ts', type: 'modifies', confidence: 0.85 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(relationships));
    mockExtractJson.mockReturnValue(relationships);

    const result = await inferRelationshipsWithHaiku(
      'Decided to use JWT for src/auth.ts',
      [
        { name: 'Use JWT', type: 'Decision' },
        { name: 'src/auth.ts', type: 'File' },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('modifies');
    expect(result[0].source).toBe('Use JWT');
    expect(result[0].target).toBe('src/auth.ts');
  });

  it('validates relationship types against RELATIONSHIP_TYPES', async () => {
    const relationships = [
      { source: 'a', target: 'b', type: 'references', confidence: 0.7 },
      { source: 'b', target: 'c', type: 'solved_by', confidence: 0.8 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(relationships));
    mockExtractJson.mockReturnValue(relationships);

    const result = await inferRelationshipsWithHaiku('text', [
      { name: 'a', type: 'File' },
      { name: 'b', type: 'Problem' },
      { name: 'c', type: 'Solution' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('references');
    expect(result[1].type).toBe('solved_by');
  });

  it('rejects invalid relationship types', async () => {
    const invalidRels = [
      { source: 'a', target: 'b', type: 'depends_on', confidence: 0.7 },
    ];
    mockCallHaiku.mockResolvedValue(JSON.stringify(invalidRels));
    mockExtractJson.mockReturnValue(invalidRels);

    await expect(
      inferRelationshipsWithHaiku('text', [
        { name: 'a', type: 'File' },
        { name: 'b', type: 'File' },
      ]),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Classifier Agent Tests
// ===========================================================================

describe('classifyWithHaiku', () => {
  it('classifies noise correctly', async () => {
    const classification = {
      signal: 'noise',
      classification: null,
      reason: 'build output',
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    const result = await classifyWithHaiku('npm WARN deprecated glob@7.2.3');
    expect(result.signal).toBe('noise');
    expect(result.classification).toBeNull();
    expect(result.reason).toBe('build output');
  });

  it('classifies discovery correctly', async () => {
    const classification = {
      signal: 'signal',
      classification: 'discovery',
      reason: 'new finding about API design',
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    const result = await classifyWithHaiku('Found that the REST API supports pagination via cursor tokens');
    expect(result.signal).toBe('signal');
    expect(result.classification).toBe('discovery');
  });

  it('classifies problem correctly', async () => {
    const classification = {
      signal: 'signal',
      classification: 'problem',
      reason: 'error encountered',
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    const result = await classifyWithHaiku('Error: Cannot connect to database at localhost:5432');
    expect(result.signal).toBe('signal');
    expect(result.classification).toBe('problem');
  });

  it('classifies solution correctly', async () => {
    const classification = {
      signal: 'signal',
      classification: 'solution',
      reason: 'fix applied',
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    const result = await classifyWithHaiku('Fixed by adding a null check before accessing user.id');
    expect(result.signal).toBe('signal');
    expect(result.classification).toBe('solution');
  });

  it('handles extra fields from Haiku (Zod strips them)', async () => {
    const classification = {
      signal: 'signal',
      classification: 'discovery',
      reason: 'new insight',
      extraField: 'should be stripped',
      confidence: 0.95,
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    const result = await classifyWithHaiku('Discovered that SQLite supports JSON queries natively');
    expect(result.signal).toBe('signal');
    expect(result.classification).toBe('discovery');
    // Extra fields should not be present in the result
    expect((result as Record<string, unknown>).extraField).toBeUndefined();
  });

  it('includes source context when provided', async () => {
    const classification = {
      signal: 'signal',
      classification: 'discovery',
      reason: 'meaningful read',
    };
    mockCallHaiku.mockResolvedValue(JSON.stringify(classification));
    mockExtractJson.mockReturnValue(classification);

    await classifyWithHaiku('Read interesting API docs', 'hook:Read');

    // Verify the user content includes source context
    expect(mockCallHaiku).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Source: hook:Read'),
      expect.any(Number),
    );
  });
});
