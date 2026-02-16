/**
 * BranchTracker — state machine for automatic thought branch detection.
 *
 * Consumes observations from the HaikuProcessor pipeline and manages
 * the lifecycle of thought branches. Detects boundaries via:
 *   - Topic shifts (from TopicShiftHandler)
 *   - Project hash changes
 *   - Session changes
 *   - Time gaps (>15 min between observations)
 *   - Manual starts
 *
 * Lives in the MCP server process and maintains in-memory state.
 * Persists branches and observations via BranchRepository.
 */

import type { BranchRepository } from './branch-repository.js';
import type { ArcStage, TriggerSource } from './types.js';
import { inferArcStage, primeFromRegistry } from './arc-detector.js';
import {
  classifyBranchWithHaiku,
  summarizeBranchWithHaiku,
} from './branch-classifier-agent.js';
import { isHaikuEnabled } from '../intelligence/haiku-client.js';
import { ObservationRepository } from '../storage/observations.js';
import { debug } from '../shared/debug.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_GAP_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrackerState = 'idle' | 'tracking';

export interface BranchObservationInput {
  id: string;
  content: string;
  source: string;
  projectHash: string;
  sessionId?: string | null;
  classification?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// BranchTracker
// ---------------------------------------------------------------------------

export class BranchTracker {
  private state: TrackerState = 'idle';
  private activeBranchId: string | null = null;
  private activeProjectHash: string | null = null;
  private activeSessionId: string | null = null;
  private lastObservationTime: number = 0;
  private toolPattern: Record<string, number> = {};

