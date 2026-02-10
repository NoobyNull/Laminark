/**
 * LLM-based observation classifier using MCP sampling.
 *
 * Runs on a background timer, batches unclassified observations,
 * sends them to the LLM via server.createMessage() for classification,
 * then updates the database with the results.
 *
 * Classifications: discovery, problem, solution, noise.
 * Noise observations are soft-deleted after classification.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Observation, ObservationClassification } from '../shared/types.js';
import { ObservationRepository } from '../storage/observations.js';
import { debug } from '../shared/debug.js';

export interface ClassificationResult {
  observationId: string;
  classification: ObservationClassification;
  reason: string;
}

export interface ClassifierOptions {
  intervalMs?: number;
  contextWindow?: number;
  batchSize?: number;
  fallbackTimeoutMs?: number;
}

const CLASSIFICATION_PROMPT = `You are a knowledge curator for a developer's memory system. Below is a chronological sequence of observations captured during a coding session.

Each observation marked [PENDING] needs classification. The surrounding observations (marked [context]) provide narrative context — what happened before and after.

Classify each [PENDING] observation as exactly one of:
- discovery: New understanding, finding, or insight about the codebase or problem
- problem: Error, bug, failure, or obstacle encountered
- solution: Fix, resolution, workaround, or decision that resolved something
- noise: Routine investigation step, redundant info, or working memory with no long-term value

Return ONLY a JSON array, no other text: [{"id": "...", "classification": "...", "reason": "..."}]`;

const VALID_CLASSIFICATIONS = new Set<string>(['discovery', 'problem', 'solution', 'noise']);

export class ObservationClassifier {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;
  private readonly mcpServer: McpServer;
  private readonly intervalMs: number;
  private readonly contextWindow: number;
  private readonly batchSize: number;
  private readonly fallbackTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: BetterSqlite3.Database,
    projectHash: string,
    mcpServer: McpServer,
    opts?: ClassifierOptions,
  ) {
    this.db = db;
    this.projectHash = projectHash;
    this.mcpServer = mcpServer;
    this.intervalMs = opts?.intervalMs ?? 45_000;
    this.contextWindow = opts?.contextWindow ?? 5;
    this.batchSize = opts?.batchSize ?? 20;
    this.fallbackTimeoutMs = opts?.fallbackTimeoutMs ?? 5 * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;
    debug('classify', 'Classifier started', {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
    });
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        debug('classify', 'Classification cycle error', { error: msg });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      debug('classify', 'Classifier stopped');
    }
  }

  async runOnce(): Promise<ClassificationResult[]> {
    const repo = new ObservationRepository(this.db, this.projectHash);
    const unclassified = repo.listUnclassified(this.batchSize);

    if (unclassified.length === 0) {
      debug('classify', 'No unclassified observations');
      return [];
    }

    debug('classify', 'Processing unclassified observations', {
      count: unclassified.length,
    });

    // First: promote stale observations (unclassified > fallbackTimeout)
    const now = Date.now();
    const stale: Observation[] = [];
    const pending: Observation[] = [];

    for (const obs of unclassified) {
      // SQLite datetime('now') stores UTC without 'Z' suffix; ensure UTC parsing
      const createdAtUtc = obs.createdAt.endsWith('Z') ? obs.createdAt : obs.createdAt + 'Z';
      const age = now - new Date(createdAtUtc).getTime();
      if (age > this.fallbackTimeoutMs) {
        stale.push(obs);
      } else {
        pending.push(obs);
      }
    }

    const results: ClassificationResult[] = [];

    // Auto-promote stale observations as discovery
    for (const obs of stale) {
      repo.updateClassification(obs.id, 'discovery');
      results.push({
        observationId: obs.id,
        classification: 'discovery',
        reason: 'fallback: unclassified for >5min',
      });
      debug('classify', 'Auto-promoted stale observation', { id: obs.id });
    }

    if (pending.length === 0) {
      return results;
    }

    // Build the prompt with context
    const prompt = this.buildPrompt(pending, repo);

    // Call LLM via MCP sampling
    try {
      const llmResults = await this.classify(prompt, pending);
      for (const result of llmResults) {
        repo.updateClassification(result.observationId, result.classification);

        // Soft-delete noise observations
        if (result.classification === 'noise') {
          repo.softDelete(result.observationId);
        }

        results.push(result);
        debug('classify', 'Classified observation', {
          id: result.observationId,
          classification: result.classification,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('classify', 'LLM classification failed, will retry next cycle', {
        error: msg,
        pendingCount: pending.length,
      });
      // Observations stay unclassified, will be retried next cycle
      // (or auto-promoted once they exceed fallbackTimeout)
    }

    return results;
  }

  private buildPrompt(
    pending: Observation[],
    repo: ObservationRepository,
  ): string {
    // Collect all context observations around the pending ones
    const contextMap = new Map<string, Observation>();
    const pendingIds = new Set(pending.map((o) => o.id));

    for (const obs of pending) {
      const context = repo.listContext(obs.createdAt, this.contextWindow);
      for (const ctx of context) {
        if (!contextMap.has(ctx.id)) {
          contextMap.set(ctx.id, ctx);
        }
      }
    }

    // Build chronological sequence
    const allObs = Array.from(contextMap.values()).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.rowid - b.rowid,
    );

    const lines: string[] = [];
    for (const obs of allObs) {
      const isPending = pendingIds.has(obs.id);
      const tag = isPending ? `[PENDING] ${obs.id}` : '[context]';
      const content = obs.content.length > 300
        ? obs.content.substring(0, 300) + '...'
        : obs.content;
      lines.push(`${tag} | ${obs.createdAt} | ${content}`);
    }

    return `${CLASSIFICATION_PROMPT}\n\nObservations (chronological):\n${lines.join('\n')}`;
  }

  private async classify(
    prompt: string,
    pending: Observation[],
  ): Promise<ClassificationResult[]> {
    const response = await this.mcpServer.server.createMessage({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: prompt },
        },
      ],
      maxTokens: 2048,
      modelPreferences: {
        costPriority: 0.8,
        speedPriority: 0.8,
        intelligencePriority: 0.3,
      },
    });

    // Extract text from response
    const content = response.content;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
    } else if (content && 'type' in content && content.type === 'text') {
      text = (content as { type: 'text'; text: string }).text;
    } else {
      throw new Error('Unexpected response format from createMessage');
    }

    return this.parseResponse(text, pending);
  }

  private parseResponse(
    text: string,
    pending: Observation[],
  ): ClassificationResult[] {
    // Extract JSON array from response (may have surrounding text)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      debug('classify', 'Failed to parse JSON from LLM response', {
        responseLength: text.length,
      });
      throw new Error('No JSON array found in LLM response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('Invalid JSON in LLM response');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array from LLM');
    }

    const pendingIds = new Set(pending.map((o) => o.id));
    const results: ClassificationResult[] = [];

    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.id !== 'string' ||
        typeof item.classification !== 'string'
      ) {
        continue;
      }

      if (!pendingIds.has(item.id)) {
        continue;
      }

      if (!VALID_CLASSIFICATIONS.has(item.classification)) {
        continue;
      }

      results.push({
        observationId: item.id,
        classification: item.classification as ObservationClassification,
        reason: typeof item.reason === 'string' ? item.reason : '',
      });

      // Remove from pending set so we don't double-count
      pendingIds.delete(item.id);
    }

    return results;
  }
}
