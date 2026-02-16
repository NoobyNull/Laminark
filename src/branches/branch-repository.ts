/**
 * Repository for thought branch CRUD operations.
 *
 * Every query is scoped to the projectHash provided at construction time.
 * All SQL statements are prepared once in the constructor and reused for
 * every call (same pattern as PathRepository).
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  ThoughtBranch,
  BranchObservation,
  BranchStatus,
  BranchType,
  ArcStage,
  TriggerSource,
} from './types.js';

export class BranchRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  // Prepared statements — branch lifecycle
  private readonly stmtCreate: BetterSqlite3.Statement;
  private readonly stmtComplete: BetterSqlite3.Statement;
  private readonly stmtAbandon: BetterSqlite3.Statement;
  private readonly stmtGetActive: BetterSqlite3.Statement;
  private readonly stmtGetById: BetterSqlite3.Statement;
  private readonly stmtList: BetterSqlite3.Statement;
  private readonly stmtListByStatus: BetterSqlite3.Statement;
  private readonly stmtListByType: BetterSqlite3.Statement;

  // Prepared statements — branch updates
  private readonly stmtUpdateArcStage: BetterSqlite3.Statement;
  private readonly stmtUpdateToolPattern: BetterSqlite3.Statement;
  private readonly stmtUpdateClassification: BetterSqlite3.Statement;
  private readonly stmtUpdateSummary: BetterSqlite3.Statement;
  private readonly stmtIncrementObsCount: BetterSqlite3.Statement;
  private readonly stmtLinkDebugPath: BetterSqlite3.Statement;

  // Prepared statements — observations
  private readonly stmtAddObservation: BetterSqlite3.Statement;
  private readonly stmtGetObservations: BetterSqlite3.Statement;
  private readonly stmtMaxSequence: BetterSqlite3.Statement;

  // Prepared statements — maintenance
  private readonly stmtFindStale: BetterSqlite3.Statement;
  private readonly stmtFindUnclassified: BetterSqlite3.Statement;
  private readonly stmtFindRecentCompleted: BetterSqlite3.Statement;
  private readonly stmtFindRecentActive: BetterSqlite3.Statement;
  private readonly stmtListRecent: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    // --- Branch lifecycle ---

    this.stmtCreate = db.prepare(`
      INSERT INTO thought_branches
        (id, project_hash, session_id, status, trigger_source, trigger_observation_id, started_at)
      VALUES (?, ?, ?, 'active', ?, ?, datetime('now'))
    `);

    this.stmtComplete = db.prepare(`
      UPDATE thought_branches
      SET status = 'completed', arc_stage = 'completed', ended_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtAbandon = db.prepare(`
      UPDATE thought_branches
      SET status = 'abandoned', ended_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtGetActive = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM thought_branches
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtList = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    this.stmtListByStatus = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND status = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    this.stmtListByType = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND branch_type = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    // --- Branch updates ---

    this.stmtUpdateArcStage = db.prepare(`
      UPDATE thought_branches SET arc_stage = ? WHERE id = ? AND project_hash = ?
    `);

    this.stmtUpdateToolPattern = db.prepare(`
      UPDATE thought_branches SET tool_pattern = ? WHERE id = ? AND project_hash = ?
    `);

    this.stmtUpdateClassification = db.prepare(`
      UPDATE thought_branches SET branch_type = ?, title = ? WHERE id = ? AND project_hash = ?
    `);

    this.stmtUpdateSummary = db.prepare(`
      UPDATE thought_branches SET summary = ? WHERE id = ? AND project_hash = ?
    `);

    this.stmtIncrementObsCount = db.prepare(`
      UPDATE thought_branches SET observation_count = observation_count + 1 WHERE id = ? AND project_hash = ?
    `);

    this.stmtLinkDebugPath = db.prepare(`
      UPDATE thought_branches SET linked_debug_path_id = ? WHERE id = ? AND project_hash = ?
    `);

    // --- Observations ---

    this.stmtAddObservation = db.prepare(`
      INSERT OR IGNORE INTO branch_observations
        (branch_id, observation_id, sequence_order, tool_name, arc_stage_at_add)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetObservations = db.prepare(`
      SELECT * FROM branch_observations
      WHERE branch_id = ?
      ORDER BY sequence_order ASC
    `);

    this.stmtMaxSequence = db.prepare(`
      SELECT COALESCE(MAX(sequence_order), 0) AS max_seq FROM branch_observations
      WHERE branch_id = ?
    `);

    // --- Maintenance ---

    this.stmtFindStale = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND status = 'active'
        AND started_at < datetime('now', '-24 hours')
    `);

    this.stmtFindUnclassified = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND branch_type = 'unknown'
        AND observation_count >= 3
      ORDER BY started_at DESC
      LIMIT ?
    `);

    this.stmtFindRecentCompleted = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND status = 'completed' AND summary IS NULL
        AND ended_at > datetime('now', '-1 hour')
      ORDER BY ended_at DESC
      LIMIT ?
    `);

    this.stmtFindRecentActive = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ? AND status = 'active'
        AND started_at > datetime('now', '-24 hours')
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.stmtListRecent = db.prepare(`
      SELECT * FROM thought_branches
      WHERE project_hash = ?
        AND started_at > datetime('now', ? || ' hours')
      ORDER BY started_at DESC
    `);
  }

  // ===========================================================================
  // Branch Lifecycle
  // ===========================================================================

  createBranch(
    sessionId: string | null,
    triggerSource: TriggerSource,
    triggerObservationId?: string,
  ): ThoughtBranch {
    const id = randomBytes(16).toString('hex');
    this.stmtCreate.run(
      id,
      this.projectHash,
      sessionId,
      triggerSource,
      triggerObservationId ?? null,
    );
    return this.getBranch(id)!;
  }

  completeBranch(branchId: string): void {
    this.stmtComplete.run(branchId, this.projectHash);
  }

  abandonBranch(branchId: string): void {
    this.stmtAbandon.run(branchId, this.projectHash);
  }

  getActiveBranch(): ThoughtBranch | null {
    const row = this.stmtGetActive.get(this.projectHash) as BranchRow | undefined;
    return row ? rowToBranch(row) : null;
  }

  getBranch(branchId: string): ThoughtBranch | null {
    const row = this.stmtGetById.get(branchId, this.projectHash) as BranchRow | undefined;
    return row ? rowToBranch(row) : null;
  }

  listBranches(limit: number = 20): ThoughtBranch[] {
    const rows = this.stmtList.all(this.projectHash, limit) as BranchRow[];
    return rows.map(rowToBranch);
  }

  listByStatus(status: BranchStatus, limit: number = 20): ThoughtBranch[] {
    const rows = this.stmtListByStatus.all(this.projectHash, status, limit) as BranchRow[];
    return rows.map(rowToBranch);
  }

  listByType(branchType: BranchType, limit: number = 20): ThoughtBranch[] {
    const rows = this.stmtListByType.all(this.projectHash, branchType, limit) as BranchRow[];
    return rows.map(rowToBranch);
  }

  // ===========================================================================
  // Branch Updates
  // ===========================================================================

  updateArcStage(branchId: string, stage: ArcStage): void {
    this.stmtUpdateArcStage.run(stage, branchId, this.projectHash);
  }

  updateToolPattern(branchId: string, pattern: Record<string, number>): void {
    this.stmtUpdateToolPattern.run(JSON.stringify(pattern), branchId, this.projectHash);
  }

  updateClassification(branchId: string, branchType: BranchType, title: string): void {
    this.stmtUpdateClassification.run(branchType, title, branchId, this.projectHash);
  }

  updateSummary(branchId: string, summary: string): void {
    this.stmtUpdateSummary.run(summary, branchId, this.projectHash);
  }

  linkDebugPath(branchId: string, debugPathId: string): void {
    this.stmtLinkDebugPath.run(debugPathId, branchId, this.projectHash);
  }

  // ===========================================================================
  // Observation Management
  // ===========================================================================

  addObservation(
    branchId: string,
    observationId: string,
    toolName: string | null,
    arcStage: ArcStage | null,
  ): void {
    const { max_seq } = this.stmtMaxSequence.get(branchId) as { max_seq: number };
    this.stmtAddObservation.run(
      branchId,
      observationId,
      max_seq + 1,
      toolName,
      arcStage,
    );
    this.stmtIncrementObsCount.run(branchId, this.projectHash);
  }

  getObservations(branchId: string): BranchObservation[] {
    const rows = this.stmtGetObservations.all(branchId) as BranchObservationRow[];
    return rows.map(rowToBranchObservation);
  }

  // ===========================================================================
  // Maintenance Queries
  // ===========================================================================

  findStaleBranches(): ThoughtBranch[] {
    const rows = this.stmtFindStale.all(this.projectHash) as BranchRow[];
    return rows.map(rowToBranch);
  }

  findUnclassifiedBranches(limit: number = 5): ThoughtBranch[] {
    const rows = this.stmtFindUnclassified.all(this.projectHash, limit) as BranchRow[];
    return rows.map(rowToBranch);
  }

  findRecentCompletedUnsummarized(limit: number = 3): ThoughtBranch[] {
    const rows = this.stmtFindRecentCompleted.all(this.projectHash, limit) as BranchRow[];
    return rows.map(rowToBranch);
  }

  findRecentActiveBranch(): ThoughtBranch | null {
    const row = this.stmtFindRecentActive.get(this.projectHash) as BranchRow | undefined;
    return row ? rowToBranch(row) : null;
  }

  listRecentBranches(hours: number): ThoughtBranch[] {
    const rows = this.stmtListRecent.all(this.projectHash, `-${hours}`) as BranchRow[];
    return rows.map(rowToBranch);
  }
}

// =============================================================================
// Raw Row Types
// =============================================================================

interface BranchRow {
  id: string;
  project_hash: string;
  session_id: string | null;
  status: string;
  branch_type: string;
  arc_stage: string;
  title: string | null;
  summary: string | null;
  parent_branch_id: string | null;
  linked_debug_path_id: string | null;
  trigger_source: string | null;
  trigger_observation_id: string | null;
  observation_count: number;
  tool_pattern: string;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

interface BranchObservationRow {
  branch_id: string;
  observation_id: string;
  sequence_order: number;
  tool_name: string | null;
  arc_stage_at_add: string | null;
  created_at: string;
}

// =============================================================================
// Row Mapping
// =============================================================================

function rowToBranch(row: BranchRow): ThoughtBranch {
  let toolPattern: Record<string, number> = {};
  try {
    toolPattern = JSON.parse(row.tool_pattern);
  } catch {
    // Default to empty
  }

  return {
    id: row.id,
    project_hash: row.project_hash,
    session_id: row.session_id,
    status: row.status as BranchStatus,
    branch_type: row.branch_type as BranchType,
    arc_stage: row.arc_stage as ArcStage,
    title: row.title,
    summary: row.summary,
    parent_branch_id: row.parent_branch_id,
    linked_debug_path_id: row.linked_debug_path_id,
    trigger_source: row.trigger_source as TriggerSource | null,
    trigger_observation_id: row.trigger_observation_id,
    observation_count: row.observation_count,
    tool_pattern: toolPattern,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
  };
}

function rowToBranchObservation(row: BranchObservationRow): BranchObservation {
  return {
    branch_id: row.branch_id,
    observation_id: row.observation_id,
    sequence_order: row.sequence_order,
    tool_name: row.tool_name,
    arc_stage_at_add: row.arc_stage_at_add as ArcStage | null,
    created_at: row.created_at,
  };
}