  private readonly repo: BranchRepository;
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  constructor(repo: BranchRepository, db: BetterSqlite3.Database, projectHash: string) {
    this.repo = repo;
    this.db = db;
    this.projectHash = projectHash;

    // Prime arc detector cache from tool registry descriptions
    primeFromRegistry(db, projectHash);

    // Recover state from DB on startup
    const activeBranch = repo.findRecentActiveBranch();
    if (activeBranch) {
      this.state = 'tracking';
      this.activeBranchId = activeBranch.id;
      this.activeProjectHash = activeBranch.project_hash;
      this.activeSessionId = activeBranch.session_id;
      this.toolPattern = activeBranch.tool_pattern;
      this.lastObservationTime = new Date(activeBranch.started_at).getTime();
      debug('branches', 'Recovered active branch from DB', { branchId: activeBranch.id });
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Process a new observation through the boundary detection state machine.
   * Called from HaikuProcessor after classification (Step 1.6).
   */
  processObservation(obs: BranchObservationInput): void {
    const now = Date.now();
    const obsTime = new Date(obs.createdAt).getTime();
    const toolName = this.extractToolName(obs.source);

    // Check for boundary signals
    const boundary = this.detectBoundary(obs, obsTime);

    if (boundary) {
      // Complete current branch if tracking
      if (this.state === 'tracking' && this.activeBranchId) {
        this.completeBranch();
      }

      // Start new branch
      this.startBranch(boundary, obs);
    } else if (this.state === 'idle') {
      // First observation — start tracking
      this.startBranch('session_start', obs);
    }

    // Add observation to active branch
    if (this.activeBranchId) {
      const arcStage = inferArcStage(this.toolPattern, obs.classification);

      // Update tool pattern
      if (toolName) {
        this.toolPattern[toolName] = (this.toolPattern[toolName] ?? 0) + 1;
        this.repo.updateToolPattern(this.activeBranchId, this.toolPattern);
      }

      // Add observation
      this.repo.addObservation(
        this.activeBranchId,
        obs.id,
        toolName,
        arcStage,
      );

      // Update arc stage
      const newStage = inferArcStage(this.toolPattern, obs.classification);
      this.repo.updateArcStage(this.activeBranchId, newStage);
    }

    this.lastObservationTime = obsTime || now;
    this.activeProjectHash = obs.projectHash;
    this.activeSessionId = obs.sessionId ?? this.activeSessionId;
  }

  /**
   * Notify the tracker of a topic shift (from TopicShiftHandler).
   */
  onTopicShift(observationId: string): void {
    if (this.state === 'tracking' && this.activeBranchId) {
      this.completeBranch();
      // Start new branch with topic_shift trigger will happen on next observation
      debug('branches', 'Topic shift boundary detected', { observationId });
    }
  }

  /**
   * Link the active branch to a debug path (when PathTracker activates).
   */
  linkDebugPath(debugPathId: string): void {
    if (this.activeBranchId) {
      this.repo.linkDebugPath(this.activeBranchId, debugPathId);
      debug('branches', 'Linked debug path to branch', {
        branchId: this.activeBranchId,
        debugPathId,
      });
    }
  }

  /**
   * Get the active branch ID (for external callers).
   */
  getActiveBranchId(): string | null {
    return this.activeBranchId;
  }

  // ===========================================================================
  // Maintenance (called from HaikuProcessor Step 4)
  // ===========================================================================

  /**
   * Run periodic maintenance tasks:
   * - Classify branches with 3+ observations via Haiku
   * - Generate summaries for recently completed branches
   * - Auto-abandon stale branches (>24h)
   * - Link branches to debug paths
   */
  async runMaintenance(): Promise<void> {
    try {
      // Re-prime arc detector from registry (no-ops if registry unchanged)
      primeFromRegistry(this.db, this.projectHash);

      // Auto-abandon stale branches
      const stale = this.repo.findStaleBranches();
      for (const branch of stale) {
        this.repo.abandonBranch(branch.id);
        if (this.activeBranchId === branch.id) {
          this.state = 'idle';
          this.activeBranchId = null;
          this.toolPattern = {};
        }
        debug('branches', 'Auto-abandoned stale branch', { branchId: branch.id });
      }

      // Classify unclassified branches with Haiku
      if (isHaikuEnabled()) {
        const unclassified = this.repo.findUnclassifiedBranches(3);
        for (const branch of unclassified) {
          try {
            const observations = this.repo.getObservations(branch.id);
            const obsRepo = new ObservationRepository(this.db, branch.project_hash);
            const texts = observations
              .map(bo => {
                const obs = obsRepo.getById(bo.observation_id);
                return obs ? (obs.title ? `${obs.title}: ${obs.content}` : obs.content) : null;
              })
              .filter((t): t is string => t !== null);

            if (texts.length === 0) continue;

            const result = await classifyBranchWithHaiku(texts, branch.tool_pattern);
            this.repo.updateClassification(branch.id, result.branch_type, result.title);
            debug('branches', 'Branch classified', {
              branchId: branch.id,
              type: result.branch_type,
              title: result.title,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debug('branches', 'Branch classification failed (non-fatal)', {
              branchId: branch.id,
              error: msg,
            });
          }
        }

        // Generate summaries for recently completed branches
        const unsummarized = this.repo.findRecentCompletedUnsummarized(2);
        for (const branch of unsummarized) {
          try {
            const observations = this.repo.getObservations(branch.id);
            const obsRepo = new ObservationRepository(this.db, branch.project_hash);
            const texts = observations
              .map(bo => {
                const obs = obsRepo.getById(bo.observation_id);
                return obs ? (obs.title ? `${obs.title}: ${obs.content}` : obs.content) : null;
              })
              .filter((t): t is string => t !== null);

            if (texts.length === 0) continue;

            const result = await summarizeBranchWithHaiku(
              branch.title ?? 'Untitled',
              branch.branch_type,
              texts,
            );
            this.repo.updateSummary(branch.id, result.summary);
            debug('branches', 'Branch summarized', { branchId: branch.id });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debug('branches', 'Branch summarization failed (non-fatal)', {
              branchId: branch.id,
              error: msg,
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('branches', 'Maintenance error (non-fatal)', { error: msg });
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private detectBoundary(
    obs: BranchObservationInput,
    obsTime: number,
  ): TriggerSource | null {
    // 1. Project hash change
    if (this.activeProjectHash && obs.projectHash !== this.activeProjectHash) {
      return 'project_switch';
    }

    // 2. Session change
    if (
      this.activeSessionId &&
      obs.sessionId &&
      obs.sessionId !== this.activeSessionId
    ) {
      return 'session_start';
    }

    // 3. Time gap (>15 minutes)
    if (this.lastObservationTime > 0) {
      const gap = obsTime - this.lastObservationTime;
      if (gap > TIME_GAP_MS) {
        return 'time_gap';
      }
    }

    return null;
  }

  private startBranch(
    triggerSource: TriggerSource,
    obs: BranchObservationInput,
  ): void {
    const branch = this.repo.createBranch(
      obs.sessionId ?? null,
      triggerSource,
      obs.id,
    );
    this.state = 'tracking';
    this.activeBranchId = branch.id;
    this.toolPattern = {};
    debug('branches', 'New branch started', {
      branchId: branch.id,
      trigger: triggerSource,
    });
  }

  private completeBranch(): void {
    if (!this.activeBranchId) return;
    this.repo.completeBranch(this.activeBranchId);
    debug('branches', 'Branch completed', { branchId: this.activeBranchId });
    this.state = 'idle';
    this.activeBranchId = null;
    this.toolPattern = {};
  }

  private extractToolName(source: string): string | null {
    // Source format: "hook:Read", "hook:Write", "manual", "mcp:save_memory"
    if (source.startsWith('hook:')) {
      return source.slice(5); // "Read", "Write", etc.
    }
    if (source.startsWith('mcp:')) {
      return source.slice(4);
    }
    return null;
  }
}
