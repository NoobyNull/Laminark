import { describe, it, expect, vi } from 'vitest';

import { handleStashCommand } from '../stash.js';
import type { StashManager } from '../../storage/stash-manager.js';
import type { ObservationRepository } from '../../storage/observations.js';
import type { Observation } from '../../shared/types.js';
import type { CreateStashInput } from '../../types/stash.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockStashManager(): StashManager & {
  createStash: ReturnType<typeof vi.fn>;
} {
  return {
    createStash: vi.fn().mockImplementation((input: CreateStashInput) => ({
      id: 'stash-001',
      projectId: input.projectId,
      sessionId: input.sessionId,
      topicLabel: input.topicLabel,
      summary: input.summary,
      observationIds: input.observations.map((o) => o.id),
      observationSnapshots: input.observations,
      createdAt: '2026-02-09T00:00:00Z',
      resumedAt: null,
      status: 'stashed',
    })) as ReturnType<typeof vi.fn>,
    listStashes: vi.fn().mockReturnValue([]),
    getStash: vi.fn().mockReturnValue(null),
    resumeStash: vi.fn(),
    deleteStash: vi.fn(),
    getRecentStashes: vi.fn().mockReturnValue([]),
  } as unknown as StashManager & { createStash: ReturnType<typeof vi.fn> };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    rowid: 1,
    id: 'obs-001',
    projectHash: 'proj-hash',
    content: 'Some test observation content',
    title: null,
    source: 'hook:Write',
    sessionId: 'sess-001',
    embedding: new Float32Array([1, 0, 0]),
    embeddingModel: 'test-model',
    embeddingVersion: '1',
    createdAt: '2026-02-09T00:01:00Z',
    updatedAt: '2026-02-09T00:01:00Z',
    deletedAt: null,
    ...overrides,
  };
}

function createMockObservationStore(
  observations: Observation[] = [],
): ObservationRepository & { list: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn().mockReturnValue(observations),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    restore: vi.fn(),
    count: vi.fn(),
  } as unknown as ObservationRepository & { list: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// handleStashCommand tests
// ---------------------------------------------------------------------------

describe('handleStashCommand', () => {
  it('returns failure when no observations in session', async () => {
    const stashManager = createMockStashManager();
    const observationStore = createMockObservationStore([]);

    const result = await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001' },
      { stashManager, observationStore },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('No observations in current session to stash.');
    expect(stashManager.createStash).not.toHaveBeenCalled();
  });

  it('creates stash with user-provided label', async () => {
    const stashManager = createMockStashManager();
    const observations = [
      makeObservation({ id: 'obs-1', content: 'Auth work' }),
    ];
    const observationStore = createMockObservationStore(observations);

    const result = await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001', label: 'Auth implementation' },
      { stashManager, observationStore },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Auth implementation');
    expect(result.message).toContain('/laminark:resume');

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    expect(stashInput.topicLabel).toBe('Auth implementation');
  });

  it('auto-generates label from oldest observation when no label provided', async () => {
    const stashManager = createMockStashManager();
    const observations = [
      makeObservation({
        id: 'obs-2',
        content: 'Second observation about routing',
        createdAt: '2026-02-09T00:01:00Z',
      }),
      makeObservation({
        id: 'obs-1',
        content: 'Initial setup of the Express server with middleware',
        createdAt: '2026-02-09T00:00:00Z',
      }),
    ];
    const observationStore = createMockObservationStore(observations);

    const result = await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001' },
      { stashManager, observationStore },
    );

    expect(result.success).toBe(true);

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    // Label from oldest observation (last in DESC list), up to 80 chars
    expect(stashInput.topicLabel).toBe('Initial setup of the Express server with middleware');
  });

  it('creates observation snapshots with correct fields', async () => {
    const stashManager = createMockStashManager();
    const observations = [
      makeObservation({
        id: 'obs-1',
        content: 'Test content',
        source: 'hook:Read',
        createdAt: '2026-02-09T00:00:00Z',
        embedding: new Float32Array([0.5, 0.5, 0]),
      }),
    ];
    const observationStore = createMockObservationStore(observations);

    await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001', label: 'test' },
      { stashManager, observationStore },
    );

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    expect(stashInput.observations).toHaveLength(1);
    expect(stashInput.observations[0]).toEqual({
      id: 'obs-1',
      content: 'Test content',
      type: 'hook:Read',
      timestamp: '2026-02-09T00:00:00Z',
      embedding: [0.5, 0.5, 0],
    });
  });

  it('passes correct projectId and sessionId to stash', async () => {
    const stashManager = createMockStashManager();
    const observations = [makeObservation()];
    const observationStore = createMockObservationStore(observations);

    await handleStashCommand(
      { projectId: 'my-project', sessionId: 'my-session', label: 'test' },
      { stashManager, observationStore },
    );

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    expect(stashInput.projectId).toBe('my-project');
    expect(stashInput.sessionId).toBe('my-session');
  });

  it('queries observations for the correct session', async () => {
    const stashManager = createMockStashManager();
    const observationStore = createMockObservationStore([]);

    await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'target-session' },
      { stashManager, observationStore },
    );

    expect(observationStore.list).toHaveBeenCalledWith({
      sessionId: 'target-session',
      limit: 20,
    });
  });

  it('generates summary from up to 3 oldest observations', async () => {
    const stashManager = createMockStashManager();
    const observations = [
      makeObservation({ id: 'obs-4', content: 'Fourth', createdAt: '2026-02-09T00:03:00Z' }),
      makeObservation({ id: 'obs-3', content: 'Third', createdAt: '2026-02-09T00:02:00Z' }),
      makeObservation({ id: 'obs-2', content: 'Second', createdAt: '2026-02-09T00:01:00Z' }),
      makeObservation({ id: 'obs-1', content: 'First', createdAt: '2026-02-09T00:00:00Z' }),
    ];
    const observationStore = createMockObservationStore(observations);

    await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001', label: 'test' },
      { stashManager, observationStore },
    );

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    // Summary from 3 oldest: obs-1, obs-2, obs-3
    expect(stashInput.summary).toContain('First');
    expect(stashInput.summary).toContain('Second');
    expect(stashInput.summary).toContain('Third');
    expect(stashInput.summary).not.toContain('Fourth');
  });

  it('handles observations without embeddings in snapshots', async () => {
    const stashManager = createMockStashManager();
    const observations = [
      makeObservation({ id: 'obs-1', embedding: null }),
    ];
    const observationStore = createMockObservationStore(observations);

    await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001', label: 'test' },
      { stashManager, observationStore },
    );

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    expect(stashInput.observations[0].embedding).toBeNull();
  });

  it('confirmation message wraps topic label in quotes', async () => {
    const stashManager = createMockStashManager();
    const observations = [makeObservation()];
    const observationStore = createMockObservationStore(observations);

    const result = await handleStashCommand(
      { projectId: 'proj-001', sessionId: 'sess-001', label: 'My Topic' },
      { stashManager, observationStore },
    );

    expect(result.message).toBe('Context stashed: "My Topic". Use /laminark:resume to return to it.');
  });
});
