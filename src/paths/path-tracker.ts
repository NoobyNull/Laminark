/**
 * PathTracker — state machine for automatic debug path detection.
 *
 * Consumes DebugSignal from the Haiku classifier and manages the lifecycle
 * of debug paths: idle -> potential_debug -> active_debug -> resolved.
 *
 * Lives in the MCP server process (not the ephemeral hook handler) so it
 * can maintain in-memory state across observations. Persists paths and
 * waypoints via PathRepository for restart recovery.
 *
 * Implements:
 *   PATH-01: Auto-detect debug sessions from error patterns
 *   PATH-02: Capture waypoints during active debug paths
 *   PATH-03: Detect resolution via consecutive success signals
 *   PATH-04: Persistence across restarts (via SQLite recovery)
 *   PATH-05: Dead end tracking via failure waypoint type
 */

import type { DebugSignal } from '../intelligence/haiku-classifier-agent.js';
import type { PathRepository } from './path-repository.js';
import type { WaypointType } from './types.js';
import { debug } from '../shared/debug.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrackerState = 'idle' | 'potential_debug' | 'active_debug' | 'resolved';

interface ErrorBufferEntry {
  timestamp: number;
  summary: string;
}

interface PathTrackerOptions {
  /** Number of errors needed to confirm debug session (default: 3) */
  errorThreshold?: number;
  /** Time window for error threshold in ms (default: 5 minutes) */
  windowMs?: number;
  /** Consecutive successes needed to auto-resolve (default: 3) */
  resolutionThreshold?: number;
  /** Maximum waypoints per path (default: 30) */
  maxWaypoints?: number;
}

// ---------------------------------------------------------------------------
// PathTracker
// ---------------------------------------------------------------------------

export class PathTracker {
  private state: TrackerState = 'idle';
  private errorBuffer: ErrorBufferEntry[] = [];
  private consecutiveSuccesses: number = 0;
  private currentPathId: string | null = null;

  private readonly errorThreshold: number;
  private readonly windowMs: number;
  private readonly resolutionThreshold: number;
  private readonly maxWaypoints: number;

  constructor(
    private readonly repo: PathRepository,
    opts?: PathTrackerOptions,
  ) {
    this.errorThreshold = opts?.errorThreshold ?? 3;
    this.windowMs = opts?.windowMs ?? 5 * 60 * 1000;
    this.resolutionThreshold = opts?.resolutionThreshold ?? 3;
    this.maxWaypoints = opts?.maxWaypoints ?? 30;

    // PATH-04: Recover active path from SQLite on server restart
    const activePath = this.repo.getActivePath();
    if (activePath) {
      this.state = 'active_debug';
      this.currentPathId = activePath.id;
      debug('paths', 'Recovered active path from SQLite', { pathId: activePath.id });
    }
  }

