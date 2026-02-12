import { describe, it, expect, beforeEach, vi } from 'vitest';

import { TopicShiftHandler } from '../topic-shift-handler.js';
import type { TopicShiftDetector, TopicShiftResult } from '../../intelligence/topic-detector.js';
import type { StashManager } from '../../storage/stash-manager.js';
import type { ObservationRepository } from '../../storage/observations.js';
import type { Observation } from '../../shared/types.js';
import type { ContextStash, CreateStashInput } from '../../types/stash.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDetector(overrides?: Partial<TopicShiftDetector>): TopicShiftDetector {
  return {
    detect: vi.fn().mockReturnValue({
      shifted: false,
      distance: 0.1,
      threshold: 0.3,
      confidence: 0,
      previousEmbedding: null,
      currentEmbedding: [1, 0, 0],
    } satisfies TopicShiftResult),
    reset: vi.fn(),
    getThreshold: vi.fn().mockReturnValue(0.3),
    setThreshold: vi.fn(),
    ...overrides,
  } as unknown as TopicShiftDetector;
}

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

function makeObservation(
  overrides: Partial<Observation> = {},
): Observation {
  return {
    rowid: 1,
    id: 'obs-001',
    projectHash: 'proj-hash',
    content: 'Some observation content for testing',
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

// ---------------------------------------------------------------------------
// TopicShiftHandler tests
// ---------------------------------------------------------------------------

describe('TopicShiftHandler', () => {
  let detector: TopicShiftDetector;
  let stashManager: ReturnType<typeof createMockStashManager>;
  let observationStore: ReturnType<typeof createMockObservationStore>;
  let handler: TopicShiftHandler;

  beforeEach(() => {
    detector = createMockDetector();
    stashManager = createMockStashManager();
    observationStore = createMockObservationStore();
    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });
  });

  it('skips detection when observation has no embedding', async () => {
    const obs = makeObservation({ embedding: null });

    const result = await handler.handleObservation(obs, 'sess-001', 'proj-001');

    expect(result.stashed).toBe(false);
    expect(result.notification).toBeNull();
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('returns no-op when no topic shift detected (low distance)', async () => {
    const obs = makeObservation({ embedding: new Float32Array([1, 0, 0]) });

    // Default mock returns shifted: false
    const result = await handler.handleObservation(obs, 'sess-001', 'proj-001');

    expect(result.stashed).toBe(false);
    expect(result.notification).toBeNull();
    expect(detector.detect).toHaveBeenCalledWith([1, 0, 0]);
    expect(stashManager.createStash).not.toHaveBeenCalled();
  });

  it('triggers stash creation on topic shift (high distance)', async () => {
    // Setup: detector reports a shift
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.8,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    // Setup: previous observations in the session
    const prevObs = [
      makeObservation({
        id: 'prev-2',
        content: 'Working on authentication module',
        createdAt: '2026-02-09T00:00:30Z',
      }),
      makeObservation({
        id: 'prev-1',
        content: 'Initial project setup and configuration',
        createdAt: '2026-02-09T00:00:00Z',
      }),
    ];
    observationStore = createMockObservationStore(prevObs);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    const result = await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    expect(result.stashed).toBe(true);
    expect(result.notification).toContain('Topic shift detected');
    expect(result.notification).toContain('/laminark:resume');
    expect(stashManager.createStash).toHaveBeenCalledOnce();
  });

  it('notification message includes topic label', async () => {
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.7,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 0, 1],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    const prevObs = [
      makeObservation({
        id: 'prev-1',
        content: 'Building the user authentication system with JWT tokens',
        createdAt: '2026-02-09T00:00:00Z',
      }),
    ];
    observationStore = createMockObservationStore(prevObs);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 0, 1]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    const result = await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    expect(result.notification).toContain('Building the user authentication system with JWT t');
    expect(result.notification).toContain('/laminark:resume');
  });

  it('gathers previous observations correctly for stash snapshot', async () => {
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.9,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    const prevObs = [
      makeObservation({
        id: 'obs-3',
        content: 'Third observation about auth',
        createdAt: '2026-02-09T00:00:30Z',
        embedding: new Float32Array([0.9, 0.1, 0]),
      }),
      makeObservation({
        id: 'obs-2',
        content: 'Second observation about auth',
        createdAt: '2026-02-09T00:00:15Z',
        embedding: new Float32Array([0.8, 0.2, 0]),
      }),
      makeObservation({
        id: 'obs-1',
        content: 'First observation about auth setup',
        createdAt: '2026-02-09T00:00:00Z',
        embedding: new Float32Array([1, 0, 0]),
      }),
    ];
    observationStore = createMockObservationStore(prevObs);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    expect(stashManager.createStash).toHaveBeenCalledOnce();
    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;

    // All 3 previous observations should be included
    expect(stashInput.observations).toHaveLength(3);
    expect(stashInput.observations.map((o) => o.id)).toEqual([
      'obs-3',
      'obs-2',
      'obs-1',
    ]);
    expect(stashInput.projectId).toBe('proj-001');
    expect(stashInput.sessionId).toBe('sess-001');
  });

  it('generates summary from first 3 observations truncated to 200 chars', async () => {
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.8,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    // Create observations with known content
    const prevObs = [
      makeObservation({
        id: 'obs-3',
        content: 'Third observation',
        createdAt: '2026-02-09T00:00:30Z',
      }),
      makeObservation({
        id: 'obs-2',
        content: 'Second observation',
        createdAt: '2026-02-09T00:00:15Z',
      }),
      makeObservation({
        id: 'obs-1',
        content: 'First observation',
        createdAt: '2026-02-09T00:00:00Z',
      }),
    ];
    observationStore = createMockObservationStore(prevObs);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;

    // Summary should contain oldest 3 observations joined by " | "
    expect(stashInput.summary).toContain('First observation');
    expect(stashInput.summary).toContain('Second observation');
    expect(stashInput.summary).toContain('Third observation');
    expect(stashInput.summary.length).toBeLessThanOrEqual(200);
  });

  it('skips stash when no previous observations exist (session start)', async () => {
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.8,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    // No previous observations (clean context / session start)
    observationStore = createMockObservationStore([]);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    const result = await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    // Nothing to stash at session start -- no empty stashes
    expect(result.stashed).toBe(false);
    expect(result.notification).toBeNull();
    expect(stashManager.createStash).not.toHaveBeenCalled();
  });

  it('passes observation list query with correct sessionId', async () => {
    // Must trigger a shift so list() is called
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.8,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });
    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    await handler.handleObservation(currentObs, 'sess-xyz', 'proj-001');

    expect(observationStore.list).toHaveBeenCalledWith({
      sessionId: 'sess-xyz',
      limit: 20,
      includeUnclassified: true,
    });
  });

  it('converts Float32Array embedding to number[] for detector', async () => {
    const embedding = new Float32Array([0.5, 0.3, 0.7]);
    const obs = makeObservation({ embedding });

    await handler.handleObservation(obs, 'sess-001', 'proj-001');

    expect(detector.detect).toHaveBeenCalledWith([0.5, 0.30000001192092896, 0.699999988079071]);
  });

  it('stash observation snapshots include embedding as number[]', async () => {
    const shiftResult: TopicShiftResult = {
      shifted: true,
      distance: 0.8,
      threshold: 0.3,
      confidence: 1.0,
      previousEmbedding: [1, 0, 0],
      currentEmbedding: [0, 1, 0],
    };
    detector = createMockDetector({
      detect: vi.fn().mockReturnValue(shiftResult) as TopicShiftDetector['detect'],
    });

    const prevObs = [
      makeObservation({
        id: 'obs-1',
        content: 'Previous topic content',
        createdAt: '2026-02-09T00:00:00Z',
        embedding: new Float32Array([1, 0, 0]),
      }),
    ];
    observationStore = createMockObservationStore(prevObs);

    handler = new TopicShiftHandler({
      detector,
      stashManager,
      observationStore,
    });

    const currentObs = makeObservation({
      id: 'current-1',
      embedding: new Float32Array([0, 1, 0]),
      createdAt: '2026-02-09T00:01:00Z',
    });

    await handler.handleObservation(currentObs, 'sess-001', 'proj-001');

    const stashInput = stashManager.createStash.mock.calls[0][0] as CreateStashInput;
    expect(stashInput.observations[0].embedding).toEqual([1, 0, 0]);
    expect(Array.isArray(stashInput.observations[0].embedding)).toBe(true);
  });
});