  /**
   * Process a debug signal from the Haiku classifier.
   *
   * Called for every classified observation (both noise and signal).
   * Drives state transitions and persists waypoints when in active_debug.
   */
  processSignal(
    signal: DebugSignal,
    observationId: string,
    observationContent: string,
  ): void {
    // Filter: skip low-confidence signals entirely
    if (signal.confidence < 0.3) {
      return;
    }

    const summary = observationContent.substring(0, 200).trim();

    switch (this.state) {
      case 'idle':
        this.handleIdle(signal, summary);
        break;

      case 'potential_debug':
        this.handlePotentialDebug(signal, summary, observationId);
        break;

      case 'active_debug':
        this.handleActiveDebug(signal, summary, observationId);
        break;

      case 'resolved':
        // Resolved is transient — immediately return to idle
        this.state = 'idle';
        debug('paths', 'Transitioned resolved -> idle');
        this.handleIdle(signal, summary);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // State handlers
  // -------------------------------------------------------------------------

  private handleIdle(signal: DebugSignal, summary: string): void {
    if (signal.is_error && signal.confidence >= 0.5) {
      this.errorBuffer.push({ timestamp: Date.now(), summary });
      this.state = 'potential_debug';
      debug('paths', 'Transitioned idle -> potential_debug', {
        bufferSize: this.errorBuffer.length,
      });
    }
  }

  private handlePotentialDebug(
    signal: DebugSignal,
    summary: string,
    observationId: string,
  ): void {
    if (signal.is_error && signal.confidence >= 0.5) {
      this.errorBuffer.push({ timestamp: Date.now(), summary });
    }

    // Prune entries older than windowMs
    const cutoff = Date.now() - this.windowMs;
    this.errorBuffer = this.errorBuffer.filter((e) => e.timestamp >= cutoff);

    // All expired — back to idle
    if (this.errorBuffer.length === 0) {
      this.state = 'idle';
      debug('paths', 'Error buffer expired, potential_debug -> idle');
      return;
    }

    // Threshold met — transition to active_debug
    if (this.errorBuffer.length >= this.errorThreshold) {
      const triggerSummary = this.errorBuffer[0].summary;
      const path = this.repo.createPath(triggerSummary);
      this.currentPathId = path.id;
      this.state = 'active_debug';
      this.consecutiveSuccesses = 0;

      debug('paths', 'Debug path confirmed, potential_debug -> active_debug', {
        pathId: path.id,
        errorCount: this.errorBuffer.length,
      });

      // Add waypoints for all buffered errors
      for (const entry of this.errorBuffer) {
        this.repo.addWaypoint(path.id, 'error', entry.summary, observationId);
      }

      // Clear buffer — errors are now waypoints
      this.errorBuffer = [];
    }
  }

  private handleActiveDebug(
    signal: DebugSignal,
    summary: string,
    observationId: string,
  ): void {
    if (!this.currentPathId) return;

    // Cap enforcement
    if (this.repo.countWaypoints(this.currentPathId) >= this.maxWaypoints) {
      debug('paths', 'Waypoint cap reached, skipping', {
        pathId: this.currentPathId,
        cap: this.maxWaypoints,
      });
      // Still process resolution detection even if we can't add waypoints
      this.updateResolutionCounter(signal, summary, observationId);
      return;
    }

    // Determine waypoint type
    let waypointType: WaypointType;
    if (signal.waypoint_hint) {
      waypointType = signal.waypoint_hint;
    } else if (signal.is_error) {
      waypointType = 'error';
    } else if (signal.is_resolution) {
      waypointType = 'success';
    } else {
      waypointType = 'attempt';
    }

    // Add waypoint
    this.repo.addWaypoint(this.currentPathId, waypointType, summary, observationId);

    debug('paths', 'Waypoint added', {
      pathId: this.currentPathId,
      type: waypointType,
      observationId,
    });

    // Resolution detection
    this.updateResolutionCounter(signal, summary, observationId);
  }

  private updateResolutionCounter(
    signal: DebugSignal,
    summary: string,
    observationId: string,
  ): void {
    if (!this.currentPathId) return;

    if (signal.is_resolution) {
      this.consecutiveSuccesses++;

      if (this.consecutiveSuccesses >= this.resolutionThreshold) {
        // Add final resolution waypoint (if under cap)
        if (this.repo.countWaypoints(this.currentPathId) < this.maxWaypoints) {
          this.repo.addWaypoint(this.currentPathId, 'resolution', summary, observationId);
        }

        // Resolve the path
        this.repo.resolvePath(this.currentPathId, summary);

        debug('paths', 'Path auto-resolved', {
          pathId: this.currentPathId,
          consecutiveSuccesses: this.consecutiveSuccesses,
        });

        // Reset state
        this.state = 'idle';
        this.currentPathId = null;
        this.consecutiveSuccesses = 0;
        this.errorBuffer = [];
      }
    } else if (signal.is_error) {
      // Error resets the consecutive success counter
      this.consecutiveSuccesses = 0;
    }
  }
}
