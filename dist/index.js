#!/usr/bin/env node
import { a as isDebugEnabled, i as getProjectHash, n as getDatabaseConfig, r as getDbPath, t as getConfigDir } from "./config-CtH17VYQ.mjs";
import { a as MIGRATIONS, c as debugTimed, i as openDatabase, n as ObservationRepository, o as runMigrations, r as rowToObservation, s as debug, t as SessionRepository } from "./sessions-D3yr9tXZ.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Worker } from "node:worker_threads";
import { fileURLToPath as fileURLToPath$1 } from "node:url";
import { Hono } from "hono";
import fs from "fs";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

//#region src/storage/search.ts
/**
* FTS5 search engine with BM25 ranking, snippet extraction, and strict project scoping.
*
* All queries are scoped to the projectHash provided at construction time.
* Queries are sanitized to prevent FTS5 syntax errors and injection.
*/
var SearchEngine = class {
	db;
	projectHash;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
	}
	/**
	* Full-text search with BM25 ranking and snippet extraction.
	*
	* bm25() returns NEGATIVE values where more negative = more relevant.
	* ORDER BY rank (ascending) puts best matches first.
	*
	* @param query - User's search query (sanitized for FTS5 safety)
	* @param options - Optional limit and sessionId filter
	* @returns SearchResult[] ordered by relevance (best match first)
	*/
	searchKeyword(query, options) {
		const sanitized = this.sanitizeQuery(query);
		if (!sanitized) return [];
		const limit = options?.limit ?? 20;
		let sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
    `;
		const params = [sanitized, this.projectHash];
		if (options?.sessionId) {
			sql += " AND o.session_id = ?";
			params.push(options.sessionId);
		}
		sql += " ORDER BY rank LIMIT ?";
		params.push(limit);
		const results = debugTimed("search", "FTS5 keyword search", () => {
			return this.db.prepare(sql).all(...params).map((row) => ({
				observation: rowToObservation(row),
				score: Math.abs(row.rank),
				matchType: "fts",
				snippet: row.snippet
			}));
		});
		debug("search", "Keyword search completed", {
			query: sanitized,
			resultCount: results.length
		});
		return results;
	}
	/**
	* Prefix search for autocomplete-style matching.
	* Appends `*` to each word for prefix matching.
	*/
	searchByPrefix(prefix, limit) {
		const words = prefix.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return [];
		const sanitizedWords = words.map((w) => this.sanitizeWord(w)).filter(Boolean);
		if (sanitizedWords.length === 0) return [];
		const ftsQuery = sanitizedWords.map((w) => `${w}*`).join(" ");
		const effectiveLimit = limit ?? 20;
		const sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
      ORDER BY rank
      LIMIT ?
    `;
		const results = debugTimed("search", "FTS5 prefix search", () => {
			return this.db.prepare(sql).all(ftsQuery, this.projectHash, effectiveLimit).map((row) => ({
				observation: rowToObservation(row),
				score: Math.abs(row.rank),
				matchType: "fts",
				snippet: row.snippet
			}));
		});
		debug("search", "Prefix search completed", {
			prefix,
			resultCount: results.length
		});
		return results;
	}
	/**
	* Rebuild the FTS5 index if it gets out of sync.
	*/
	rebuildIndex() {
		debug("search", "Rebuilding FTS5 index");
		this.db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
	}
	/**
	* Sanitizes a user query for safe FTS5 MATCH usage.
	* Removes FTS5 operators and special characters.
	* Returns null if the query is empty after sanitization.
	*/
	sanitizeQuery(query) {
		const words = query.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return null;
		const sanitizedWords = words.map((w) => this.sanitizeWord(w)).filter(Boolean);
		if (sanitizedWords.length === 0) return null;
		return sanitizedWords.join(" ");
	}
	/**
	* Sanitizes a single word for FTS5 safety.
	* Removes quotes, parentheses, asterisks, and FTS5 operator keywords.
	*/
	sanitizeWord(word) {
		let cleaned = word.replace(/["*()^{}[\]]/g, "");
		if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) return "";
		cleaned = cleaned.replace(/[^\w\-]/g, "");
		return cleaned;
	}
};

//#endregion
//#region src/storage/embeddings.ts
/**
* Data layer for vector insert/query against the cosine-distance vec0 table.
*
* All methods catch errors internally and return empty/default values for
* graceful degradation (DQ-03). Uses debug('embed', ...) logging.
*/
var EmbeddingStore = class {
	stmtInsert;
	stmtSearch;
	stmtDelete;
	stmtExists;
	stmtFindUnembedded;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
		this.stmtInsert = db.prepare("INSERT OR REPLACE INTO observation_embeddings(observation_id, embedding) VALUES (?, ?)");
		this.stmtSearch = db.prepare(`
      SELECT observation_id, distance
      FROM observation_embeddings
      WHERE embedding MATCH ?
        AND observation_id IN (
          SELECT id FROM observations WHERE project_hash = ? AND deleted_at IS NULL
        )
      ORDER BY distance
      LIMIT ?
    `);
		this.stmtDelete = db.prepare("DELETE FROM observation_embeddings WHERE observation_id = ?");
		this.stmtExists = db.prepare("SELECT 1 FROM observation_embeddings WHERE observation_id = ?");
		this.stmtFindUnembedded = db.prepare(`
      SELECT id FROM observations
      WHERE project_hash = ?
        AND deleted_at IS NULL
        AND id NOT IN (SELECT observation_id FROM observation_embeddings)
      LIMIT ?
    `);
	}
	/**
	* Stores an embedding for an observation.
	*
	* Uses INSERT OR REPLACE so re-embedding an observation overwrites
	* the old vector.
	*/
	store(observationId, embedding) {
		try {
			this.stmtInsert.run(observationId, embedding);
			debug("embed", "Stored embedding", {
				observationId,
				dimensions: embedding.length
			});
		} catch (err) {
			debug("embed", "Failed to store embedding", {
				observationId,
				error: String(err)
			});
		}
	}
	/**
	* Project-scoped KNN search using cosine distance.
	*
	* Returns the nearest observations ordered by distance (ascending).
	* Only returns observations belonging to this store's project that
	* have not been soft-deleted.
	*/
	search(queryEmbedding, limit = 20) {
		try {
			const rows = this.stmtSearch.all(queryEmbedding, this.projectHash, limit);
			debug("embed", "Search completed", {
				results: rows.length,
				limit
			});
			return rows.map((row) => ({
				observationId: row.observation_id,
				distance: row.distance
			}));
		} catch (err) {
			debug("embed", "Search failed", { error: String(err) });
			return [];
		}
	}
	/**
	* Removes the embedding for a deleted observation.
	*/
	delete(observationId) {
		try {
			this.stmtDelete.run(observationId);
			debug("embed", "Deleted embedding", { observationId });
		} catch (err) {
			debug("embed", "Failed to delete embedding", {
				observationId,
				error: String(err)
			});
		}
	}
	/**
	* Checks if an observation has an embedding stored.
	*/
	has(observationId) {
		try {
			return this.stmtExists.get(observationId) !== void 0;
		} catch (err) {
			debug("embed", "Failed to check embedding existence", {
				observationId,
				error: String(err)
			});
			return false;
		}
	}
	/**
	* Finds observation IDs that need embeddings generated.
	*
	* Returns IDs of observations belonging to this project that are
	* not soft-deleted and have no entry in the embeddings table.
	*/
	findUnembedded(limit = 50) {
		try {
			const rows = this.stmtFindUnembedded.all(this.projectHash, limit);
			debug("embed", "Found unembedded observations", {
				count: rows.length,
				limit
			});
			return rows.map((row) => row.id);
		} catch (err) {
			debug("embed", "Failed to find unembedded observations", { error: String(err) });
			return [];
		}
	}
};

//#endregion
//#region src/storage/stash-manager.ts
/**
* Maps a snake_case StashRow to a camelCase ContextStash interface.
* JSON-parses observation_snapshots and observation_ids from their
* serialized TEXT column format back into arrays.
*/
function rowToStash(row) {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		topicLabel: row.topic_label,
		summary: row.summary,
		observationIds: JSON.parse(row.observation_ids),
		observationSnapshots: JSON.parse(row.observation_snapshots),
		createdAt: row.created_at,
		resumedAt: row.resumed_at,
		status: row.status
	};
}
/**
* Repository for context stash CRUD operations.
*
* Manages the lifecycle of stashed context threads: creating snapshots
* when topic shifts are detected, listing available stashes, retrieving
* full stash records, resuming stashes, and deleting them.
*
* All SQL statements are prepared once in the constructor and reused
* for every call (better-sqlite3 performance best practice).
*/
var StashManager = class {
	db;
	stmtInsert;
	stmtGetById;
	stmtResume;
	stmtDelete;
	constructor(db) {
		this.db = db;
		this.stmtInsert = db.prepare(`
      INSERT INTO context_stashes (id, project_id, session_id, topic_label, summary, observation_snapshots, observation_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'stashed')
    `);
		this.stmtGetById = db.prepare(`
      SELECT * FROM context_stashes WHERE id = ?
    `);
		this.stmtResume = db.prepare(`
      UPDATE context_stashes
      SET status = 'resumed', resumed_at = datetime('now')
      WHERE id = ?
    `);
		this.stmtDelete = db.prepare(`
      DELETE FROM context_stashes WHERE id = ?
    `);
		debug("db", "StashManager initialized");
	}
	/**
	* Creates a new stash record from a context thread snapshot.
	* JSON-serializes observation snapshots and IDs for TEXT column storage.
	* Uses randomBytes(16) hex for ID generation (matches ObservationRepository pattern).
	*/
	createStash(input) {
		const id = randomBytes(16).toString("hex");
		const observationIds = input.observations.map((o) => o.id);
		const snapshotsJson = JSON.stringify(input.observations);
		const idsJson = JSON.stringify(observationIds);
		debug("db", "Creating stash", {
			topicLabel: input.topicLabel,
			observationCount: input.observations.length
		});
		this.stmtInsert.run(id, input.projectId, input.sessionId, input.topicLabel, input.summary, snapshotsJson, idsJson);
		const row = this.stmtGetById.get(id);
		if (!row) throw new Error("Failed to retrieve newly created stash");
		debug("db", "Stash created", { id });
		return rowToStash(row);
	}
	/**
	* Lists stashes for a project, ordered by created_at DESC.
	* Supports optional filtering by session_id and status.
	*/
	listStashes(projectId, options) {
		const limit = options?.limit ?? 10;
		let sql = "SELECT * FROM context_stashes WHERE project_id = ?";
		const params = [projectId];
		if (options?.sessionId) {
			sql += " AND session_id = ?";
			params.push(options.sessionId);
		}
		if (options?.status) {
			sql += " AND status = ?";
			params.push(options.status);
		}
		sql += " ORDER BY created_at DESC LIMIT ?";
		params.push(limit);
		debug("db", "Listing stashes", {
			projectId,
			...options
		});
		return this.db.prepare(sql).all(...params).map(rowToStash);
	}
	/**
	* Retrieves a single stash by ID with full observation snapshot data.
	* Returns null for nonexistent IDs.
	*/
	getStash(id) {
		const row = this.stmtGetById.get(id);
		return row ? rowToStash(row) : null;
	}
	/**
	* Marks a stash as resumed and sets resumed_at timestamp.
	* Returns the updated record.
	* Throws if the stash does not exist.
	*/
	resumeStash(id) {
		if (this.stmtResume.run(id).changes === 0) throw new Error(`Stash not found: ${id}`);
		debug("db", "Stash resumed", { id });
		const row = this.stmtGetById.get(id);
		if (!row) throw new Error(`Failed to retrieve resumed stash: ${id}`);
		return rowToStash(row);
	}
	/**
	* Hard-deletes a stash record.
	*/
	deleteStash(id) {
		this.stmtDelete.run(id);
		debug("db", "Stash deleted", { id });
	}
	/**
	* Returns stashes with status='stashed' (excludes resumed) for a project,
	* ordered by created_at DESC.
	*/
	getRecentStashes(projectId, limit) {
		return this.listStashes(projectId, {
			status: "stashed",
			limit: limit ?? 10
		});
	}
};

//#endregion
//#region src/storage/threshold-store.ts
/**
* Persists and loads EWMA threshold history for session seeding.
*
* At the end of each session, the final EWMA state is saved via
* saveSessionThreshold(). When a new session starts, loadHistoricalSeed()
* computes averages from the last 10 sessions to bootstrap the EWMA
* without cold-start problems.
*
* All SQL statements are prepared once in the constructor and reused
* for every call (better-sqlite3 performance best practice).
*/
var ThresholdStore = class {
	db;
	stmtInsert;
	stmtLoadSeed;
	constructor(db) {
		this.db = db;
		this.stmtInsert = db.prepare(`
      INSERT INTO threshold_history (project_id, session_id, final_ewma_distance, final_ewma_variance, observation_count)
      VALUES (?, ?, ?, ?, ?)
    `);
		this.stmtLoadSeed = db.prepare(`
      SELECT
        AVG(final_ewma_distance) AS avg_distance,
        AVG(final_ewma_variance) AS avg_variance
      FROM (
        SELECT final_ewma_distance, final_ewma_variance
        FROM threshold_history
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      )
    `);
		debug("db", "ThresholdStore initialized");
	}
	/**
	* Persist the final EWMA state of a session for future seeding.
	*/
	saveSessionThreshold(projectId, sessionId, state) {
		this.stmtInsert.run(projectId, sessionId, state.ewmaDistance, state.ewmaVariance, state.observationCount);
		debug("db", "Threshold saved", {
			projectId,
			sessionId,
			ewmaDistance: state.ewmaDistance,
			observations: state.observationCount
		});
	}
	/**
	* Load historical seed by averaging the last 10 sessions for a project.
	*
	* Returns null if no history exists for this project.
	*/
	loadHistoricalSeed(projectId) {
		const row = this.stmtLoadSeed.get(projectId);
		if (row.avg_distance === null || row.avg_variance === null) {
			debug("db", "No threshold history found", { projectId });
			return null;
		}
		debug("db", "Threshold seed loaded", {
			projectId,
			avgDistance: row.avg_distance,
			avgVariance: row.avg_variance
		});
		return {
			averageDistance: row.avg_distance,
			averageVariance: row.avg_variance
		};
	}
};

//#endregion
//#region src/mcp/server.ts
function createServer() {
	return new McpServer({
		name: "laminark",
		version: "0.1.0"
	}, { capabilities: { tools: {} } });
}
async function startServer(server) {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	debug("mcp", "MCP server started on stdio transport");
}

//#endregion
//#region src/search/hybrid.ts
/**
* Hybrid search combining FTS5 keyword results and vec0 vector results
* using reciprocal rank fusion (RRF).
*
* When both keyword and vector results are available, RRF merges the two
* ranked lists into a single score-sorted list. When only keyword results
* are available (worker not ready, no embeddings), falls back transparently.
*/
/**
* Merges multiple ranked lists into a single fused ranking using RRF.
*
* For each document across all lists, computes:
*   fusedScore = sum(1 / (k + rank + 1))
* where rank is the 0-based position in each list.
*
* @param rankedLists - Arrays of ranked items, each with an `id` field
* @param k - Smoothing constant (default 60, standard RRF value)
* @returns Fused results sorted by fusedScore descending
*/
function reciprocalRankFusion(rankedLists, k = 60) {
	const scores = /* @__PURE__ */ new Map();
	for (const list of rankedLists) for (let rank = 0; rank < list.length; rank++) {
		const item = list[rank];
		const current = scores.get(item.id) ?? 0;
		scores.set(item.id, current + 1 / (k + rank + 1));
	}
	const results = [];
	for (const [id, fusedScore] of scores) results.push({
		id,
		fusedScore
	});
	results.sort((a, b) => b.fusedScore - a.fusedScore);
	return results;
}
/**
* Combines FTS5 keyword search and vec0 vector search using RRF.
*
* Falls back to keyword-only when:
* - Worker is null or not ready
* - Query embedding fails
* - No vector results returned
*
* @returns SearchResult[] with matchType indicating source(s)
*/
async function hybridSearch(params) {
	const { searchEngine, embeddingStore, worker, query, db, projectHash, options } = params;
	const limit = options?.limit ?? 20;
	return debugTimed("search", "Hybrid search", async () => {
		const keywordResults = searchEngine.searchKeyword(query, {
			limit,
			sessionId: options?.sessionId
		});
		debug("search", "Keyword results", { count: keywordResults.length });
		let vectorResults = [];
		if (worker && worker.isReady()) {
			const queryEmbedding = await worker.embed(query);
			if (queryEmbedding) {
				vectorResults = embeddingStore.search(queryEmbedding, limit * 2);
				debug("search", "Vector results", { count: vectorResults.length });
			} else debug("search", "Query embedding failed, keyword-only");
		} else debug("search", "Worker not ready, keyword-only");
		if (vectorResults.length === 0) {
			debug("search", "Returning keyword-only results", { count: keywordResults.length });
			return keywordResults;
		}
		const fused = reciprocalRankFusion([keywordResults.map((r) => ({ id: r.observation.id })), vectorResults.map((r) => ({ id: r.observationId }))]);
		const keywordMap = /* @__PURE__ */ new Map();
		for (const r of keywordResults) keywordMap.set(r.observation.id, r);
		const vectorIdSet = new Set(vectorResults.map((r) => r.observationId));
		const obsRepo = new ObservationRepository(db, projectHash);
		const merged = [];
		for (const item of fused) {
			if (merged.length >= limit) break;
			const fromKeyword = keywordMap.get(item.id);
			const fromVector = vectorIdSet.has(item.id);
			if (fromKeyword && fromVector) merged.push({
				observation: fromKeyword.observation,
				score: item.fusedScore,
				matchType: "hybrid",
				snippet: fromKeyword.snippet
			});
			else if (fromKeyword) merged.push({
				observation: fromKeyword.observation,
				score: item.fusedScore,
				matchType: "fts",
				snippet: fromKeyword.snippet
			});
			else if (fromVector) {
				const obs = obsRepo.getById(item.id);
				if (obs) {
					const snippet = (obs.content ?? "").replace(/\n/g, " ").slice(0, 100);
					merged.push({
						observation: obs,
						score: item.fusedScore,
						matchType: "vector",
						snippet
					});
				}
			}
		}
		debug("search", "Hybrid search complete", {
			keyword: keywordResults.length,
			vector: vectorResults.length,
			fused: merged.length,
			hybrid: merged.filter((r) => r.matchType === "hybrid").length
		});
		return merged;
	});
}

//#endregion
//#region src/mcp/token-budget.ts
const TOKEN_BUDGET = 2e3;
const FULL_VIEW_BUDGET = 4e3;
function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}
function enforceTokenBudget(results, formatResult, budget = TOKEN_BUDGET) {
	const effectiveBudget = budget - 100;
	let totalTokens = 0;
	const items = [];
	for (const result of results) {
		const tokens = estimateTokens(formatResult(result));
		if (totalTokens + tokens > effectiveBudget && items.length > 0) return {
			items,
			truncated: true,
			tokenEstimate: totalTokens
		};
		items.push(result);
		totalTokens += tokens;
	}
	return {
		items,
		truncated: false,
		tokenEstimate: totalTokens
	};
}

//#endregion
//#region src/mcp/tools/recall.ts
function shortId(id) {
	return id.slice(0, 8);
}
function dateStr(iso) {
	return iso.slice(0, 10);
}
function timeStr(iso) {
	return iso.slice(11, 16);
}
function snippetText(content, maxLen) {
	return content.replace(/\n/g, " ").slice(0, maxLen);
}
function formatCompactItem(obs, index, score) {
	return `[${index}] ${shortId(obs.id)} | ${obs.title ?? "untitled"} | ${score !== void 0 ? score.toFixed(2) : "-"} | ${snippetText(obs.content, 100)} | ${dateStr(obs.createdAt)}`;
}
function formatTimelineGroup(date, items) {
	const lines = [`## ${date}`];
	for (const { obs } of items) {
		const time = timeStr(obs.createdAt);
		const title = obs.title ?? "untitled";
		const source = obs.source;
		const snippet = snippetText(obs.content, 150);
		lines.push(`${time} | ${title} | ${source} | ${snippet}`);
	}
	return lines.join("\n");
}
function formatFullItem(obs) {
	return `--- ${shortId(obs.id)} | ${obs.title ?? "untitled"} | ${obs.createdAt} ---\n${obs.content}`;
}
function prependNotifications$4(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$4(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function errorResponse$1(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
function registerRecall(server, db, projectHash, worker = null, embeddingStore = null, notificationStore = null) {
	server.registerTool("recall", {
		title: "Recall Memories",
		description: "Search, view, purge, or restore memories. Search first to find matches, then act on specific results by ID.",
		inputSchema: {
			query: z.string().optional().describe("FTS5 keyword search query"),
			id: z.string().optional().describe("Direct lookup by observation ID"),
			title: z.string().optional().describe("Search by title (partial match)"),
			action: z.enum([
				"view",
				"purge",
				"restore"
			]).default("view").describe("Action to take on results: view (show details), purge (soft-delete), restore (un-delete)"),
			ids: z.array(z.string()).optional().describe("Specific observation IDs to act on (from a previous search result)"),
			detail: z.enum([
				"compact",
				"timeline",
				"full"
			]).default("compact").describe("View detail level: compact (index ~80 tokens/result), timeline (date-grouped), full (complete text)"),
			limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return"),
			include_purged: z.boolean().default(false).describe("Include soft-deleted items in results (needed for restore)")
		}
	}, async (args) => {
		const withNotifications = (text) => textResponse$4(prependNotifications$4(notificationStore, projectHash, text));
		try {
			const repo = new ObservationRepository(db, projectHash);
			const searchEngine = new SearchEngine(db, projectHash);
			const hasSearch = args.query !== void 0 || args.id !== void 0 || args.title !== void 0;
			if (args.ids && hasSearch) return errorResponse$1("Provide either a search query or IDs to act on, not both.");
			if ((args.action === "purge" || args.action === "restore") && !args.ids && !args.id) return errorResponse$1(`Provide ids array or id to specify which memories to ${args.action}.`);
			let observations = [];
			let searchResults = null;
			if (args.ids) {
				const notFound = [];
				for (const itemId of args.ids) {
					const obs = repo.getByIdIncludingDeleted(itemId);
					if (obs) observations.push(obs);
					else notFound.push(itemId);
				}
				if (notFound.length > 0 && observations.length === 0) return withNotifications(`No memories found matching '${notFound.join(", ")}'. Try broader search terms or check the ID.`);
			} else if (args.id) {
				const obs = args.include_purged ? repo.getByIdIncludingDeleted(args.id) : repo.getById(args.id);
				if (!obs) return withNotifications(`No memories found matching '${args.id}'. Try broader search terms or check the ID.`);
				observations = [obs];
			} else if (args.query) {
				if (embeddingStore) searchResults = await hybridSearch({
					searchEngine,
					embeddingStore,
					worker,
					query: args.query,
					db,
					projectHash,
					options: { limit: args.limit }
				});
				else searchResults = searchEngine.searchKeyword(args.query, { limit: args.limit });
				observations = searchResults.map((r) => r.observation);
			} else if (args.title) observations = repo.getByTitle(args.title, {
				limit: args.limit,
				includePurged: args.include_purged
			});
			else observations = args.include_purged ? repo.listIncludingDeleted({ limit: args.limit }) : repo.list({ limit: args.limit });
			if (observations.length === 0) return withNotifications(`No memories found matching '${args.query ?? args.title ?? args.id ?? ""}'. Try broader search terms or check the ID.`);
			if (args.action === "view") {
				const originalText = formatViewResponse(observations, searchResults, args.detail, args.id !== void 0).content[0].text;
				return textResponse$4(prependNotifications$4(notificationStore, projectHash, originalText));
			}
			if (args.action === "purge") {
				const targetIds = args.ids ?? (args.id ? [args.id] : []);
				let success = 0;
				const failures = [];
				for (const targetId of targetIds) if (repo.softDelete(targetId)) success++;
				else failures.push(targetId);
				debug("mcp", "recall: purge", {
					success,
					total: targetIds.length
				});
				let msg = `Purged ${success}/${targetIds.length} memories.`;
				if (failures.length > 0) msg += ` Not found or already purged: ${failures.join(", ")}`;
				return withNotifications(msg);
			}
			if (args.action === "restore") {
				const targetIds = args.ids ?? (args.id ? [args.id] : []);
				let success = 0;
				const failures = [];
				for (const targetId of targetIds) if (repo.restore(targetId)) success++;
				else failures.push(targetId);
				debug("mcp", "recall: restore", {
					success,
					total: targetIds.length
				});
				let msg = `Restored ${success}/${targetIds.length} memories.`;
				if (failures.length > 0) msg += ` Not found: ${failures.join(", ")}`;
				return withNotifications(msg);
			}
			return errorResponse$1(`Unknown action: ${args.action}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "recall: error", { error: message });
			return errorResponse$1(`Recall error: ${message}`);
		}
	});
}
function formatViewResponse(observations, searchResults, detail, isSingleIdLookup) {
	let body;
	let truncated;
	let tokenEstimate;
	if (detail === "compact") {
		const scoreMap = buildScoreMap(searchResults);
		const result = enforceTokenBudget(observations, (obs) => formatCompactItem(obs, observations.indexOf(obs) + 1, scoreMap.get(obs.id)), TOKEN_BUDGET);
		body = result.items.map((obs, i) => formatCompactItem(obs, i + 1, scoreMap.get(obs.id))).join("\n");
		truncated = result.truncated;
		tokenEstimate = result.tokenEstimate;
	} else if (detail === "timeline") {
		const groups = /* @__PURE__ */ new Map();
		const scoreMap = buildScoreMap(searchResults);
		for (const obs of observations) {
			const date = dateStr(obs.createdAt);
			if (!groups.has(date)) groups.set(date, []);
			groups.get(date).push({
				obs,
				score: scoreMap.get(obs.id)
			});
		}
		const result = enforceTokenBudget(observations, (obs) => {
			return `${timeStr(obs.createdAt)} | ${obs.title ?? "untitled"} | ${obs.source} | ${snippetText(obs.content, 150)}`;
		}, TOKEN_BUDGET);
		const includedIds = new Set(result.items.map((o) => o.id));
		const filteredGroups = /* @__PURE__ */ new Map();
		for (const [date, items] of groups) {
			const filtered = items.filter((item) => includedIds.has(item.obs.id));
			if (filtered.length > 0) filteredGroups.set(date, filtered);
		}
		body = Array.from(filteredGroups.entries()).map(([date, items]) => formatTimelineGroup(date, items)).join("\n\n");
		truncated = result.truncated;
		tokenEstimate = result.tokenEstimate;
	} else {
		const budget = isSingleIdLookup ? FULL_VIEW_BUDGET : TOKEN_BUDGET;
		if (observations.length === 1) {
			const formatted = formatFullItem(observations[0]);
			tokenEstimate = estimateTokens(formatted);
			if (tokenEstimate > budget) {
				const maxChars = budget * 4;
				body = formatted.slice(0, maxChars) + `\n[...truncated at ~${budget} tokens]`;
				truncated = true;
				tokenEstimate = budget;
			} else {
				body = formatted;
				truncated = false;
			}
		} else {
			const result = enforceTokenBudget(observations, formatFullItem, budget);
			body = result.items.map(formatFullItem).join("\n\n");
			truncated = result.truncated;
			tokenEstimate = result.tokenEstimate;
		}
	}
	let footer = `---\n${observations.length} result(s) | ~${tokenEstimate} tokens | detail: ${detail}`;
	if (truncated) footer += " | truncated (use id for full view)";
	return textResponse$4(`${body}\n${footer}`);
}
function buildScoreMap(searchResults) {
	const map = /* @__PURE__ */ new Map();
	if (searchResults) for (const r of searchResults) map.set(r.observation.id, r.score);
	return map;
}

//#endregion
//#region src/mcp/tools/save-memory.ts
/**
* Generates a title from observation content.
* Extracts the first sentence (up to 100 chars) or first 80 chars with ellipsis.
*/
function generateTitle(content) {
	const firstSentence = content.match(/^[^.!?\n]+[.!?]?/);
	if (firstSentence && firstSentence[0].length <= 100) return firstSentence[0].trim();
	if (content.length <= 80) return content.trim();
	return content.slice(0, 80).trim() + "...";
}
/**
* Registers the save_memory tool on the MCP server.
*
* save_memory persists user-provided text as a new observation with an optional title.
* If title is omitted, one is auto-generated from the text content.
*/
function registerSaveMemory(server, db, projectHash, notificationStore = null) {
	server.registerTool("save_memory", {
		title: "Save Memory",
		description: "Save a new memory observation. Provide text content and an optional title. If title is omitted, one is auto-generated from the text.",
		inputSchema: {
			text: z.string().min(1).max(1e4).describe("The text content to save as a memory"),
			title: z.string().max(200).optional().describe("Optional title for the memory. Auto-generated from text if omitted."),
			source: z.string().default("manual").describe("Source identifier (e.g., manual, hook:PostToolUse)")
		}
	}, async (args) => {
		try {
			const repo = new ObservationRepository(db, projectHash);
			const resolvedTitle = args.title ?? generateTitle(args.text);
			const obs = repo.create({
				content: args.text,
				title: resolvedTitle,
				source: args.source
			});
			debug("mcp", "save_memory: saved", {
				id: obs.id,
				title: resolvedTitle
			});
			let responseText = `Saved memory "${resolvedTitle}" (id: ${obs.id})`;
			if (notificationStore) {
				const pending = notificationStore.consumePending(projectHash);
				if (pending.length > 0) responseText = pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
			}
			return { content: [{
				type: "text",
				text: responseText
			}] };
		} catch (err) {
			return {
				content: [{
					type: "text",
					text: `Failed to save: ${err instanceof Error ? err.message : "Unknown error"}`
				}],
				isError: true
			};
		}
	});
}

//#endregion
//#region src/commands/resume.ts
/**
* Returns a human-readable relative time string from an ISO date.
* Examples: "just now", "2 minutes ago", "3 hours ago", "yesterday", "5 days ago"
*/
function timeAgo(dateString, now) {
	const date = new Date(dateString);
	const diffMs = (now ?? /* @__PURE__ */ new Date()).getTime() - date.getTime();
	if (diffMs < 0) return "just now";
	const seconds = Math.floor(diffMs / 1e3);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes === 1) return "1 minute ago";
	if (minutes < 60) return `${minutes} minutes ago`;
	const hours = Math.floor(minutes / 60);
	if (hours === 1) return "1 hour ago";
	if (hours < 24) return `${hours} hours ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 30) return `${days} days ago`;
	const months = Math.floor(days / 30);
	if (months === 1) return "1 month ago";
	return `${months} months ago`;
}

//#endregion
//#region src/mcp/tools/topic-context.ts
function truncate(text, maxLen) {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "...";
}
/**
* Compact format: numbered list of topic labels with relative time.
*/
function formatCompact(stashes) {
	return stashes.map((s, i) => `${i + 1}. ${s.topicLabel} (${timeAgo(s.createdAt)})`).join("\n");
}
/**
* Detail format: topic labels with summaries.
*/
function formatDetail(stashes) {
	return stashes.map((s, i) => `${i + 1}. **${s.topicLabel}** (${timeAgo(s.createdAt)})\n   ${truncate(s.summary, 120)}`).join("\n\n");
}
/**
* Full format: topic labels, summaries, observation count, and first few observation snippets.
*/
function formatFull(stashes) {
	return stashes.map((s, i) => {
		const lines = [
			`${i + 1}. **${s.topicLabel}** (${timeAgo(s.createdAt)})`,
			`   ${s.summary}`,
			`   Observations: ${s.observationSnapshots.length}`
		];
		const previews = s.observationSnapshots.slice(0, 3);
		for (const obs of previews) lines.push(`   - ${truncate(obs.content.replace(/\n/g, " "), 80)}`);
		if (s.observationSnapshots.length > 3) lines.push(`   ... and ${s.observationSnapshots.length - 3} more`);
		return lines.join("\n");
	}).join("\n\n");
}
/**
* Formats stashes using progressive disclosure based on count.
* - 1-3 stashes: full detail
* - 4-8 stashes: detail (summaries)
* - 9+: compact (labels only)
*/
function formatStashes(stashes) {
	if (stashes.length <= 3) return formatFull(stashes);
	if (stashes.length <= 8) return formatDetail(stashes);
	return formatCompact(stashes);
}
function prependNotifications$3(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$3(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
/**
* Registers the topic_context MCP tool.
*
* Shows recently stashed context threads. Used when the user asks
* "where was I?" or wants to see abandoned conversation threads.
*/
function registerTopicContext(server, db, projectHash, notificationStore = null) {
	const stashManager = new StashManager(db);
	server.registerTool("topic_context", {
		title: "Topic Context",
		description: "Shows recently stashed context threads. Use when the user asks 'where was I?' or wants to see abandoned conversation threads.",
		inputSchema: {
			query: z.string().optional().describe("Optional search query to filter threads by topic label or summary"),
			limit: z.number().int().min(1).max(20).default(5).describe("Max threads to return")
		}
	}, async (args) => {
		const withNotifications = (text) => textResponse$3(prependNotifications$3(notificationStore, projectHash, text));
		try {
			debug("mcp", "topic_context: request", {
				query: args.query,
				limit: args.limit
			});
			let stashes = stashManager.getRecentStashes(projectHash, args.limit);
			if (args.query) {
				const q = args.query.toLowerCase();
				stashes = stashes.filter((s) => s.topicLabel.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q));
			}
			if (stashes.length === 0) return withNotifications("No stashed context threads found. You're working in a single thread.");
			const formatted = formatStashes(stashes);
			const footer = `\n---\n${stashes.length} stashed thread(s) | Use /laminark:resume {id} to restore`;
			debug("mcp", "topic_context: returning", { count: stashes.length });
			return withNotifications(formatted + footer);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "topic_context: error", { error: message });
			return textResponse$3(`Error retrieving context threads: ${message}`);
		}
	});
}

//#endregion
//#region src/graph/types.ts
/**
* Type definitions for the knowledge graph.
*
* Defines a fixed entity/relationship taxonomy using const arrays and
* derived union types (NOT enums) for better type inference and runtime
* validation. Every Phase 7 module imports from this file.
*/
const ENTITY_TYPES = [
	"Project",
	"File",
	"Decision",
	"Problem",
	"Solution",
	"Tool",
	"Person"
];
const RELATIONSHIP_TYPES = [
	"uses",
	"depends_on",
	"decided_by",
	"related_to",
	"part_of",
	"caused_by",
	"solved_by"
];
/**
* Runtime type guard for EntityType.
* Uses the ENTITY_TYPES const array for O(n) lookup (n=7, negligible).
*/
function isEntityType(s) {
	return ENTITY_TYPES.includes(s);
}
/**
* Runtime type guard for RelationshipType.
* Uses the RELATIONSHIP_TYPES const array for O(n) lookup (n=7, negligible).
*/
function isRelationshipType(s) {
	return RELATIONSHIP_TYPES.includes(s);
}
/**
* Maximum number of edges a single node can have.
* Used by constraint enforcement in Plan 05 to prevent
* hub nodes from dominating the graph.
*/
const MAX_NODE_DEGREE = 50;

//#endregion
//#region src/graph/migrations/001-graph-tables.ts
/**
* Migration 001: Create graph_nodes and graph_edges tables.
*
* Graph tables are managed separately from the main observation/session tables
* because the knowledge graph is a distinct subsystem (Phase 7) that operates
* on extracted entities rather than raw observations.
*
* Tables:
*   - graph_nodes: entities with type-checked taxonomy (7 types)
*   - graph_edges: directed relationships with type-checked taxonomy (7 types),
*     weight confidence, and unique constraint on (source_id, target_id, type)
*
* Indexes:
*   - Nodes: type, name
*   - Edges: source_id, target_id, type, unique(source_id, target_id, type)
*/
const up = `
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('Project','File','Decision','Problem','Solution','Tool','Person')),
    name TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    observation_ids TEXT DEFAULT '[]',
    project_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('uses','depends_on','decided_by','related_to','part_of','caused_by','solved_by')),
    weight REAL NOT NULL DEFAULT 1.0 CHECK(weight >= 0.0 AND weight <= 1.0),
    metadata TEXT DEFAULT '{}',
    project_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique ON graph_edges(source_id, target_id, type);
`;

//#endregion
//#region src/graph/schema.ts
function rowToNode(row) {
	return {
		id: row.id,
		type: row.type,
		name: row.name,
		metadata: JSON.parse(row.metadata),
		observation_ids: JSON.parse(row.observation_ids),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}
function rowToEdge(row) {
	return {
		id: row.id,
		source_id: row.source_id,
		target_id: row.target_id,
		type: row.type,
		weight: row.weight,
		metadata: JSON.parse(row.metadata),
		created_at: row.created_at
	};
}
/**
* Initializes graph tables if they do not exist.
* Uses CREATE TABLE IF NOT EXISTS so it is safe to call multiple times.
*/
function initGraphSchema(db) {
	db.exec(up);
}
/**
* Traverses the graph from a starting node using a recursive CTE.
*
* Supports directional traversal:
*   - 'outgoing': follows edges where source_id matches (default)
*   - 'incoming': follows edges where target_id matches
*   - 'both': follows edges in either direction
*
* Returns nodes and the edges that connect them, up to the specified depth.
* The starting node itself is NOT included in results (depth > 0 filter).
*
* @param db - better-sqlite3 Database handle
* @param nodeId - starting node ID
* @param opts - traversal options (depth, edgeTypes, direction)
* @returns Array of { node, edge, depth } for each reachable node
*/
function traverseFrom(db, nodeId, opts = {}) {
	const maxDepth = opts.depth ?? 2;
	const direction = opts.direction ?? "outgoing";
	let edgeTypeFilter = "";
	if (opts.edgeTypes && opts.edgeTypes.length > 0) edgeTypeFilter = `AND e.type IN (${opts.edgeTypes.map(() => "?").join(", ")})`;
	let recursiveStep;
	if (direction === "outgoing") recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	else if (direction === "incoming") recursiveStep = `
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	else recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      UNION ALL
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	const sql = `
    WITH RECURSIVE traverse(node_id, depth, edge_id) AS (
      SELECT ?, 0, NULL
      UNION ALL
      ${recursiveStep}
    )
    SELECT DISTINCT
      n.id AS n_id, n.type AS n_type, n.name AS n_name,
      n.metadata AS n_metadata, n.observation_ids AS n_observation_ids,
      n.created_at AS n_created_at, n.updated_at AS n_updated_at,
      e.id AS e_id, e.source_id AS e_source_id, e.target_id AS e_target_id,
      e.type AS e_type, e.weight AS e_weight, e.metadata AS e_metadata,
      e.created_at AS e_created_at,
      t.depth
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.node_id
    LEFT JOIN graph_edges e ON e.id = t.edge_id
    WHERE t.depth > 0
  `;
	const queryParams = [nodeId];
	if (direction === "both") {
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
	} else {
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
	}
	return db.prepare(sql).all(...queryParams).map((row) => ({
		node: {
			id: row.n_id,
			type: row.n_type,
			name: row.n_name,
			metadata: JSON.parse(row.n_metadata),
			observation_ids: JSON.parse(row.n_observation_ids),
			created_at: row.n_created_at,
			updated_at: row.n_updated_at
		},
		edge: row.e_id ? {
			id: row.e_id,
			source_id: row.e_source_id,
			target_id: row.e_target_id,
			type: row.e_type,
			weight: row.e_weight,
			metadata: JSON.parse(row.e_metadata),
			created_at: row.e_created_at
		} : null,
		depth: row.depth
	}));
}
/**
* Returns all nodes of a given entity type.
*/
function getNodesByType(db, type) {
	return db.prepare("SELECT * FROM graph_nodes WHERE type = ?").all(type).map(rowToNode);
}
/**
* Looks up a node by name and type (composite natural key).
* Returns null if no matching node exists.
*/
function getNodeByNameAndType(db, name, type) {
	const row = db.prepare("SELECT * FROM graph_nodes WHERE name = ? AND type = ?").get(name, type);
	return row ? rowToNode(row) : null;
}
/**
* Returns edges connected to a node, filtered by direction.
*
* @param direction - 'outgoing' (source), 'incoming' (target), or 'both' (default: 'both')
*/
function getEdgesForNode(db, nodeId, opts) {
	const direction = opts?.direction ?? "both";
	let sql;
	let params;
	if (direction === "outgoing") {
		sql = "SELECT * FROM graph_edges WHERE source_id = ?";
		params = [nodeId];
	} else if (direction === "incoming") {
		sql = "SELECT * FROM graph_edges WHERE target_id = ?";
		params = [nodeId];
	} else {
		sql = "SELECT * FROM graph_edges WHERE source_id = ? OR target_id = ?";
		params = [nodeId, nodeId];
	}
	return db.prepare(sql).all(...params).map(rowToEdge);
}
/**
* Returns the total number of edges connected to a node (both directions).
* Used for degree enforcement (MAX_NODE_DEGREE constraint).
*/
function countEdgesForNode(db, nodeId) {
	return db.prepare("SELECT COUNT(*) as cnt FROM graph_edges WHERE source_id = ? OR target_id = ?").get(nodeId, nodeId).cnt;
}
/**
* Inserts or updates a node by name+type composite key.
*
* If a node with the same name and type already exists, updates its metadata
* and merges observation_ids. Otherwise, inserts a new node with a generated UUID.
*
* @returns The upserted GraphNode
*/
function upsertNode(db, node) {
	const existing = getNodeByNameAndType(db, node.name, node.type);
	if (existing) {
		const mergedObsIds = [...new Set([...existing.observation_ids, ...node.observation_ids])];
		const mergedMetadata = {
			...existing.metadata,
			...node.metadata
		};
		db.prepare(`UPDATE graph_nodes
       SET metadata = ?, observation_ids = ?, updated_at = datetime('now')
       WHERE id = ?`).run(JSON.stringify(mergedMetadata), JSON.stringify(mergedObsIds), existing.id);
		return rowToNode(db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(existing.id));
	}
	const id = node.id ?? randomBytes(16).toString("hex");
	db.prepare(`INSERT INTO graph_nodes (id, type, name, metadata, observation_ids, project_hash)
     VALUES (?, ?, ?, ?, ?, ?)`).run(id, node.type, node.name, JSON.stringify(node.metadata), JSON.stringify(node.observation_ids), node.project_hash ?? null);
	return rowToNode(db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id));
}
/**
* Inserts an edge. On conflict (same source_id, target_id, type),
* updates the weight to the maximum of existing and new values.
*
* @returns The inserted or updated GraphEdge
*/
function insertEdge(db, edge) {
	const id = edge.id ?? randomBytes(16).toString("hex");
	db.prepare(`INSERT INTO graph_edges (id, source_id, target_id, type, weight, metadata, project_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, target_id, type) DO UPDATE SET
       weight = MAX(graph_edges.weight, excluded.weight),
       metadata = excluded.metadata`).run(id, edge.source_id, edge.target_id, edge.type, edge.weight, JSON.stringify(edge.metadata), edge.project_hash ?? null);
	return rowToEdge(db.prepare("SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?").get(edge.source_id, edge.target_id, edge.type));
}

//#endregion
//#region src/mcp/tools/query-graph.ts
function truncateText(text, maxLen) {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen).trimEnd() + "...";
}
function formatEntityType(type) {
	return `[${type}]`;
}
/**
* Formats query results as readable text for Claude consumption.
* Uses progressive disclosure: entity list -> relationships -> observations.
*/
function formatResults(rootNodes, traversalsByNode, observations, query) {
	const lines = [];
	lines.push("## Entities Found");
	lines.push("");
	for (const node of rootNodes) {
		const traversals = traversalsByNode.get(node.id) ?? [];
		const connectionCount = traversals.length;
		lines.push(`- ${formatEntityType(node.type)} ${node.name} (${connectionCount} connection${connectionCount !== 1 ? "s" : ""})`);
		for (const t of traversals) {
			if (!t.edge) continue;
			const direction = t.edge.source_id === node.id ? "->" : "<-";
			lines.push(`  ${direction} ${t.edge.type} ${formatEntityType(t.node.type)} ${t.node.name}`);
		}
		lines.push("");
	}
	if (observations.length > 0) {
		lines.push("## Related Observations");
		lines.push("");
		for (const obs of observations) {
			const age = formatAge(obs.createdAt);
			const snippet = truncateText(obs.text.replace(/\n/g, " "), 200);
			lines.push(`- "${snippet}" (${age})`);
		}
	}
	return lines.join("\n").trim();
}
/**
* Simple relative time formatting.
*/
function formatAge(isoDate) {
	const diffMs = Date.now() - new Date(isoDate).getTime();
	const hours = Math.floor(diffMs / (1e3 * 60 * 60));
	if (hours < 1) return "just now";
	if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`;
	const months = Math.floor(days / 30);
	return `${months} month${months !== 1 ? "s" : ""} ago`;
}
function prependNotifications$2(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$2(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function errorResponse(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
/**
* Registers the query_graph MCP tool on the server.
*
* Allows Claude to search entities by name (exact or fuzzy), filter by type,
* traverse relationships to configurable depth, and see linked observations.
*/
function registerQueryGraph(server, db, projectHash, notificationStore = null) {
	initGraphSchema(db);
	server.registerTool("query_graph", {
		title: "Query Knowledge Graph",
		description: "Query the knowledge graph to find entities and their relationships. Use to answer questions like 'what files does this decision affect?' or 'what tools does this project use?'",
		inputSchema: {
			query: z.string().min(1).describe("Entity name or search text to look for"),
			entity_type: z.string().optional().describe(`Filter to entity type: ${ENTITY_TYPES.join(", ")}`),
			depth: z.number().int().min(1).max(4).default(2).describe("Traversal depth (default: 2, max: 4)"),
			relationship_types: z.array(z.string()).optional().describe(`Filter to relationship types: ${RELATIONSHIP_TYPES.join(", ")}`),
			limit: z.number().int().min(1).max(50).default(20).describe("Max root entities to return (default: 20, max: 50)")
		}
	}, async (args) => {
		const withNotifications = (text) => textResponse$2(prependNotifications$2(notificationStore, projectHash, text));
		try {
			debug("mcp", "query_graph: request", {
				query: args.query,
				entity_type: args.entity_type,
				depth: args.depth
			});
			if (args.entity_type !== void 0 && !isEntityType(args.entity_type)) return errorResponse(`Invalid entity_type "${args.entity_type}". Valid types: ${ENTITY_TYPES.join(", ")}`);
			const entityType = args.entity_type;
			if (args.relationship_types) {
				for (const rt of args.relationship_types) if (!isRelationshipType(rt)) return errorResponse(`Invalid relationship_type "${rt}". Valid types: ${RELATIONSHIP_TYPES.join(", ")}`);
			}
			const relationshipTypes = args.relationship_types;
			const rootNodes = [];
			if (entityType) {
				const exact = getNodeByNameAndType(db, args.query, entityType);
				if (exact) rootNodes.push(exact);
			} else for (const t of ENTITY_TYPES) {
				const exact = getNodeByNameAndType(db, args.query, t);
				if (exact) {
					rootNodes.push(exact);
					break;
				}
			}
			if (rootNodes.length === 0) {
				const likePattern = `%${args.query}%`;
				let sql;
				const params = [likePattern];
				if (entityType) {
					sql = "SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE AND type = ? LIMIT ?";
					params.push(entityType, args.limit);
				} else {
					sql = "SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE LIMIT ?";
					params.push(args.limit);
				}
				const rows = db.prepare(sql).all(...params);
				for (const row of rows) rootNodes.push({
					id: row.id,
					type: row.type,
					name: row.name,
					metadata: JSON.parse(row.metadata),
					observation_ids: JSON.parse(row.observation_ids),
					created_at: row.created_at,
					updated_at: row.updated_at
				});
			}
			if (rootNodes.length === 0) {
				const suggestions = entityType ? `Try searching without the entity_type filter, or try a different name.` : `Try: entity types ${ENTITY_TYPES.join(", ")}`;
				return withNotifications(`No entities matching "${args.query}" found. ${suggestions}`);
			}
			const traversalsByNode = /* @__PURE__ */ new Map();
			for (const node of rootNodes) {
				const results = traverseFrom(db, node.id, {
					depth: args.depth,
					edgeTypes: relationshipTypes,
					direction: "both"
				});
				traversalsByNode.set(node.id, results);
			}
			const allObsIds = /* @__PURE__ */ new Set();
			for (const node of rootNodes) for (const obsId of node.observation_ids) allObsIds.add(obsId);
			const observations = [];
			if (allObsIds.size > 0) {
				const obsIdList = [...allObsIds];
				const placeholders = obsIdList.map(() => "?").join(", ");
				const obsRows = db.prepare(`SELECT content, created_at FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`).all(...obsIdList);
				for (const row of obsRows) observations.push({
					text: row.content,
					createdAt: row.created_at
				});
			}
			const formatted = formatResults(rootNodes, traversalsByNode, observations, args.query);
			debug("mcp", "query_graph: returning", {
				rootNodes: rootNodes.length,
				totalTraversals: [...traversalsByNode.values()].reduce((sum, arr) => sum + arr.length, 0),
				observations: observations.length
			});
			return withNotifications(formatted);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "query_graph: error", { error: message });
			return errorResponse(`Graph query error: ${message}`);
		}
	});
}

//#endregion
//#region src/graph/staleness.ts
/**
* Negation patterns: newer observation negates older one.
* Matches when newer text contains negation keywords absent in older text
* and both discuss similar subjects.
*/
const NEGATION_KEYWORDS = [
	"not",
	"don't",
	"no longer",
	"stopped",
	"never",
	"doesn't",
	"won't",
	"isn't",
	"aren't",
	"discontinued"
];
/**
* Replacement patterns: newer observation explicitly replaces older approach.
*/
const REPLACEMENT_PATTERNS = [
	/switched\s+(?:from\s+\S+\s+)?to\b/i,
	/migrated\s+(?:from\s+\S+\s+)?to\b/i,
	/replaced\s+(?:\S+\s+)?with\b/i,
	/changed\s+from\b/i,
	/moved\s+(?:from\s+\S+\s+)?to\b/i,
	/upgraded\s+(?:from\s+\S+\s+)?to\b/i,
	/swapped\s+(?:\S+\s+)?(?:for|with)\b/i
];
/**
* Status change patterns: newer observation marks something as inactive.
*/
const STATUS_CHANGE_KEYWORDS = [
	"removed",
	"deleted",
	"deprecated",
	"archived",
	"dropped",
	"disabled",
	"decommissioned",
	"sunset",
	"abandoned"
];
/**
* Creates the staleness_flags table if it doesn't exist.
* Uses a separate table rather than modifying the observations table,
* keeping staleness metadata decoupled from core observation storage.
*/
function initStalenessSchema(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS staleness_flags (
      observation_id TEXT PRIMARY KEY,
      flagged_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_staleness_resolved ON staleness_flags(resolved);
  `);
}
/**
* Detects potential staleness (contradictions) between observations
* linked to a specific entity.
*
* Compares consecutive observation pairs chronologically and checks for:
* 1. Negation patterns (newer negates older)
* 2. Replacement patterns (newer replaces older approach)
* 3. Status change patterns (newer marks something as inactive)
*
* This is DETECTION ONLY -- no data is modified.
*
* @param db - better-sqlite3 Database handle
* @param entityId - Graph node ID to check observations for
* @returns Array of StalenessReport for each detected contradiction
*/
function detectStaleness(db, entityId) {
	const node = db.prepare("SELECT id, name, type, observation_ids FROM graph_nodes WHERE id = ?").get(entityId);
	if (!node) return [];
	const obsIds = JSON.parse(node.observation_ids);
	if (obsIds.length < 2) return [];
	const placeholders = obsIds.map(() => "?").join(", ");
	const observations = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at ASC`).all(...obsIds).map(rowToObservation);
	if (observations.length < 2) return [];
	const reports = [];
	const now = (/* @__PURE__ */ new Date()).toISOString();
	for (let i = 0; i < observations.length - 1; i++) {
		const older = observations[i];
		const newer = observations[i + 1];
		const reason = detectContradiction(older.content, newer.content);
		if (reason) reports.push({
			entityId: node.id,
			entityName: node.name,
			entityType: node.type,
			newerObservation: {
				id: newer.id,
				text: newer.content,
				created_at: newer.createdAt
			},
			olderObservation: {
				id: older.id,
				text: older.content,
				created_at: older.createdAt
			},
			reason,
			detectedAt: now
		});
	}
	return reports;
}
/**
* Detects contradiction between two observation texts.
* Returns a human-readable reason string, or null if no contradiction found.
*/
function detectContradiction(olderText, newerText) {
	const olderLower = olderText.toLowerCase();
	const newerLower = newerText.toLowerCase();
	const negationResult = detectNegation(olderLower, newerLower);
	if (negationResult) return negationResult;
	const replacementResult = detectReplacement(newerLower);
	if (replacementResult) return replacementResult;
	const statusResult = detectStatusChange(olderLower, newerLower);
	if (statusResult) return statusResult;
	return null;
}
/**
* Detects negation: newer text contains negation keywords that are absent
* in the older text, suggesting the newer observation contradicts the older.
*/
function detectNegation(olderLower, newerLower) {
	for (const keyword of NEGATION_KEYWORDS) if (newerLower.includes(keyword) && !olderLower.includes(keyword)) return `Newer observation contains negation ("${keyword}") not present in older observation`;
	return null;
}
/**
* Detects replacement: newer text explicitly mentions switching/replacing.
*/
function detectReplacement(newerLower) {
	for (const pattern of REPLACEMENT_PATTERNS) {
		const match = newerLower.match(pattern);
		if (match) return `Newer observation indicates replacement ("${match[0].trim()}")`;
	}
	return null;
}
/**
* Detects status change: newer text marks something as removed/deprecated
* when the older text described it as active/present.
*/
function detectStatusChange(olderLower, newerLower) {
	for (const keyword of STATUS_CHANGE_KEYWORDS) if (newerLower.includes(keyword) && !olderLower.includes(keyword)) return `Newer observation indicates status change ("${keyword}")`;
	return null;
}
/**
* Flags an observation as stale with an advisory reason.
*
* This flag is advisory -- search can use it to deprioritize but never hide
* the observation. The observation remains fully queryable.
*
* Uses INSERT OR REPLACE to allow re-flagging with an updated reason.
*
* @param db - better-sqlite3 Database handle
* @param observationId - ID of the observation to flag
* @param reason - Human-readable explanation of why it's stale
*/
function flagStaleObservation(db, observationId, reason) {
	initStalenessSchema(db);
	db.prepare(`INSERT OR REPLACE INTO staleness_flags (observation_id, reason, resolved)
     VALUES (?, ?, 0)`).run(observationId, reason);
}

//#endregion
//#region src/mcp/tools/graph-stats.ts
/**
* Collects comprehensive graph statistics directly from the database.
* Does not depend on constraints module (which may not be built yet).
*/
function collectGraphStats(db) {
	const totalNodes = db.prepare("SELECT COUNT(*) as cnt FROM graph_nodes").get().cnt;
	const totalEdges = db.prepare("SELECT COUNT(*) as cnt FROM graph_edges").get().cnt;
	const entityCounts = db.prepare("SELECT type, COUNT(*) as cnt FROM graph_nodes GROUP BY type").all();
	const byEntityType = {};
	for (const t of ENTITY_TYPES) byEntityType[t] = 0;
	for (const row of entityCounts) byEntityType[row.type] = row.cnt;
	const relCounts = db.prepare("SELECT type, COUNT(*) as cnt FROM graph_edges GROUP BY type").all();
	const byRelType = {};
	for (const t of RELATIONSHIP_TYPES) byRelType[t] = 0;
	for (const row of relCounts) byRelType[row.type] = row.cnt;
	const avgDegree = totalNodes > 0 ? totalEdges * 2 / totalNodes : 0;
	const degreeRows = db.prepare(`SELECT n.id as node_id, n.name as node_name, n.type as node_type,
              (SELECT COUNT(*) FROM graph_edges WHERE source_id = n.id OR target_id = n.id) as degree
       FROM graph_nodes n
       ORDER BY degree DESC
       LIMIT 10`).all();
	let maxDegreeEntry = null;
	const hotspots = [];
	const hotspotThreshold = Math.floor(MAX_NODE_DEGREE * .8);
	for (const row of degreeRows) {
		if (!maxDegreeEntry || row.degree > maxDegreeEntry.degree) maxDegreeEntry = {
			node_name: row.node_name,
			node_type: row.node_type,
			degree: row.degree
		};
		if (row.degree >= hotspotThreshold) hotspots.push({
			name: row.node_name,
			type: row.node_type,
			degree: row.degree
		});
	}
	const dupCount = db.prepare(`SELECT COUNT(*) as cnt FROM (
            SELECT name FROM graph_nodes GROUP BY name HAVING COUNT(DISTINCT type) > 1
          )`).get().cnt;
	let stalenessCount = 0;
	try {
		initStalenessSchema(db);
		stalenessCount = db.prepare("SELECT COUNT(*) as cnt FROM staleness_flags WHERE resolved = 0").get().cnt;
	} catch {
		stalenessCount = 0;
	}
	return {
		total_nodes: totalNodes,
		total_edges: totalEdges,
		by_entity_type: byEntityType,
		by_relationship_type: byRelType,
		avg_degree: Math.round(avgDegree * 10) / 10,
		max_degree: maxDegreeEntry,
		hotspots,
		duplicate_candidates: dupCount,
		staleness_flags: stalenessCount
	};
}
/**
* Formats graph stats as a readable dashboard for Claude.
*/
function formatStats(stats) {
	const lines = [];
	lines.push("## Knowledge Graph Stats");
	lines.push(`Nodes: ${stats.total_nodes} | Edges: ${stats.total_edges} | Avg degree: ${stats.avg_degree}`);
	lines.push("");
	lines.push("### Entity Distribution");
	const entityParts = [];
	for (const t of ENTITY_TYPES) {
		const count = stats.by_entity_type[t] ?? 0;
		if (count > 0) entityParts.push(`${t}: ${count}`);
	}
	lines.push(entityParts.length > 0 ? entityParts.join(" | ") : "No entities yet");
	lines.push("");
	lines.push("### Relationship Distribution");
	const relParts = [];
	for (const t of RELATIONSHIP_TYPES) {
		const count = stats.by_relationship_type[t] ?? 0;
		if (count > 0) relParts.push(`${t}: ${count}`);
	}
	lines.push(relParts.length > 0 ? relParts.join(" | ") : "No relationships yet");
	lines.push("");
	lines.push("### Health");
	if (stats.hotspots.length > 0) {
		const hotspotStr = stats.hotspots.map((h) => `${h.name} (${h.degree} edges)`).join(", ");
		lines.push(`Hotspots (near ${MAX_NODE_DEGREE}-edge limit): ${hotspotStr}`);
	} else lines.push("Hotspots: none (all nodes well within edge limits)");
	lines.push(`Duplicate candidates: ${stats.duplicate_candidates} name${stats.duplicate_candidates !== 1 ? "s" : ""}`);
	lines.push(`Stale observations: ${stats.staleness_flags}`);
	if (stats.max_degree) {
		lines.push("");
		lines.push(`Most connected: ${stats.max_degree.node_name} (${stats.max_degree.node_type}, ${stats.max_degree.degree} edges)`);
	}
	return lines.join("\n");
}
function prependNotifications$1(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$1(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
/**
* Registers the graph_stats MCP tool on the server.
*
* Returns comprehensive knowledge graph health metrics: entity/relationship
* type distribution, degree statistics, hotspot nodes, duplicate candidates,
* and staleness flags. No input parameters -- dashboard view.
*/
function registerGraphStats(server, db, projectHash, notificationStore = null) {
	initGraphSchema(db);
	server.registerTool("graph_stats", {
		title: "Graph Statistics",
		description: "Get knowledge graph statistics: entity counts, relationship distribution, health metrics. Use to understand the state of accumulated knowledge.",
		inputSchema: {}
	}, async () => {
		try {
			debug("mcp", "graph_stats: request");
			const stats = collectGraphStats(db);
			const formatted = formatStats(stats);
			debug("mcp", "graph_stats: returning", {
				nodes: stats.total_nodes,
				edges: stats.total_edges
			});
			return textResponse$1(prependNotifications$1(notificationStore, projectHash, formatted));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "graph_stats: error", { error: message });
			return textResponse$1(`Graph stats error: ${message}`);
		}
	});
}

//#endregion
//#region src/mcp/tools/status.ts
function collectStatus(db, projectHash, projectPath, hasVectorSupport, workerReady) {
	const totalObs = db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL").get(projectHash).cnt;
	const embeddedObs = db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL AND embedding_model IS NOT NULL").get(projectHash).cnt;
	const deletedObs = db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NOT NULL").get(projectHash).cnt;
	const sessions = db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM observations WHERE project_hash = ? AND session_id IS NOT NULL AND deleted_at IS NULL").get(projectHash).cnt;
	let stashes = 0;
	try {
		stashes = db.prepare("SELECT COUNT(*) as cnt FROM context_stashes WHERE project_hash = ? AND status = 'stashed'").get(projectHash).cnt;
	} catch {}
	const totalChars = db.prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) as chars FROM observations WHERE project_hash = ? AND deleted_at IS NULL").get(projectHash).chars;
	let graphNodes = 0;
	let graphEdges = 0;
	try {
		graphNodes = db.prepare("SELECT COUNT(*) as cnt FROM graph_nodes").get().cnt;
		graphEdges = db.prepare("SELECT COUNT(*) as cnt FROM graph_edges").get().cnt;
	} catch {}
	return {
		project: {
			path: projectPath,
			hash: projectHash
		},
		database: { path: getDbPath() },
		capabilities: {
			vectorSearch: hasVectorSupport,
			embeddingWorker: workerReady
		},
		memories: {
			total: totalObs,
			embedded: embeddedObs,
			deleted: deletedObs,
			sessions,
			stashes
		},
		tokens: { estimatedTotal: estimateTokens(String("x").repeat(totalChars)) },
		graph: {
			nodes: graphNodes,
			edges: graphEdges
		},
		uptime: Math.floor(process.uptime())
	};
}
function formatUptime(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}
function formatStatus(status) {
	const lines = [];
	lines.push("## Laminark Status");
	lines.push("");
	lines.push("### Connection");
	lines.push(`Project: ${status.project.path}`);
	lines.push(`Project hash: ${status.project.hash}`);
	lines.push(`Database: ${status.database.path}`);
	lines.push(`Uptime: ${formatUptime(status.uptime)}`);
	lines.push("");
	lines.push("### Capabilities");
	lines.push(`Vector search: ${status.capabilities.vectorSearch ? "active" : "unavailable (keyword-only)"}`);
	lines.push(`Embedding worker: ${status.capabilities.embeddingWorker ? "ready" : "degraded"}`);
	lines.push("");
	lines.push("### Memories");
	lines.push(`Observations: ${status.memories.total} (${status.memories.embedded} embedded, ${status.memories.deleted} deleted)`);
	lines.push(`Sessions: ${status.memories.sessions}`);
	lines.push(`Stashed threads: ${status.memories.stashes}`);
	lines.push("");
	lines.push("### Tokens");
	lines.push(`Estimated total: ~${status.tokens.estimatedTotal.toLocaleString()} tokens across all memories`);
	lines.push("");
	lines.push("### Knowledge Graph");
	lines.push(`Nodes: ${status.graph.nodes} | Edges: ${status.graph.edges}`);
	return lines.join("\n");
}
function prependNotifications(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function registerStatus(server, db, projectHash, projectPath, hasVectorSupport, isWorkerReady, notificationStore = null) {
	server.registerTool("status", {
		title: "Laminark Status",
		description: "Show Laminark system status: connection info, memory count, token estimates, and capabilities.",
		inputSchema: {}
	}, async () => {
		try {
			debug("mcp", "status: request");
			const status = collectStatus(db, projectHash, projectPath, hasVectorSupport, isWorkerReady());
			const formatted = formatStatus(status);
			debug("mcp", "status: returning", {
				memories: status.memories.total,
				tokens: status.tokens.estimatedTotal
			});
			return textResponse(prependNotifications(notificationStore, projectHash, formatted));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "status: error", { error: message });
			return textResponse(`Status error: ${message}`);
		}
	});
}

//#endregion
//#region src/analysis/worker-bridge.ts
/**
* Main-thread bridge for the embedding worker.
*
* AnalysisWorker provides a Promise-based API (embed/embedBatch) that sends
* messages to the worker thread and resolves when results arrive. All methods
* degrade gracefully -- returning null on error/timeout rather than throwing.
*/
/** Timeout for worker startup (model loading). */
const STARTUP_TIMEOUT_MS = 3e4;
/** Timeout for individual embed requests. */
const REQUEST_TIMEOUT_MS = 3e4;
/**
* Main-thread API for sending embed requests to the worker thread.
*
* Usage:
* ```ts
* const worker = new AnalysisWorker();
* await worker.start();
* const embedding = await worker.embed("some text");
* await worker.shutdown();
* ```
*/
var AnalysisWorker = class {
	worker = null;
	pending = /* @__PURE__ */ new Map();
	nextId = 0;
	ready = false;
	engineName = "unknown";
	dimensions = 0;
	workerPath;
	constructor(workerPath) {
		if (workerPath) this.workerPath = workerPath;
		else this.workerPath = join(dirname(fileURLToPath$1(import.meta.url)), "analysis", "worker.js");
	}
	/**
	* Starts the worker thread and waits for the 'ready' message.
	*
	* Resolves once the worker reports its engine name and dimensions.
	* Times out after 30 seconds if the worker never becomes ready.
	*/
	async start() {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				debug("embed", "Worker startup timed out");
				this.ready = false;
				reject(/* @__PURE__ */ new Error("Worker startup timed out"));
			}, STARTUP_TIMEOUT_MS);
			try {
				this.worker = new Worker(this.workerPath);
			} catch (err) {
				clearTimeout(timer);
				debug("embed", "Failed to create worker", { error: String(err) });
				reject(err);
				return;
			}
			const onReady = (msg) => {
				if (msg.type === "ready") {
					clearTimeout(timer);
					this.ready = true;
					this.engineName = msg.engineName;
					this.dimensions = msg.dimensions;
					debug("embed", "Worker ready", {
						engineName: msg.engineName,
						dimensions: msg.dimensions
					});
					this.worker.off("message", onReady);
					this.worker.on("message", (m) => this.handleMessage(m));
					resolve();
				}
			};
			this.worker.on("message", onReady);
			this.worker.on("error", (err) => {
				clearTimeout(timer);
				debug("embed", "Worker error", { error: String(err) });
				this.resolveAllPending();
				this.ready = false;
			});
			this.worker.on("exit", (code) => {
				debug("embed", "Worker exited", { code });
				this.resolveAllPending();
				this.ready = false;
				this.worker = null;
			});
		});
	}
	/**
	* Embeds a single text string via the worker thread.
	*
	* Returns null if the worker is not ready, not started, or if the
	* request times out.
	*/
	async embed(text) {
		if (!this.worker || !this.ready) return null;
		const id = String(this.nextId++);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				debug("embed", "Embed request timed out", { id });
				this.pending.delete(id);
				resolve(null);
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve,
				timer
			});
			this.worker.postMessage({
				type: "embed",
				id,
				text
			});
		});
	}
	/**
	* Embeds multiple texts via the worker thread.
	*
	* Returns an array of nulls if the worker is not ready or times out.
	*/
	async embedBatch(texts) {
		if (!this.worker || !this.ready) return texts.map(() => null);
		const id = String(this.nextId++);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				debug("embed", "Batch embed request timed out", { id });
				this.pending.delete(id);
				resolve(texts.map(() => null));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve,
				timer
			});
			this.worker.postMessage({
				type: "embed_batch",
				id,
				texts
			});
		});
	}
	/**
	* Sends a shutdown message and waits for the worker to exit.
	*/
	async shutdown() {
		if (!this.worker) return;
		return new Promise((resolve) => {
			const w = this.worker;
			w.once("exit", () => {
				this.worker = null;
				this.ready = false;
				this.resolveAllPending();
				resolve();
			});
			w.postMessage({ type: "shutdown" });
			setTimeout(() => {
				if (this.worker) {
					debug("embed", "Worker shutdown timed out, terminating");
					this.worker.terminate();
				}
			}, 5e3);
		});
	}
	/** Whether the worker is started and ready. */
	isReady() {
		return this.ready;
	}
	/** The engine name reported by the worker. */
	getEngineName() {
		return this.engineName;
	}
	/** The embedding dimensions reported by the worker. */
	getDimensions() {
		return this.dimensions;
	}
	/**
	* Dispatches worker responses to the correct pending promise.
	*/
	handleMessage(msg) {
		if (msg.type === "embed_result" || msg.type === "embed_batch_result") {
			const id = msg.id;
			const req = this.pending.get(id);
			if (req) {
				clearTimeout(req.timer);
				this.pending.delete(id);
				if (msg.type === "embed_result") req.resolve(msg.embedding);
				else req.resolve(msg.embeddings);
			}
		}
	}
	/**
	* Resolves all pending requests with null (graceful degradation).
	*
	* Called on worker error or unexpected exit.
	*/
	resolveAllPending() {
		for (const [id, req] of this.pending) {
			clearTimeout(req.timer);
			req.resolve(null);
			this.pending.delete(id);
		}
	}
};

//#endregion
//#region src/hooks/topic-shift-handler.ts
/**
* Orchestrates topic shift detection and automatic stashing.
*
* Full pipeline when all dependencies provided:
*   1. Check config (enabled? manual override?)
*   2. Run detector.detect(embedding)
*   3. If adaptive manager: update EWMA and set new threshold
*   4. Log decision via decision logger
*   5. If shifted: gather observations, create stash, notify
*   6. If not shifted: return no-op result
*
* When optional deps are omitted, steps 1/3/4 are skipped gracefully.
*/
var TopicShiftHandler = class {
	detector;
	stashManager;
	observationStore;
	config;
	decisionLogger;
	adaptiveManager;
	constructor(deps) {
		this.detector = deps.detector;
		this.stashManager = deps.stashManager;
		this.observationStore = deps.observationStore;
		this.config = deps.config;
		this.decisionLogger = deps.decisionLogger;
		this.adaptiveManager = deps.adaptiveManager;
		debug("hook", "TopicShiftHandler initialized", {
			hasConfig: !!deps.config,
			hasDecisionLogger: !!deps.decisionLogger,
			hasAdaptiveManager: !!deps.adaptiveManager
		});
	}
	/**
	* Evaluate an observation for topic shift.
	*
	* If a shift is detected, gathers recent observations from the previous
	* topic, creates a stash snapshot, and returns a notification message
	* for the user.
	*/
	async handleObservation(observation, sessionId, projectId) {
		if (this.config && !this.config.enabled) {
			debug("hook", "TopicShiftHandler: detection disabled by config");
			return {
				stashed: false,
				notification: null
			};
		}
		if (!observation.embedding) {
			debug("hook", "TopicShiftHandler: no embedding, skipping", { id: observation.id });
			return {
				stashed: false,
				notification: null
			};
		}
		if (this.config?.manualThreshold !== void 0 && this.config.manualThreshold !== null) this.detector.setThreshold(this.config.manualThreshold);
		const embeddingArray = Array.from(observation.embedding);
		const result = this.detector.detect(embeddingArray);
		debug("hook", "TopicShiftHandler: detection result", {
			shifted: result.shifted,
			distance: result.distance,
			threshold: result.threshold
		});
		if (this.adaptiveManager && !(this.config?.manualThreshold !== void 0 && this.config.manualThreshold !== null)) {
			const newThreshold = this.adaptiveManager.update(result.distance);
			this.detector.setThreshold(newThreshold);
			debug("hook", "TopicShiftHandler: adaptive threshold updated", { newThreshold });
		}
		let stashId = null;
		if (result.shifted) {
			const previousObservations = this.observationStore.list({
				sessionId,
				limit: 20
			}).filter((obs) => obs.createdAt < observation.createdAt);
			const topicLabel = this.generateTopicLabel(previousObservations);
			const summary = this.generateSummary(previousObservations);
			const snapshots = previousObservations.map((obs) => ({
				id: obs.id,
				content: obs.content,
				type: obs.source,
				timestamp: obs.createdAt,
				embedding: obs.embedding ? Array.from(obs.embedding) : null
			}));
			stashId = this.stashManager.createStash({
				projectId,
				sessionId,
				topicLabel,
				summary,
				observations: snapshots
			}).id;
			debug("hook", "TopicShiftHandler: stash created", {
				topicLabel,
				stashId
			});
			if (this.decisionLogger) {
				const decision = {
					projectId,
					sessionId,
					observationId: observation.id,
					distance: result.distance,
					threshold: result.threshold,
					ewmaDistance: this.adaptiveManager?.getState().ewmaDistance ?? null,
					ewmaVariance: this.adaptiveManager?.getState().ewmaVariance ?? null,
					sensitivityMultiplier: this.config?.sensitivityMultiplier ?? 1.5,
					shifted: true,
					confidence: result.confidence,
					stashId
				};
				this.decisionLogger.log(decision);
			}
			return {
				stashed: true,
				notification: `Topic shift detected. Previous context stashed: "${topicLabel}". Use /laminark:resume to return.`
			};
		}
		if (this.decisionLogger) {
			const decision = {
				projectId,
				sessionId,
				observationId: observation.id,
				distance: result.distance,
				threshold: result.threshold,
				ewmaDistance: this.adaptiveManager?.getState().ewmaDistance ?? null,
				ewmaVariance: this.adaptiveManager?.getState().ewmaVariance ?? null,
				sensitivityMultiplier: this.config?.sensitivityMultiplier ?? 1.5,
				shifted: false,
				confidence: result.confidence,
				stashId: null
			};
			this.decisionLogger.log(decision);
		}
		return {
			stashed: false,
			notification: null
		};
	}
	/**
	* Generate a topic label from the first observation's content.
	* Uses first 50 characters, trimmed and cleaned.
	*/
	generateTopicLabel(observations) {
		if (observations.length === 0) return "Unknown topic";
		return observations[observations.length - 1].content.replace(/\n/g, " ").trim().slice(0, 50) || "Unknown topic";
	}
	/**
	* Generate a brief summary by concatenating the first 3 observation contents,
	* truncated to 200 characters total.
	*/
	generateSummary(observations) {
		if (observations.length === 0) return "";
		return observations.slice(-3).reverse().map((obs) => obs.content.replace(/\n/g, " ").trim()).join(" | ").slice(0, 200);
	}
};

//#endregion
//#region src/intelligence/topic-detector.ts
/**
* Compute cosine distance between two vectors.
*
* Returns 1 - cosineSimilarity(a, b).
* Range: [0, 2] where 0 = identical, 1 = orthogonal, 2 = opposite.
* Handles zero vectors gracefully by returning 0 (not NaN).
*/
function cosineDistance(a, b) {
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		magA += a[i] * a[i];
		magB += b[i] * b[i];
	}
	const magnitudeProduct = Math.sqrt(magA) * Math.sqrt(magB);
	if (magnitudeProduct === 0) return 0;
	const similarity = dot / magnitudeProduct;
	return 1 - Math.max(-1, Math.min(1, similarity));
}
/**
* Detects topic shifts by comparing consecutive observation embeddings
* against a static cosine distance threshold.
*/
var TopicShiftDetector = class {
	lastEmbedding = null;
	threshold;
	constructor(options) {
		this.threshold = options?.threshold ?? .3;
	}
	/**
	* Evaluate a new embedding for topic shift against the previous one.
	* Updates internal state with the new embedding after evaluation.
	*/
	detect(embedding) {
		const previous = this.lastEmbedding;
		this.lastEmbedding = embedding;
		if (previous === null) return {
			shifted: false,
			distance: 0,
			threshold: this.threshold,
			confidence: 0,
			previousEmbedding: null,
			currentEmbedding: embedding
		};
		const distance = cosineDistance(previous, embedding);
		const shifted = distance > this.threshold;
		const confidence = shifted ? Math.min((distance - this.threshold) / this.threshold, 1) : 0;
		return {
			shifted,
			distance,
			threshold: this.threshold,
			confidence,
			previousEmbedding: previous,
			currentEmbedding: embedding
		};
	}
	/** Clear last embedding state -- next detect is treated as first observation */
	reset() {
		this.lastEmbedding = null;
	}
	/** Get current threshold value */
	getThreshold() {
		return this.threshold;
	}
	/** Set threshold value, bounded to [0.05, 0.95] */
	setThreshold(value) {
		this.threshold = Math.max(.05, Math.min(.95, value));
	}
};

//#endregion
//#region src/intelligence/adaptive-threshold.ts
/** Default EWMA distance when no history exists */
const DEFAULT_EWMA_DISTANCE = .3;
/** Default EWMA variance when no history exists */
const DEFAULT_EWMA_VARIANCE = .01;
/** Default decay factor */
const DEFAULT_ALPHA = .3;
/** Default sensitivity (standard deviations above mean) */
const DEFAULT_SENSITIVITY_MULTIPLIER = 1.5;
/** Hard lower bound for threshold -- prevents over-sensitive detection */
const THRESHOLD_MIN = .15;
/** Hard upper bound for threshold -- prevents ignoring real shifts */
const THRESHOLD_MAX = .6;
/**
* Manages an EWMA-based adaptive threshold for topic shift detection.
*
* After each topic distance observation, call `update(distance)` to refine
* the threshold. The threshold adapts:
* - High distances (scattered topics) push the threshold up
* - Low distances (focused topics) push the threshold down
* - Threshold is bounded within [0.15, 0.6] to prevent extreme drift
*
* For cold start, call `seedFromHistory(avgDistance, avgVariance)` with
* averages loaded from the ThresholdStore.
*/
var AdaptiveThresholdManager = class {
	ewmaDistance;
	ewmaVariance;
	alpha;
	sensitivityMultiplier;
	observationCount;
	constructor(options) {
		this.alpha = options?.alpha ?? DEFAULT_ALPHA;
		this.sensitivityMultiplier = options?.sensitivityMultiplier ?? DEFAULT_SENSITIVITY_MULTIPLIER;
		this.ewmaDistance = DEFAULT_EWMA_DISTANCE;
		this.ewmaVariance = DEFAULT_EWMA_VARIANCE;
		this.observationCount = 0;
	}
	/**
	* Feed a new cosine distance observation and update the EWMA state.
	*
	* EWMA update formula:
	* 1. ewmaDistance = alpha * distance + (1 - alpha) * ewmaDistance
	* 2. diff = distance - ewmaDistance (after update)
	* 3. ewmaVariance = alpha * (diff * diff) + (1 - alpha) * ewmaVariance
	* 4. threshold = clamp(ewmaDistance + sensitivityMultiplier * sqrt(ewmaVariance), 0.15, 0.6)
	*
	* @param distance - Cosine distance from the latest topic detection
	* @returns The new adaptive threshold value
	*/
	update(distance) {
		this.ewmaDistance = this.alpha * distance + (1 - this.alpha) * this.ewmaDistance;
		const diff = distance - this.ewmaDistance;
		this.ewmaVariance = this.alpha * (diff * diff) + (1 - this.alpha) * this.ewmaVariance;
		this.observationCount++;
		return this.getThreshold();
	}
	/**
	* Seed the EWMA state from historical session averages (cold start).
	* Does not reset observation count -- only updates the statistical seed.
	*/
	seedFromHistory(averageDistance, averageVariance) {
		this.ewmaDistance = averageDistance;
		this.ewmaVariance = averageVariance;
	}
	/**
	* Compute the current threshold from EWMA state, clamped to bounds.
	*
	* Formula: ewmaDistance + sensitivityMultiplier * sqrt(ewmaVariance)
	* Bounded to [0.15, 0.6]
	*/
	getThreshold() {
		const raw = this.ewmaDistance + this.sensitivityMultiplier * Math.sqrt(this.ewmaVariance);
		return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, raw));
	}
	/**
	* Return a snapshot of the current EWMA state.
	*/
	getState() {
		return {
			ewmaDistance: this.ewmaDistance,
			ewmaVariance: this.ewmaVariance,
			alpha: this.alpha,
			sensitivityMultiplier: this.sensitivityMultiplier,
			observationCount: this.observationCount
		};
	}
	/**
	* Reset all EWMA state to defaults.
	*/
	reset() {
		this.ewmaDistance = DEFAULT_EWMA_DISTANCE;
		this.ewmaVariance = DEFAULT_EWMA_VARIANCE;
		this.observationCount = 0;
	}
};

//#endregion
//#region src/intelligence/decision-logger.ts
/**
* Persists topic shift decisions for debugging and threshold tuning.
*
* Every call to detect() in the topic shift pipeline should result in
* a corresponding log() call here, regardless of whether a shift was
* detected. This provides complete visibility into the decision process.
*
* All SQL statements are prepared once in the constructor and reused
* for every call (better-sqlite3 performance best practice).
*/
var TopicShiftDecisionLogger = class {
	db;
	stmtInsert;
	stmtGetSessionDecisions;
	stmtGetShiftRate;
	constructor(db) {
		this.db = db;
		this.stmtInsert = db.prepare(`
      INSERT INTO shift_decisions
        (id, project_id, session_id, observation_id, distance, threshold,
         ewma_distance, ewma_variance, sensitivity_multiplier, shifted,
         confidence, stash_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
		this.stmtGetSessionDecisions = db.prepare(`
      SELECT * FROM shift_decisions
      WHERE project_id = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
		this.stmtGetShiftRate = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(shifted) AS shifted_count
      FROM (
        SELECT shifted
        FROM shift_decisions
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `);
		debug("db", "TopicShiftDecisionLogger initialized");
	}
	/**
	* Log a topic shift decision with all inputs.
	*
	* Should be called after every detect() call, regardless of outcome.
	*/
	log(decision) {
		const id = randomBytes(16).toString("hex");
		this.stmtInsert.run(id, decision.projectId, decision.sessionId, decision.observationId, decision.distance, decision.threshold, decision.ewmaDistance, decision.ewmaVariance, decision.sensitivityMultiplier, decision.shifted ? 1 : 0, decision.confidence, decision.stashId);
		debug("db", "Shift decision logged", {
			shifted: decision.shifted,
			distance: decision.distance,
			threshold: decision.threshold
		});
	}
	/**
	* Retrieve decisions for a specific session, ordered by recency.
	*
	* Useful for debugging: "What happened in this session?"
	*/
	getSessionDecisions(projectId, sessionId, limit = 50) {
		return this.stmtGetSessionDecisions.all(projectId, sessionId, limit).map(rowToDecision);
	}
	/**
	* Compute shift rate statistics across recent decisions for a project.
	*
	* Returns the total number of decisions, how many were shifts, and
	* the rate (0-1). Useful for tuning: a rate of 0.3 means 30% of
	* observations triggered a topic shift.
	*/
	getShiftRate(projectId, lastN = 100) {
		const row = this.stmtGetShiftRate.get(projectId, lastN);
		const total = row.total;
		const shifted = row.shifted_count ?? 0;
		return {
			total,
			shifted,
			rate: total > 0 ? shifted / total : 0
		};
	}
};
function rowToDecision(row) {
	return {
		projectId: row.project_id,
		sessionId: row.session_id,
		observationId: row.observation_id,
		distance: row.distance,
		threshold: row.threshold,
		ewmaDistance: row.ewma_distance,
		ewmaVariance: row.ewma_variance,
		sensitivityMultiplier: row.sensitivity_multiplier,
		shifted: row.shifted === 1,
		confidence: row.confidence,
		stashId: row.stash_id
	};
}

//#endregion
//#region src/config/topic-detection-config.ts
/**
* Maps a sensitivity preset to its multiplier value.
*
* - sensitive (1.0): Detects smaller shifts -- lower bar for topic change
* - balanced (1.5): Default -- moderate sensitivity
* - relaxed (2.5): Only detects large shifts -- higher bar
*/
function sensitivityPresetToMultiplier(preset) {
	switch (preset) {
		case "sensitive": return 1;
		case "balanced": return 1.5;
		case "relaxed": return 2.5;
	}
}
/** Default configuration values */
const DEFAULTS = {
	sensitivityPreset: "balanced",
	sensitivityMultiplier: 1.5,
	manualThreshold: null,
	ewmaAlpha: .3,
	thresholdBounds: {
		min: .15,
		max: .6
	},
	enabled: true
};
/**
* Loads topic detection configuration from disk.
*
* Reads .laminark/topic-detection.json (relative to the Laminark data
* directory). Falls back to defaults if the file does not exist or
* cannot be parsed. Validates threshold bounds constraints.
*/
function loadTopicDetectionConfig() {
	const configPath = join(getConfigDir(), "topic-detection.json");
	let raw = {};
	try {
		const content = readFileSync(configPath, "utf-8");
		raw = JSON.parse(content);
		debug("config", "Loaded topic detection config", { path: configPath });
	} catch {
		debug("config", "No topic detection config found, using defaults");
		return { ...DEFAULTS };
	}
	const preset = [
		"sensitive",
		"balanced",
		"relaxed"
	].includes(raw.sensitivityPreset) ? raw.sensitivityPreset : DEFAULTS.sensitivityPreset;
	const multiplier = typeof raw.sensitivityMultiplier === "number" && raw.sensitivityMultiplier > 0 ? raw.sensitivityMultiplier : sensitivityPresetToMultiplier(preset);
	const manualThreshold = typeof raw.manualThreshold === "number" ? raw.manualThreshold : null;
	const ewmaAlpha = typeof raw.ewmaAlpha === "number" && raw.ewmaAlpha > 0 && raw.ewmaAlpha <= 1 ? raw.ewmaAlpha : DEFAULTS.ewmaAlpha;
	let boundsMin = typeof raw.thresholdBounds?.min === "number" ? raw.thresholdBounds.min : DEFAULTS.thresholdBounds.min;
	let boundsMax = typeof raw.thresholdBounds?.max === "number" ? raw.thresholdBounds.max : DEFAULTS.thresholdBounds.max;
	if (boundsMin < .05) boundsMin = .05;
	if (boundsMax > .95) boundsMax = .95;
	if (boundsMin >= boundsMax) {
		boundsMin = DEFAULTS.thresholdBounds.min;
		boundsMax = DEFAULTS.thresholdBounds.max;
	}
	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled;
	return {
		sensitivityPreset: preset,
		sensitivityMultiplier: multiplier,
		manualThreshold,
		ewmaAlpha,
		thresholdBounds: {
			min: boundsMin,
			max: boundsMax
		},
		enabled
	};
}
/**
* Applies a TopicDetectionConfig to a detector and adaptive manager.
*
* - If config.enabled is false, sets detector threshold to 999 (never triggers)
* - If config.manualThreshold is set, uses it directly (bypasses adaptive)
* - Otherwise, configures the adaptive manager with the sensitivity multiplier
*/
function applyConfig(config, detector, adaptiveManager) {
	if (!config.enabled) {
		detector.setThreshold(999);
		debug("config", "Topic detection disabled -- threshold set to 999");
		return;
	}
	if (config.manualThreshold !== null) {
		detector.setThreshold(config.manualThreshold);
		debug("config", "Manual threshold override applied", { threshold: config.manualThreshold });
		return;
	}
	const adaptiveThreshold = adaptiveManager.getThreshold();
	detector.setThreshold(adaptiveThreshold);
	debug("config", "Adaptive config applied", {
		preset: config.sensitivityPreset,
		multiplier: config.sensitivityMultiplier,
		threshold: adaptiveThreshold
	});
}

//#endregion
//#region src/storage/notifications.ts
var NotificationStore = class {
	stmtInsert;
	stmtConsume;
	stmtSelect;
	constructor(db) {
		db.exec(`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
		this.stmtInsert = db.prepare("INSERT INTO pending_notifications (id, project_id, message) VALUES (?, ?, ?)");
		this.stmtSelect = db.prepare("SELECT * FROM pending_notifications WHERE project_id = ? ORDER BY created_at ASC LIMIT 10");
		this.stmtConsume = db.prepare("DELETE FROM pending_notifications WHERE project_id = ?");
		debug("db", "NotificationStore initialized");
	}
	add(projectId, message) {
		const id = randomBytes(16).toString("hex");
		this.stmtInsert.run(id, projectId, message);
		debug("db", "Notification added", { projectId });
	}
	/** Fetch and delete all pending notifications for a project (consume pattern). */
	consumePending(projectId) {
		const rows = this.stmtSelect.all(projectId);
		if (rows.length > 0) this.stmtConsume.run(projectId);
		return rows.map((r) => ({
			id: r.id,
			projectId: r.project_id,
			message: r.message,
			createdAt: r.created_at
		}));
	}
};

//#endregion
//#region src/graph/extraction-rules.ts
/**
* Matches file paths like src/foo/bar.ts, ./config.json, /absolute/path.ext, package.json
*
* Regex: paths with at least one dot-extension, allowing /, ., -, _ in path segments.
* Confidence: 0.95 (file paths are very reliable)
*/
const filePathRule = (text) => {
	const matches = [];
	const regex = /(?<![a-zA-Z0-9@#])(?:\.\/|\/)?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+(?![a-zA-Z0-9/])/g;
	const standaloneRegex = /(?<![a-zA-Z0-9@#/])(?:[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|css|scss|html|sql|sh|py|rs|go|java|rb|php|c|cpp|h|hpp|vue|svelte|astro|prisma|graphql|gql|env|lock|config|xml|csv|txt|log|gitignore|dockerignore|editorconfig))(?![a-zA-Z0-9/])/g;
	let match;
	while ((match = regex.exec(text)) !== null) {
		let name = match[0];
		if (name.startsWith("./")) name = name.slice(2);
		name = name.replace(/\/\//g, "/");
		matches.push({
			name,
			type: "File",
			confidence: .95,
			span: [match.index, match.index + match[0].length]
		});
	}
	while ((match = standaloneRegex.exec(text)) !== null) {
		const name = match[0];
		if (!matches.some((m) => match.index >= m.span[0] && match.index < m.span[1])) matches.push({
			name,
			type: "File",
			confidence: .95,
			span: [match.index, match.index + match[0].length]
		});
	}
	return matches;
};
/**
* Matches phrases following decision indicators: "decided to", "chose", "went with",
* "selected", "opted for", "choosing between", "decision:", "the decision was".
*
* Extracts the clause following the indicator (up to period, comma, or end of sentence).
* Confidence: 0.7 (decision language can be ambiguous)
*/
const decisionRule = (text) => {
	const matches = [];
	for (const pattern of [
		/\bdecided\s+to\s+/gi,
		/\bchose\s+(?:to\s+)?/gi,
		/\bwent\s+with\s+/gi,
		/\bselected\s+/gi,
		/\bopted\s+for\s+/gi,
		/\bchoosing\s+between\s+/gi,
		/\bdecision:\s*/gi,
		/\bthe\s+decision\s+was\s+(?:to\s+)?/gi
	]) {
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const clauseStart = match.index + match[0].length;
			const remaining = text.slice(clauseStart);
			const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
			let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
			clause = clause.trim();
			if (clause.length > 100) clause = clause.slice(0, 100).trim();
			if (clause.length < 3) continue;
			matches.push({
				name: clause,
				type: "Decision",
				confidence: .7,
				span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)]
			});
		}
	}
	return matches;
};
const toolPattern = new RegExp(`\\b(${[
	"eslint",
	"prettier",
	"biome",
	"stylelint",
	"oxlint",
	"typescript",
	"javascript",
	"python",
	"rust",
	"golang",
	"node",
	"deno",
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"pip",
	"webpack",
	"vite",
	"rollup",
	"esbuild",
	"tsup",
	"tsdown",
	"turbopack",
	"parcel",
	"swc",
	"jest",
	"vitest",
	"mocha",
	"cypress",
	"playwright",
	"pytest",
	"react",
	"vue",
	"svelte",
	"angular",
	"solid",
	"astro",
	"next",
	"nuxt",
	"remix",
	"gatsby",
	"tailwind",
	"tailwindcss",
	"bootstrap",
	"chakra",
	"sqlite",
	"postgres",
	"postgresql",
	"mysql",
	"mongodb",
	"redis",
	"supabase",
	"dynamodb",
	"prisma",
	"drizzle",
	"typeorm",
	"sequelize",
	"knex",
	"kysely",
	"docker",
	"kubernetes",
	"terraform",
	"nginx",
	"caddy",
	"git",
	"github",
	"gitlab",
	"circleci",
	"jenkins",
	"jwt",
	"oauth",
	"bcrypt",
	"argon2",
	"jose",
	"graphql",
	"grpc",
	"trpc",
	"express",
	"fastify",
	"hono",
	"koa",
	"openai",
	"anthropic",
	"langchain",
	"huggingface",
	"onnx",
	"zod",
	"ajv",
	"winston",
	"pino",
	"socket.io",
	"rxjs",
	"storybook",
	"chromatic",
	"figma"
].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
const toolRule = (text) => {
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	let match;
	toolPattern.lastIndex = 0;
	while ((match = toolPattern.exec(text)) !== null) {
		const name = match[1].toLowerCase();
		if (seen.has(name)) continue;
		seen.add(name);
		matches.push({
			name,
			type: "Tool",
			confidence: .9,
			span: [match.index, match.index + match[0].length]
		});
	}
	return matches;
};
/**
* Matches @-mentions and "by/with [Capitalized Name]" patterns.
* Confidence: 0.6 (names are tricky, keep conservative)
*/
const personRule = (text) => {
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	const mentionRegex = /@([a-zA-Z][a-zA-Z0-9_-]{1,38})\b/g;
	let match;
	while ((match = mentionRegex.exec(text)) !== null) {
		const name = match[1];
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matches.push({
			name: `@${name}`,
			type: "Person",
			confidence: .6,
			span: [match.index, match.index + match[0].length]
		});
	}
	const byRegex = /\bby\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
	while ((match = byRegex.exec(text)) !== null) {
		const name = match[1];
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matches.push({
			name,
			type: "Person",
			confidence: .6,
			span: [match.index, match.index + match[0].length]
		});
	}
	const withVerbRegex = /\b(?:[Dd]ecided|[Ww]orked|[Pp]aired|[Cc]ollaborated|[Dd]iscussed|[Mm]et)\s+with\s+/g;
	while ((match = withVerbRegex.exec(text)) !== null) {
		const nameMatch = text.slice(match.index + match[0].length).match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
		if (!nameMatch) continue;
		const name = nameMatch[1];
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		const fullEnd = match.index + match[0].length + nameMatch[0].length;
		matches.push({
			name,
			type: "Person",
			confidence: .6,
			span: [match.index, fullEnd]
		});
	}
	return matches;
};
/**
* Matches phrases following problem indicators: "bug in", "issue with",
* "problem:", "error:", "failing", "broken", "doesn't work", "can't", etc.
* Confidence: 0.65
*/
const problemRule = (text) => {
	const matches = [];
	for (const pattern of [
		/\bbug\s+in\s+/gi,
		/\bissue\s+with\s+/gi,
		/\bproblem:\s*/gi,
		/\berror:\s*/gi,
		/\bfailing\s+(?:to\s+)?/gi,
		/\bbroken\s+/gi,
		/\bdoesn'?t\s+work\s*/gi,
		/\bcan'?t\s+/gi,
		/\bunable\s+to\s+/gi,
		/\bcrash(?:es|ing|ed)?\s+(?:in|on|when|during)\s+/gi
	]) {
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const clauseStart = match.index + match[0].length;
			const remaining = text.slice(clauseStart);
			const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
			let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
			clause = clause.trim();
			if (clause.length > 100) clause = clause.slice(0, 100).trim();
			if (clause.length < 3) continue;
			matches.push({
				name: clause,
				type: "Problem",
				confidence: .65,
				span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)]
			});
		}
	}
	return matches;
};
/**
* Matches phrases following solution indicators: "fixed by", "solved by",
* "the fix was", "solution:", "resolved by", "workaround:".
* Confidence: 0.65
*/
const solutionRule = (text) => {
	const matches = [];
	for (const pattern of [
		/\bfixed\s+by\s+/gi,
		/\bsolved\s+by\s+/gi,
		/\bthe\s+fix\s+was\s+/gi,
		/\bsolution:\s*/gi,
		/\bresolved\s+by\s+/gi,
		/\bworkaround:\s*/gi
	]) {
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const clauseStart = match.index + match[0].length;
			const remaining = text.slice(clauseStart);
			const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
			let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
			clause = clause.trim();
			if (clause.length > 100) clause = clause.slice(0, 100).trim();
			if (clause.length < 3) continue;
			matches.push({
				name: clause,
				type: "Solution",
				confidence: .65,
				span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)]
			});
		}
	}
	return matches;
};
/**
* Matches repository-style names (org/repo), project names in quotes after "project" keyword,
* and package.json name references.
* Confidence: 0.8
*/
const projectRule = (text) => {
	const matches = [];
	const seen = /* @__PURE__ */ new Set();
	const orgRepoRegex = /(?<![@a-zA-Z0-9])\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)(?!\.[a-zA-Z]{1,4}(?:\b|\/))(?!\/)/g;
	let match;
	while ((match = orgRepoRegex.exec(text)) !== null) {
		const candidate = match[1];
		if (/\.[a-zA-Z]{1,6}$/.test(candidate) && !/\.js$/.test(candidate)) continue;
		if (/^(src|dist|lib|test|tests|node_modules|build|public)\//.test(candidate)) continue;
		const lower = candidate.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matches.push({
			name: candidate,
			type: "Project",
			confidence: .8,
			span: [match.index, match.index + match[0].length]
		});
	}
	const projectNameRegex = /\bproject\s*[:]\s*["']([^"']+)["']/gi;
	while ((match = projectNameRegex.exec(text)) !== null) {
		const name = match[1].trim();
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matches.push({
			name,
			type: "Project",
			confidence: .8,
			span: [match.index, match.index + match[0].length]
		});
	}
	const scopedRegex = /@([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\b/g;
	while ((match = scopedRegex.exec(text)) !== null) {
		const name = `@${match[1]}`;
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matches.push({
			name,
			type: "Project",
			confidence: .8,
			span: [match.index, match.index + match[0].length]
		});
	}
	return matches;
};
/**
* All extraction rules in priority order (higher confidence first).
* Use this for iteration in the extraction pipeline.
*/
const ALL_RULES = [
	filePathRule,
	toolRule,
	projectRule,
	decisionRule,
	problemRule,
	solutionRule,
	personRule
];

//#endregion
//#region src/graph/entity-extractor.ts
const DEFAULT_MIN_CONFIDENCE = .5;
/**
* Extracts entities from observation text using all registered rules.
*
* - Runs every rule against the text
* - Deduplicates: same name from multiple rules keeps highest confidence
* - Resolves overlapping spans: higher confidence wins
* - Filters by minimum confidence threshold
* - Returns sorted by confidence descending
*/
function extractEntities(text, observationId, opts) {
	const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
	const allMatches = [];
	for (const rule of ALL_RULES) try {
		const results = rule(text);
		allMatches.push(...results);
	} catch {
		continue;
	}
	const filtered = deduplicateByName(resolveOverlaps(allMatches)).filter((m) => m.confidence >= minConfidence);
	filtered.sort((a, b) => b.confidence - a.confidence);
	return {
		entities: filtered.map((m) => ({
			name: m.name,
			type: m.type,
			confidence: m.confidence
		})),
		observationId,
		extractedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/**
* Extracts entities from text and persists them as graph nodes.
*
* For each extracted entity:
*   - Calls upsertNode (creates or merges with existing node)
*   - Appends observationId to the node's observation_ids array
*
* Wrapped in a transaction for atomicity. Individual entity failures
* are logged and skipped (never fail the whole batch).
*
* @returns Array of persisted GraphNode objects
*/
function extractAndPersist(db, text, observationId, opts) {
	const result = extractEntities(text, observationId, opts);
	const persisted = [];
	db.transaction(() => {
		for (const entity of result.entities) try {
			const node = upsertNode(db, {
				type: entity.type,
				name: entity.name,
				metadata: { confidence: entity.confidence },
				observation_ids: [observationId],
				project_hash: opts?.projectHash
			});
			persisted.push(node);
		} catch {
			continue;
		}
	})();
	return persisted;
}
/**
* Resolves overlapping spans between same-type entities.
*
* Only removes overlapping matches when they share the same entity type
* (e.g., two Tool entities on overlapping text). Different types are
* allowed to overlap since they represent different semantic information
* (e.g., a Decision span can contain a Tool name within it).
*
* When same-type spans overlap, the one with higher confidence wins.
*/
function resolveOverlaps(matches) {
	if (matches.length <= 1) return [...matches];
	const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
	const result = [];
	for (const match of sorted) if (result.findIndex((kept) => kept.type === match.type && match.span[0] < kept.span[1] && match.span[1] > kept.span[0]) === -1) result.push(match);
	return result;
}
/**
* Deduplicates matches by name+type. When the same entity name appears
* multiple times (possibly from different rules), keeps the one with
* the highest confidence score.
*/
function deduplicateByName(matches) {
	const byKey = /* @__PURE__ */ new Map();
	for (const match of matches) {
		const key = `${match.type}:${match.name.toLowerCase()}`;
		const existing = byKey.get(key);
		if (!existing || match.confidence > existing.confidence) byKey.set(key, match);
	}
	return [...byKey.values()];
}

//#endregion
//#region src/graph/constraints.ts
/**
* Enforces maximum edge count on a node by pruning lowest-weight edges.
*
* When a node exceeds maxDegree edges:
*   1. Get all edges for the node
*   2. Sort by weight ascending (lowest first)
*   3. Delete lowest-weight edges until count <= maxDegree
*   4. Log pruned count with [laminark:graph] prefix
*
* Runs in a transaction to prevent race conditions.
*
* @param db - Database handle
* @param nodeId - The node to enforce degree cap on
* @param maxDegree - Maximum allowed edges (default: MAX_NODE_DEGREE = 50)
* @returns Object with pruned count and remaining count
*/
function enforceMaxDegree(db, nodeId, maxDegree = MAX_NODE_DEGREE) {
	return db.transaction(() => {
		const currentCount = countEdgesForNode(db, nodeId);
		if (currentCount <= maxDegree) return {
			pruned: 0,
			remaining: currentCount
		};
		const edges = getEdgesForNode(db, nodeId);
		edges.sort((a, b) => a.weight - b.weight);
		const toPrune = currentCount - maxDegree;
		const edgesToDelete = edges.slice(0, toPrune);
		const deleteStmt = db.prepare("DELETE FROM graph_edges WHERE id = ?");
		for (const edge of edgesToDelete) deleteStmt.run(edge.id);
		const remaining = currentCount - toPrune;
		process.stderr.write(`[laminark:graph] Pruned ${toPrune} lowest-weight edges from node ${nodeId} (${remaining} remaining)\n`);
		return {
			pruned: toPrune,
			remaining
		};
	})();
}
/**
* Merges one entity node into another. The keepId node survives.
*
* Steps:
*   1. Union observation_ids from both nodes (no duplicates)
*   2. Reroute all edges from mergeId to keepId
*   3. Handle duplicate edge conflicts (keep higher weight)
*   4. Delete the mergeId node
*
* Runs in a transaction for atomicity.
*
* @param db - Database handle
* @param keepId - The node to keep (survives merge)
* @param mergeId - The node to merge and delete
*/
function mergeEntities(db, keepId, mergeId) {
	db.transaction(() => {
		const keepRow = db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(keepId);
		const mergeRow = db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(mergeId);
		if (!keepRow || !mergeRow) throw new Error(`Cannot merge: one or both nodes not found (keep=${keepId}, merge=${mergeId})`);
		const keepObsIds = JSON.parse(keepRow.observation_ids);
		const mergeObsIds = JSON.parse(mergeRow.observation_ids);
		const mergedObsIds = [...new Set([...keepObsIds, ...mergeObsIds])];
		const keepMeta = JSON.parse(keepRow.metadata);
		const mergedMeta = {
			...JSON.parse(mergeRow.metadata),
			...keepMeta
		};
		db.prepare(`UPDATE graph_nodes SET observation_ids = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(mergedObsIds), JSON.stringify(mergedMeta), keepId);
		const mergeEdges = getEdgesForNode(db, mergeId);
		for (const edge of mergeEdges) {
			let newSourceId = edge.source_id;
			let newTargetId = edge.target_id;
			if (edge.source_id === mergeId) newSourceId = keepId;
			if (edge.target_id === mergeId) newTargetId = keepId;
			if (newSourceId === newTargetId) {
				db.prepare("DELETE FROM graph_edges WHERE id = ?").run(edge.id);
				continue;
			}
			const existing = db.prepare("SELECT id, weight FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?").get(newSourceId, newTargetId, edge.type);
			if (existing && existing.id !== edge.id) {
				if (edge.weight > existing.weight) db.prepare("UPDATE graph_edges SET weight = ? WHERE id = ?").run(edge.weight, existing.id);
				db.prepare("DELETE FROM graph_edges WHERE id = ?").run(edge.id);
			} else if (!existing) db.prepare("UPDATE graph_edges SET source_id = ?, target_id = ? WHERE id = ?").run(newSourceId, newTargetId, edge.id);
		}
		db.prepare("DELETE FROM graph_nodes WHERE id = ?").run(mergeId);
		process.stderr.write(`[laminark:graph] Merged entity ${mergeId} into ${keepId} (${mergeEdges.length} edges rerouted)\n`);
	})();
}
/**
* Common abbreviation mappings for duplicate detection.
* Maps lowercase abbreviation -> lowercase full name.
*/
const ABBREVIATION_MAP = {
	ts: "typescript",
	js: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	pg: "postgresql",
	postgres: "postgresql",
	mongo: "mongodb",
	k8s: "kubernetes",
	tf: "terraform",
	gh: "github",
	gl: "gitlab",
	ci: "circleci",
	gql: "graphql",
	tw: "tailwind",
	tailwindcss: "tailwind",
	sw: "swc",
	np: "numpy",
	pd: "pandas",
	wp: "webpack",
	nx: "next"
};
/**
* Finds potential duplicate entities in the graph.
*
* Detection strategies:
*   a. Case-insensitive name match (e.g., "React" and "react")
*   b. Common abbreviation match (e.g., "TS" and "TypeScript")
*   c. Path normalization for Files (strip ./, normalize separators)
*
* Returns grouped duplicate candidates with reasons. This is a
* SUGGESTION function -- use mergeEntities() to act on results.
*
* @param db - Database handle
* @param opts - Optional filter by entity type
* @returns Array of duplicate groups with entities and reason
*/
function findDuplicateEntities(db, opts) {
	let nodes;
	if (opts?.type) nodes = getNodesByType(db, opts.type);
	else {
		const allTypes = ENTITY_TYPES;
		nodes = [];
		for (const type of allTypes) nodes.push(...getNodesByType(db, type));
	}
	const duplicates = [];
	const seen = /* @__PURE__ */ new Set();
	const byTypeAndLowerName = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		const key = `${node.type}:${node.name.toLowerCase()}`;
		const group = byTypeAndLowerName.get(key) ?? [];
		group.push(node);
		byTypeAndLowerName.set(key, group);
	}
	for (const [, group] of byTypeAndLowerName) if (group.length > 1) {
		const ids = group.map((n) => n.id).sort().join(",");
		if (!seen.has(ids)) {
			seen.add(ids);
			duplicates.push({
				entities: group,
				reason: `Case-insensitive name match: "${group[0].name}" and "${group[1].name}"`
			});
		}
	}
	const byTypeAndCanonical = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		const lower = node.name.toLowerCase();
		const canonical = ABBREVIATION_MAP[lower] ?? lower;
		const key = `${node.type}:${canonical}`;
		const group = byTypeAndCanonical.get(key) ?? [];
		group.push(node);
		byTypeAndCanonical.set(key, group);
	}
	for (const [, group] of byTypeAndCanonical) if (group.length > 1) {
		if (new Set(group.map((n) => n.name.toLowerCase())).size > 1) {
			const ids = group.map((n) => n.id).sort().join(",");
			if (!seen.has(ids)) {
				seen.add(ids);
				duplicates.push({
					entities: group,
					reason: `Common abbreviation match: "${group[0].name}" and "${group[1].name}"`
				});
			}
		}
	}
	if (!opts?.type || opts.type === "File") {
		const fileNodes = nodes.filter((n) => n.type === "File");
		const byNormalizedPath = /* @__PURE__ */ new Map();
		for (const node of fileNodes) {
			let normalized = node.name;
			if (normalized.startsWith("./")) normalized = normalized.slice(2);
			normalized = normalized.replace(/\\/g, "/");
			normalized = normalized.replace(/\/\//g, "/");
			normalized = normalized.toLowerCase();
			const key = `File:${normalized}`;
			const group = byNormalizedPath.get(key) ?? [];
			group.push(node);
			byNormalizedPath.set(key, group);
		}
		for (const [, group] of byNormalizedPath) if (group.length > 1) {
			const ids = group.map((n) => n.id).sort().join(",");
			if (!seen.has(ids)) {
				seen.add(ids);
				duplicates.push({
					entities: group,
					reason: `Path normalization match: "${group[0].name}" and "${group[1].name}"`
				});
			}
		}
	}
	return duplicates;
}

//#endregion
//#region src/graph/relationship-detector.ts
/**
* Ordered by specificity. First match wins.
*/
const CONTEXT_SIGNALS = [
	{
		pattern: /\b(?:decided|chose|selected)\b/i,
		type: "decided_by"
	},
	{
		pattern: /\b(?:solved\s+by|fixed\s+by|resolved\s+by)\b/i,
		type: "solved_by"
	},
	{
		pattern: /\b(?:caused\s+by|because\s+of|due\s+to)\b/i,
		type: "caused_by"
	},
	{
		pattern: /\b(?:depends?\s+on|requires?|imports?)\b/i,
		type: "depends_on"
	},
	{
		pattern: /\b(?:part\s+of|belongs?\s+to|inside)\b/i,
		type: "part_of"
	},
	{
		pattern: /\b(?:uses?|using)\b/i,
		type: "uses"
	}
];
/**
* Default relationship type based on entity type pair.
* Key format: "SourceType->TargetType"
*/
const TYPE_PAIR_DEFAULTS = {
	"File->Tool": "uses",
	"Tool->File": "uses",
	"File->File": "related_to",
	"Decision->Tool": "related_to",
	"Tool->Decision": "related_to",
	"Decision->Person": "decided_by",
	"Person->Decision": "decided_by",
	"Problem->File": "part_of",
	"File->Problem": "part_of",
	"Problem->Solution": "solved_by",
	"Solution->Problem": "solved_by",
	"Solution->Tool": "uses",
	"Tool->Solution": "uses",
	"Project->File": "part_of",
	"File->Project": "part_of"
};
/**
* Detects typed relationships between co-occurring entities in observation text.
*
* For each unique entity pair:
*   1. Determine base relationship type from type-pair rules
*   2. Check text context signals to refine relationship type
*   3. Apply proximity boost (+0.1 for entities within 50 chars)
*   4. Apply sentence co-occurrence boost (+0.15 for same sentence)
*   5. Filter out self-relationships
*
* @param text - The observation text containing the entities
* @param entities - Already-extracted entities with name and type
* @returns Array of relationship candidates with confidence scores
*/
function detectRelationships(text, entities) {
	if (entities.length < 2) return [];
	const candidates = [];
	for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) {
		const source = entities[i];
		const target = entities[j];
		if (source.name === target.name && source.type === target.type) continue;
		const sourcePos = text.toLowerCase().indexOf(source.name.toLowerCase());
		const targetPos = text.toLowerCase().indexOf(target.name.toLowerCase());
		if (sourcePos === -1 || targetPos === -1) continue;
		const minPos = Math.min(sourcePos, targetPos);
		const maxPos = Math.max(sourcePos + source.name.length, targetPos + target.name.length);
		const contextStart = Math.max(0, minPos - 50);
		const contextEnd = Math.min(text.length, maxPos + 50);
		const contextText = text.slice(contextStart, contextEnd);
		const pairKey = `${source.type}->${target.type}`;
		let relationshipType = TYPE_PAIR_DEFAULTS[pairKey] ?? "related_to";
		for (const signal of CONTEXT_SIGNALS) if (signal.pattern.test(contextText)) {
			relationshipType = signal.type;
			break;
		}
		if (source.type === "File" && target.type === "File") {
			if (/\b(?:imports?|requires?|from)\b/i.test(contextText)) relationshipType = "depends_on";
		}
		let confidence;
		if (relationshipType === "related_to" && !TYPE_PAIR_DEFAULTS[pairKey]) confidence = .3;
		else confidence = .5;
		if (Math.abs(sourcePos - targetPos) <= 50) confidence += .1;
		if (areInSameSentence(text, sourcePos, targetPos)) confidence += .15;
		confidence = Math.min(confidence, 1);
		candidates.push({
			sourceEntity: {
				name: source.name,
				type: source.type
			},
			targetEntity: {
				name: target.name,
				type: target.type
			},
			relationshipType,
			confidence,
			evidence: contextText.slice(0, 200)
		});
	}
	return candidates;
}
/**
* Detects relationships, resolves entity names to node IDs, and persists edges.
*
* - Calls detectRelationships to find candidates
* - Resolves each entity to a graph node via getNodeByNameAndType
* - Inserts edges for candidates with confidence > 0.3
* - Enforces max degree on affected nodes after insertion
*
* @returns Array of persisted GraphEdge objects
*/
function detectAndPersist(db, text, entities, opts) {
	const candidates = detectRelationships(text, entities);
	const persisted = [];
	const affectedNodeIds = /* @__PURE__ */ new Set();
	db.transaction(() => {
		for (const candidate of candidates) {
			if (candidate.confidence <= .3) continue;
			const sourceNode = getNodeByNameAndType(db, candidate.sourceEntity.name, candidate.sourceEntity.type);
			const targetNode = getNodeByNameAndType(db, candidate.targetEntity.name, candidate.targetEntity.type);
			if (!sourceNode || !targetNode) continue;
			try {
				const edge = insertEdge(db, {
					source_id: sourceNode.id,
					target_id: targetNode.id,
					type: candidate.relationshipType,
					weight: candidate.confidence,
					metadata: { evidence: candidate.evidence },
					project_hash: opts?.projectHash
				});
				persisted.push(edge);
				affectedNodeIds.add(sourceNode.id);
				affectedNodeIds.add(targetNode.id);
			} catch {
				continue;
			}
		}
		for (const nodeId of affectedNodeIds) enforceMaxDegree(db, nodeId);
	})();
	return persisted;
}
/**
* Checks if two positions in the text are within the same sentence.
* A sentence boundary is defined by '.', '!', '?', or newline followed by
* optional whitespace.
*/
function areInSameSentence(text, pos1, pos2) {
	const start = Math.min(pos1, pos2);
	const end = Math.max(pos1, pos2);
	const between = text.slice(start, end);
	return !/[.!?\n]/.test(between);
}

//#endregion
//#region src/graph/observation-merger.ts
/**
* Computes cosine similarity between two number arrays.
* Returns 0 for zero-length or zero-norm vectors.
*/
function cosineSimilarity(a, b) {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}
/**
* Computes Jaccard similarity between two texts based on tokenized words.
* Words are lowercased and split on whitespace/punctuation.
*/
function jaccardSimilarity(textA, textB) {
	const tokenize = (t) => new Set(t.toLowerCase().split(/[\s,.!?;:'"()\[\]{}<>\/\\|@#$%^&*+=~`]+/).filter((w) => w.length > 0));
	const setA = tokenize(textA);
	const setB = tokenize(textB);
	if (setA.size === 0 && setB.size === 0) return 1;
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const w of setA) if (setB.has(w)) intersection++;
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
/**
* Converts a Buffer of Float32 values to a number array.
*/
function bufferToNumbers(buf) {
	const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	return Array.from(floats);
}
/**
* Generates a consolidated summary from a cluster of observations.
*
* Strategy:
*   1. Take the longest observation as the base
*   2. Find unique keywords in shorter observations
*   3. Append unique info in parentheses
*   4. Prepend "[Consolidated from N observations]"
*/
function generateSummary(observations) {
	if (observations.length === 0) return "";
	if (observations.length === 1) return observations[0].text;
	const sorted = [...observations].sort((a, b) => b.text.length - a.text.length);
	const base = sorted[0];
	const baseWords = new Set(base.text.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
	const uniqueKeywords = [];
	for (let i = 1; i < sorted.length; i++) {
		const words = sorted[i].text.split(/\s+/).filter((w) => w.length > 2);
		for (const word of words) if (!baseWords.has(word.toLowerCase()) && !uniqueKeywords.includes(word.toLowerCase())) uniqueKeywords.push(word.toLowerCase());
	}
	let summary = base.text;
	if (uniqueKeywords.length > 0) {
		const extras = uniqueKeywords.slice(0, 10).join(", ");
		summary += ` (also: ${extras})`;
	}
	return `[Consolidated from ${observations.length} observations] ${summary}`;
}
/**
* Finds clusters of similar observations for the same entity.
*
* For each entity with 3+ observations:
*   1. Compute pairwise similarities (cosine on embeddings, Jaccard on text)
*   2. Cluster observations where ALL pairwise similarities exceed threshold
*   3. Generate suggested summaries for each cluster
*
* Only clusters with 2+ observations are returned, sorted by size DESC.
*
* @param db - better-sqlite3 Database handle
* @param opts - threshold (default 0.95 cosine / 0.85 Jaccard), entityId filter
* @returns Mergeable observation clusters sorted by size descending
*/
function findMergeableClusters(db, opts) {
	const embeddingThreshold = opts?.threshold ?? .95;
	const textThreshold = .85;
	let nodes;
	if (opts?.entityId) {
		const row = db.prepare("SELECT id, observation_ids FROM graph_nodes WHERE id = ?").get(opts.entityId);
		nodes = row ? [row] : [];
	} else nodes = db.prepare("SELECT id, observation_ids FROM graph_nodes").all();
	const clusters = [];
	for (const node of nodes) {
		const obsIds = JSON.parse(node.observation_ids);
		if (obsIds.length < 3) continue;
		const placeholders = obsIds.map(() => "?").join(", ");
		const rows = db.prepare(`SELECT id, content, embedding, created_at, source, deleted_at
         FROM observations
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...obsIds);
		if (rows.length < 2) continue;
		const observations = rows.map((r) => ({
			id: r.id,
			text: r.content,
			embedding: r.embedding ? bufferToNumbers(r.embedding) : null,
			created_at: r.created_at
		}));
		const used = /* @__PURE__ */ new Set();
		for (let i = 0; i < observations.length; i++) {
			if (used.has(observations[i].id)) continue;
			const cluster = [observations[i]];
			let totalSim = 0;
			let pairCount = 0;
			for (let j = i + 1; j < observations.length; j++) {
				if (used.has(observations[j].id)) continue;
				let allSimilar = true;
				let candidateSim = 0;
				let candidatePairs = 0;
				for (const member of cluster) {
					const sim = computeSimilarity(member, observations[j], embeddingThreshold, textThreshold);
					if (sim === null) {
						allSimilar = false;
						break;
					}
					candidateSim += sim;
					candidatePairs++;
				}
				if (allSimilar && candidatePairs > 0) {
					cluster.push(observations[j]);
					totalSim += candidateSim;
					pairCount += candidatePairs;
				}
			}
			if (cluster.length >= 2) {
				for (const obs of cluster) used.add(obs.id);
				const avgSim = pairCount > 0 ? totalSim / pairCount : 0;
				clusters.push({
					entityId: node.id,
					observations: cluster,
					similarity: avgSim,
					suggestedSummary: generateSummary(cluster)
				});
			}
		}
	}
	clusters.sort((a, b) => b.observations.length - a.observations.length);
	return clusters;
}
/**
* Computes similarity between two observations.
* Returns the similarity score if it exceeds the threshold, or null if not.
*/
function computeSimilarity(a, b, embeddingThreshold, textThreshold) {
	if (a.embedding && b.embedding) {
		const sim = cosineSimilarity(a.embedding, b.embedding);
		return sim >= embeddingThreshold ? sim : null;
	}
	const sim = jaccardSimilarity(a.text, b.text);
	return sim >= textThreshold ? sim : null;
}
/**
* Merges a cluster of similar observations into a consolidated observation.
*
* Steps:
*   1. Create new consolidated observation with suggestedSummary text
*   2. Store merge metadata (merged_from, merged_at, original_count)
*   3. Update entity's observation_ids: remove old, add new merged ID
*   4. Soft-delete originals (set deleted_at, do NOT hard delete)
*   5. Compute mean embedding if originals have embeddings
*
* Runs in a transaction for atomicity.
*
* @param db - better-sqlite3 Database handle
* @param cluster - The cluster to merge
* @returns The new merged observation ID and removed IDs
*/
function mergeObservationCluster(db, cluster) {
	return db.transaction(() => {
		const mergedId = randomBytes(16).toString("hex");
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const removedIds = cluster.observations.map((o) => o.id);
		const metadata = JSON.stringify({
			merged_from: removedIds,
			merged_at: now,
			original_count: cluster.observations.length
		});
		let meanEmbedding = null;
		const embeddingsWithValues = cluster.observations.filter((o) => o.embedding !== null);
		if (embeddingsWithValues.length > 0) {
			const dim = embeddingsWithValues[0].embedding.length;
			const mean = new Float32Array(dim);
			for (const obs of embeddingsWithValues) {
				const emb = obs.embedding;
				for (let i = 0; i < dim; i++) mean[i] += emb[i];
			}
			for (let i = 0; i < dim; i++) mean[i] /= embeddingsWithValues.length;
			meanEmbedding = Buffer.from(mean.buffer);
		}
		const projectHash = db.prepare("SELECT project_hash, source FROM observations WHERE id = ?").get(cluster.observations[0].id)?.project_hash ?? "unknown";
		db.prepare(`INSERT INTO observations (id, project_hash, content, title, source, session_id, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mergedId, projectHash, cluster.suggestedSummary, `[Merged] ${metadata}`, "curation:merge", null, meanEmbedding, now, now);
		const nodeRow = db.prepare("SELECT observation_ids FROM graph_nodes WHERE id = ?").get(cluster.entityId);
		if (nodeRow) {
			const currentIds = JSON.parse(nodeRow.observation_ids);
			const removedSet = new Set(removedIds);
			const updatedIds = currentIds.filter((id) => !removedSet.has(id));
			updatedIds.push(mergedId);
			db.prepare(`UPDATE graph_nodes SET observation_ids = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(updatedIds), cluster.entityId);
		}
		const softDeleteStmt = db.prepare(`UPDATE observations SET deleted_at = ? WHERE id = ?`);
		for (const obsId of removedIds) softDeleteStmt.run(now, obsId);
		return {
			mergedId,
			removedIds
		};
	})();
}
/**
* Prunes low-value observations using conservative AND-logic.
*
* An observation is pruned ONLY if ALL of:
*   a. Very short (< minTextLength characters, default 20)
*   b. No linked entities (not in any graph_node's observation_ids)
*   c. Older than maxAge days (default 90)
*   d. Auto-captured (source is NOT 'mcp:save_memory' or 'slash:remember')
*   e. Not already deleted
*
* Pruning is soft-delete only -- sets deleted_at, never hard deletes.
*
* @param db - better-sqlite3 Database handle
* @param opts - Configurable thresholds
* @returns Count of pruned observations
*/
function pruneLowValue(db, opts) {
	const minTextLength = opts?.minTextLength ?? 20;
	const maxAgeDays = opts?.maxAge ?? 90;
	const now = /* @__PURE__ */ new Date();
	const cutoffISO = (/* @__PURE__ */ new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1e3)).toISOString();
	const candidates = db.prepare(`SELECT id, content, source, created_at
       FROM observations
       WHERE deleted_at IS NULL
         AND LENGTH(content) < ?
         AND created_at < ?
         AND source NOT IN ('mcp:save_memory', 'slash:remember')`).all(minTextLength, cutoffISO);
	if (candidates.length === 0) return { pruned: 0 };
	const allNodeObsIds = /* @__PURE__ */ new Set();
	const nodes = db.prepare("SELECT observation_ids FROM graph_nodes").all();
	for (const node of nodes) {
		const ids = JSON.parse(node.observation_ids);
		for (const id of ids) allNodeObsIds.add(id);
	}
	const toPrune = candidates.filter((c) => !allNodeObsIds.has(c.id));
	if (toPrune.length === 0) return { pruned: 0 };
	const nowISO = now.toISOString();
	const softDeleteStmt = db.prepare("UPDATE observations SET deleted_at = ? WHERE id = ?");
	return { pruned: db.transaction(() => {
		for (const obs of toPrune) softDeleteStmt.run(nowISO, obs.id);
		return toPrune.length;
	})() };
}

//#endregion
//#region src/graph/curation-agent.ts
/**
* Runs a single curation cycle on the knowledge graph.
*
* Executes five steps in order:
*   1. Merge similar observations
*   2. Deduplicate entities
*   3. Enforce graph constraints (approaching degree cap)
*   4. Staleness sweep
*   5. Low-value pruning
*
* Each step is wrapped in try/catch -- if one fails, the rest continue.
* Returns a CurationReport documenting all actions taken.
*
* This function is idempotent: running it twice in a row produces the
* same result (merged observations do not re-merge, already-flagged
* stale observations do not get re-flagged, etc.)
*
* @param db - better-sqlite3 Database handle
* @returns CurationReport with counts and any errors
*/
async function runCuration(db) {
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	const errors = [];
	let observationsMerged = 0;
	let entitiesDeduplicated = 0;
	let stalenessFlagsAdded = 0;
	let lowValuePruned = 0;
	try {
		initStalenessSchema(db);
	} catch (err) {
		errors.push(`Schema init: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const clusters = findMergeableClusters(db);
		for (const cluster of clusters) try {
			const result = mergeObservationCluster(db, cluster);
			observationsMerged += result.removedIds.length;
		} catch (err) {
			errors.push(`Merge cluster (entity ${cluster.entityId}): ${err instanceof Error ? err.message : String(err)}`);
		}
	} catch (err) {
		errors.push(`Step 1 (merge): ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const duplicates = findDuplicateEntities(db);
		for (const group of duplicates) {
			if (group.entities.length < 2) continue;
			const sorted = [...group.entities].sort((a, b) => b.observation_ids.length - a.observation_ids.length);
			const keepId = sorted[0].id;
			for (let i = 1; i < sorted.length; i++) try {
				mergeEntities(db, keepId, sorted[i].id);
				entitiesDeduplicated++;
			} catch (err) {
				errors.push(`Dedup (${sorted[0].name} <- ${sorted[i].name}): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	} catch (err) {
		errors.push(`Step 2 (dedup): ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const threshold = Math.floor(MAX_NODE_DEGREE * .9);
		const nodeRows = db.prepare("SELECT id FROM graph_nodes").all();
		for (const row of nodeRows) try {
			if (countEdgesForNode(db, row.id) > threshold) enforceMaxDegree(db, row.id);
		} catch (err) {
			errors.push(`Constraint (node ${row.id}): ${err instanceof Error ? err.message : String(err)}`);
		}
	} catch (err) {
		errors.push(`Step 3 (constraints): ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const recentNodes = db.prepare(`SELECT id FROM graph_nodes WHERE updated_at >= datetime('now', '-24 hours')`).all();
		const existingFlags = /* @__PURE__ */ new Set();
		try {
			const flagRows = db.prepare("SELECT observation_id FROM staleness_flags WHERE resolved = 0").all();
			for (const row of flagRows) existingFlags.add(row.observation_id);
		} catch {}
		for (const node of recentNodes) try {
			const reports = detectStaleness(db, node.id);
			for (const report of reports) if (!existingFlags.has(report.olderObservation.id)) {
				flagStaleObservation(db, report.olderObservation.id, report.reason);
				existingFlags.add(report.olderObservation.id);
				stalenessFlagsAdded++;
			}
		} catch (err) {
			errors.push(`Staleness (node ${node.id}): ${err instanceof Error ? err.message : String(err)}`);
		}
	} catch (err) {
		errors.push(`Step 4 (staleness): ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		lowValuePruned = pruneLowValue(db).pruned;
	} catch (err) {
		errors.push(`Step 5 (prune): ${err instanceof Error ? err.message : String(err)}`);
	}
	const report = {
		startedAt,
		completedAt: (/* @__PURE__ */ new Date()).toISOString(),
		observationsMerged,
		entitiesDeduplicated,
		stalenessFlagsAdded,
		lowValuePruned,
		errors
	};
	process.stderr.write(`[laminark:curation] Cycle complete: ${observationsMerged} merged, ${entitiesDeduplicated} deduped, ${stalenessFlagsAdded} flagged stale, ${lowValuePruned} pruned\n`);
	return report;
}
/**
* Background curation agent that runs periodically or on-demand.
*
* Manages scheduling, lifecycle, and reporting. Uses the standalone
* runCuration() function for the actual curation logic.
*/
var CurationAgent = class {
	db;
	intervalMs;
	onComplete;
	running = false;
	lastRun = null;
	timer = null;
	constructor(db, opts) {
		this.db = db;
		this.intervalMs = opts?.intervalMs ?? 3e5;
		this.onComplete = opts?.onComplete;
	}
	/**
	* Start periodic curation on setInterval.
	*/
	start() {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => {
			this.runOnce();
		}, this.intervalMs);
		process.stderr.write(`[laminark:curation] Agent started, interval: ${this.intervalMs}ms\n`);
	}
	/**
	* Stop the periodic curation timer.
	*/
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.running = false;
		process.stderr.write("[laminark:curation] Agent stopped\n");
	}
	/**
	* Execute one curation cycle. This is the main entry point.
	*/
	async runOnce() {
		const report = await runCuration(this.db);
		this.lastRun = report.completedAt;
		if (this.onComplete) this.onComplete(report);
		return report;
	}
	/**
	* Whether the agent is currently running.
	*/
	isRunning() {
		return this.running;
	}
	/**
	* Timestamp of the last completed curation run.
	*/
	getLastRun() {
		return this.lastRun;
	}
};

//#endregion
//#region src/web/routes/sse.ts
/**
* Server-Sent Events endpoint for live updates.
*
* Maintains a set of connected SSE clients and provides a broadcast
* function for pushing real-time events to all connected browsers.
* Includes a ring buffer for event replay on reconnection via
* Last-Event-ID header support.
*
* Supported event types:
*   - connected: initial handshake
*   - heartbeat: keepalive ping (every 30s)
*   - new_observation: new observation stored
*   - topic_shift: topic shift detected
*   - entity_updated: graph entity created/modified
*   - session_start: new session started
*   - session_end: session ended
*
* @module web/routes/sse
*/
const clients = /* @__PURE__ */ new Set();
let clientIdCounter = 0;
let lastEventId = 0;
const RING_BUFFER_SIZE = 100;
const eventRingBuffer = [];
/**
* Adds an event to the ring buffer, evicting the oldest if full.
*/
function pushToRingBuffer(entry) {
	if (eventRingBuffer.length >= RING_BUFFER_SIZE) eventRingBuffer.shift();
	eventRingBuffer.push(entry);
}
/**
* Returns all events with id > sinceId from the ring buffer.
*/
function getEventsSince(sinceId) {
	return eventRingBuffer.filter((e) => e.id > sinceId);
}
function formatSSE(event, data, id) {
	let msg = "";
	if (id !== void 0) msg += `id: ${id}\n`;
	msg += `event: ${event}\ndata: ${data}\n\n`;
	return msg;
}
function sendToClient(client, event, data, id) {
	try {
		const message = formatSSE(event, data, id);
		client.controller.enqueue(new TextEncoder().encode(message));
		return true;
	} catch {
		return false;
	}
}
const sseRoutes = new Hono();
/**
* GET /api/sse
*
* Server-Sent Events endpoint. Keeps the connection alive with heartbeats
* and receives broadcast events for live UI updates.
*
* Supports Last-Event-ID header for replay of missed events on reconnection.
*/
sseRoutes.get("/sse", (c) => {
	const clientId = String(++clientIdCounter);
	const lastEventIdHeader = c.req.header("Last-Event-ID");
	const replayFromId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;
	let client;
	const stream = new ReadableStream({
		start(controller) {
			const heartbeatTimer = setInterval(() => {
				if (!sendToClient(client, "heartbeat", JSON.stringify({ timestamp: Date.now() }))) {
					clearInterval(heartbeatTimer);
					clients.delete(client);
					debug("db", "SSE client heartbeat failed, removed", { clientId });
				}
			}, 3e4);
			client = {
				id: clientId,
				controller,
				heartbeatTimer
			};
			clients.add(client);
			debug("db", "SSE client connected", {
				clientId,
				total: clients.size
			});
			sendToClient(client, "connected", JSON.stringify({
				timestamp: Date.now(),
				clientId
			}));
			if (replayFromId > 0) {
				const missed = getEventsSince(replayFromId);
				for (const entry of missed) sendToClient(client, entry.event, entry.data, entry.id);
				if (missed.length > 0) debug("db", "SSE replayed missed events", {
					clientId,
					count: missed.length,
					sinceId: replayFromId
				});
			}
		},
		cancel() {
			if (client) {
				clearInterval(client.heartbeatTimer);
				clients.delete(client);
				debug("db", "SSE client disconnected", {
					clientId,
					total: clients.size
				});
			}
		}
	});
	return new Response(stream, { headers: {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no"
	} });
});
/**
* Broadcasts an event to all connected SSE clients.
*
* Each broadcast increments a monotonic event ID that is included in the
* SSE `id:` field. Events are stored in an in-memory ring buffer (last 100)
* so reconnecting clients can replay missed events via Last-Event-ID.
*
* Automatically removes disconnected clients that fail to receive
* the message.
*
* @param event - Event name (e.g., 'new_observation', 'topic_shift')
* @param data - Data object to serialize as JSON
*/
function broadcast(event, data) {
	const eventId = ++lastEventId;
	const json = JSON.stringify(data);
	pushToRingBuffer({
		id: eventId,
		event,
		data: json
	});
	if (clients.size === 0) return;
	const dead = [];
	for (const client of clients) if (!sendToClient(client, event, json, eventId)) dead.push(client);
	for (const client of dead) {
		clearInterval(client.heartbeatTimer);
		clients.delete(client);
	}
	if (dead.length > 0) debug("db", "SSE broadcast cleaned dead clients", {
		dead: dead.length,
		remaining: clients.size
	});
}

//#endregion
//#region src/web/routes/api.ts
/**
* REST API routes for the Laminark visualization.
*
* Provides endpoints for graph data, timeline data, and individual node
* details. All endpoints read from the better-sqlite3 database instance
* set on the Hono context by the server middleware.
*
* @module web/routes/api
*/
function getDb(c) {
	return c.get("db");
}
function getProjectHash$1(c) {
	return c.req.query("project") || c.get("defaultProject") || null;
}
const apiRoutes = new Hono();
/**
* GET /api/projects
*
* Returns list of known projects from project_metadata table.
*/
apiRoutes.get("/projects", (c) => {
	const db = getDb(c);
	const defaultProject = c.get("defaultProject") || null;
	let projects = [];
	try {
		projects = db.prepare("SELECT project_hash, project_path, display_name, last_seen_at FROM project_metadata ORDER BY last_seen_at DESC").all();
	} catch {}
	return c.json({
		projects: projects.map((p) => ({
			hash: p.project_hash,
			path: p.project_path,
			displayName: p.display_name || p.project_path.split("/").pop() || p.project_hash.substring(0, 8),
			lastSeenAt: p.last_seen_at
		})),
		defaultProject
	});
});
/**
* GET /api/graph
*
* Returns the knowledge graph as JSON with nodes and edges arrays.
* Accepts optional query params:
*   ?type=File,Decision  - comma-separated entity types to include
*   ?since=ISO8601       - only entities created after this timestamp
*/
apiRoutes.get("/graph", (c) => {
	const db = getDb(c);
	const typeFilter = c.req.query("type");
	const sinceFilter = c.req.query("since");
	const untilFilter = c.req.query("until");
	const projectFilter = getProjectHash$1(c);
	let nodesSql = "SELECT id, name, type, observation_ids, created_at FROM graph_nodes";
	const nodeParams = [];
	const nodeConditions = [];
	if (projectFilter) {
		nodeConditions.push("project_hash = ?");
		nodeParams.push(projectFilter);
	}
	if (typeFilter) {
		const types = typeFilter.split(",").map((t) => t.trim()).filter(Boolean);
		if (types.length > 0) {
			nodeConditions.push(`type IN (${types.map(() => "?").join(", ")})`);
			nodeParams.push(...types);
		}
	}
	if (sinceFilter) {
		nodeConditions.push("created_at >= ?");
		nodeParams.push(sinceFilter);
	}
	if (untilFilter) {
		nodeConditions.push("created_at <= ?");
		nodeParams.push(untilFilter);
	}
	if (nodeConditions.length > 0) nodesSql += " WHERE " + nodeConditions.join(" AND ");
	nodesSql += " ORDER BY created_at DESC";
	let nodeRows;
	try {
		nodeRows = db.prepare(nodesSql).all(...nodeParams);
	} catch {
		nodeRows = [];
	}
	const nodes = nodeRows.map((row) => ({
		id: row.id,
		label: row.name,
		type: row.type,
		observationCount: safeParseJsonArray(row.observation_ids).length,
		createdAt: row.created_at
	}));
	let edgeRows;
	try {
		let edgesSql = `
      SELECT e.id, e.source_id, e.target_id, e.type, e.weight,
             tn.name AS name
      FROM graph_edges e
      LEFT JOIN graph_nodes tn ON tn.id = e.target_id`;
		const edgeParams = [];
		if (projectFilter) {
			edgesSql += " WHERE e.project_hash = ?";
			edgeParams.push(projectFilter);
		}
		edgesSql += " ORDER BY e.created_at DESC";
		edgeRows = db.prepare(edgesSql).all(...edgeParams);
	} catch {
		edgeRows = [];
	}
	const nodeIdSet = new Set(nodes.map((n) => n.id));
	const edges = (typeFilter ? edgeRows.filter((e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id)) : edgeRows).map((row) => ({
		id: row.id,
		source: row.source_id,
		target: row.target_id,
		type: row.type,
		label: row.name ?? row.type
	}));
	return c.json({
		nodes,
		edges
	});
});
/**
* GET /api/timeline
*
* Returns timeline data: sessions, observations, and topic shifts.
* Accepts optional query params:
*   ?from=ISO8601  - start of time range
*   ?to=ISO8601    - end of time range
*   ?limit=N       - max observations (default 500)
*/
apiRoutes.get("/timeline", (c) => {
	const db = getDb(c);
	const from = c.req.query("from");
	const to = c.req.query("to");
	const limitStr = c.req.query("limit");
	const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 500, 2e3) : 500;
	const offsetStr = c.req.query("offset");
	const offset = offsetStr ? Math.max(parseInt(offsetStr, 10) || 0, 0) : 0;
	const projectFilter = getProjectHash$1(c);
	let sessions = [];
	try {
		let sessionsSql = "SELECT id, started_at, ended_at, summary FROM sessions";
		const sessionParams = [];
		const sessionConds = [];
		if (projectFilter) {
			sessionConds.push("project_hash = ?");
			sessionParams.push(projectFilter);
		}
		if (from) {
			sessionConds.push("started_at >= ?");
			sessionParams.push(from);
		}
		if (to) {
			sessionConds.push("(ended_at IS NULL OR ended_at <= ?)");
			sessionParams.push(to);
		}
		if (sessionConds.length > 0) sessionsSql += " WHERE " + sessionConds.join(" AND ");
		sessionsSql += " ORDER BY started_at DESC LIMIT 50 OFFSET ?";
		sessionParams.push(offset);
		const sessionRows = db.prepare(sessionsSql).all(...sessionParams);
		const countStmt = db.prepare("SELECT COUNT(*) AS cnt FROM observations WHERE session_id = ? AND deleted_at IS NULL");
		sessions = sessionRows.map((row) => {
			let obsCount = 0;
			try {
				obsCount = countStmt.get(row.id)?.cnt ?? 0;
			} catch {}
			return {
				id: row.id,
				startedAt: row.started_at,
				endedAt: row.ended_at,
				observationCount: obsCount,
				summary: row.summary
			};
		});
	} catch {}
	let observations = [];
	try {
		let obsSql = "SELECT id, content, title, source, created_at, session_id FROM observations WHERE deleted_at IS NULL";
		const obsParams = [];
		if (projectFilter) {
			obsSql += " AND project_hash = ?";
			obsParams.push(projectFilter);
		}
		if (from) {
			obsSql += " AND created_at >= ?";
			obsParams.push(from);
		}
		if (to) {
			obsSql += " AND created_at <= ?";
			obsParams.push(to);
		}
		obsSql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
		obsParams.push(limit);
		obsParams.push(offset);
		observations = db.prepare(obsSql).all(...obsParams).map((row) => ({
			id: row.id,
			text: row.title ? `${row.title}: ${row.content}` : row.content,
			createdAt: row.created_at,
			sessionId: row.session_id,
			type: row.source
		}));
	} catch {}
	let topicShifts = [];
	try {
		let shiftSql = "SELECT id, session_id, distance, threshold, confidence, created_at FROM shift_decisions WHERE shifted = 1";
		const shiftParams = [];
		if (projectFilter) {
			shiftSql += " AND project_id = ?";
			shiftParams.push(projectFilter);
		}
		if (from) {
			shiftSql += " AND created_at >= ?";
			shiftParams.push(from);
		}
		if (to) {
			shiftSql += " AND created_at <= ?";
			shiftParams.push(to);
		}
		shiftSql += " ORDER BY created_at DESC LIMIT 100";
		topicShifts = db.prepare(shiftSql).all(...shiftParams).map((row) => ({
			id: row.id,
			fromTopic: null,
			toTopic: null,
			timestamp: row.created_at,
			confidence: row.confidence
		}));
	} catch {}
	return c.json({
		sessions,
		observations,
		topicShifts
	});
});
/**
* GET /api/node/:id
*
* Returns details for a single entity node including its observations
* and relationships. Powers the detail panel.
*/
apiRoutes.get("/node/:id", (c) => {
	const db = getDb(c);
	const nodeId = c.req.param("id");
	let nodeRow;
	try {
		nodeRow = db.prepare("SELECT id, name, type, observation_ids, metadata, created_at, updated_at FROM graph_nodes WHERE id = ?").get(nodeId);
	} catch {}
	if (!nodeRow) return c.json({ error: "Node not found" }, 404);
	const entity = {
		id: nodeRow.id,
		label: nodeRow.name,
		type: nodeRow.type,
		createdAt: nodeRow.created_at,
		updatedAt: nodeRow.updated_at,
		metadata: safeParseJson(nodeRow.metadata)
	};
	const observationIds = safeParseJsonArray(nodeRow.observation_ids);
	let nodeObservations = [];
	if (observationIds.length > 0) try {
		const placeholders = observationIds.map(() => "?").join(", ");
		nodeObservations = db.prepare(`SELECT id, content, title, created_at FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at DESC`).all(...observationIds).map((row) => ({
			id: row.id,
			text: row.title ? `${row.title}: ${row.content}` : row.content,
			createdAt: row.created_at
		}));
	} catch {}
	let relationships = [];
	try {
		relationships = db.prepare(`
      SELECT
        e.id, e.source_id, e.target_id, e.type, e.weight,
        tn.name AS target_name, tn.type AS target_type,
        sn.name AS source_name, sn.type AS source_type
      FROM graph_edges e
      LEFT JOIN graph_nodes tn ON tn.id = e.target_id
      LEFT JOIN graph_nodes sn ON sn.id = e.source_id
      WHERE e.source_id = ? OR e.target_id = ?
      ORDER BY e.weight DESC
    `).all(nodeId, nodeId).map((row) => {
			const isSource = row.source_id === nodeId;
			return {
				id: row.id,
				targetId: isSource ? row.target_id : row.source_id,
				targetLabel: isSource ? row.target_name ?? row.target_id : row.source_name ?? row.source_id,
				type: row.type,
				direction: isSource ? "outgoing" : "incoming"
			};
		});
	} catch {}
	return c.json({
		entity,
		observations: nodeObservations,
		relationships
	});
});
function safeParseJsonArray(json) {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
function safeParseJson(json) {
	try {
		return JSON.parse(json);
	} catch {
		return {};
	}
}

//#endregion
//#region src/web/server.ts
/**
* Hono web server for the Laminark visualization UI.
*
* Serves static assets from the ui/ directory and registers REST API
* and SSE route groups. Configured with CORS for localhost development
* and a health check endpoint.
*
* @module web/server
*/
/**
* Creates a configured Hono app with middleware, static serving,
* and route registration.
*
* @param db - better-sqlite3 Database instance for API queries
* @param uiRoot - Absolute path to the ui/ directory for static file serving
* @returns Configured Hono app
*/
function createWebServer(db, uiRoot, defaultProjectHash) {
	const app = new Hono();
	app.use("*", cors({ origin: (origin) => {
		if (!origin) return "*";
		if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return origin;
		return null;
	} }));
	app.use("*", async (c, next) => {
		c.set("db", db);
		if (defaultProjectHash) c.set("defaultProject", defaultProjectHash);
		await next();
	});
	app.get("/api/health", (c) => {
		return c.json({
			status: "ok",
			timestamp: Date.now()
		});
	});
	app.route("/api", apiRoutes);
	app.route("/api", sseRoutes);
	app.use("/*", async (c, next) => {
		const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
		const filePath = path.join(uiRoot, reqPath);
		try {
			const data = fs.readFileSync(filePath);
			const ext = path.extname(filePath).toLowerCase();
			const mimeTypes = {
				".html": "text/html",
				".js": "application/javascript",
				".css": "text/css",
				".json": "application/json",
				".png": "image/png",
				".svg": "image/svg+xml",
				".ico": "image/x-icon"
			};
			return c.body(data, 200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
		} catch {
			await next();
		}
	});
	app.get("*", async (c) => {
		const indexPath = path.join(uiRoot, "index.html");
		try {
			const data = fs.readFileSync(indexPath, "utf-8");
			return c.html(data);
		} catch {
			return c.text("UI not found", 404);
		}
	});
	return app;
}
/**
* Maximum number of alternate ports to try when the primary port is in use.
*/
const MAX_PORT_RETRIES = 10;
/**
* Starts the Hono web server on the specified port.
*
* If the port is already in use (EADDRINUSE), tries incrementing ports up to
* MAX_PORT_RETRIES times. If all ports fail, logs a warning and continues
* without the web server -- the MCP server is the primary function and must
* not be killed by a web server port conflict.
*
* @param app - Configured Hono app from createWebServer()
* @param port - Port number (default: 37820)
* @returns The Node.js HTTP server instance, or null if all ports failed
*/
function startWebServer(app, port = 37820) {
	debug("db", `Starting web server on port ${port}`);
	function tryListen(attemptPort, retries) {
		const server = serve({
			fetch: app.fetch,
			port: attemptPort
		});
		server.on("error", (err) => {
			if (err.code === "EADDRINUSE" && retries > 0) {
				server.close();
				const nextPort = attemptPort + 1;
				debug("db", `Port ${attemptPort} in use, trying ${nextPort}`);
				tryListen(nextPort, retries - 1);
			} else if (err.code === "EADDRINUSE") {
				server.close();
				debug("db", `Web server disabled: all ports ${port}-${attemptPort} in use`);
			} else debug("db", `Web server error: ${err.message}`);
		});
		server.on("listening", () => {
			const addr = server.address();
			debug("db", `Web server listening on http://localhost:${typeof addr === "object" && addr ? addr.port : attemptPort}`);
		});
		return server;
	}
	return tryListen(port, MAX_PORT_RETRIES);
}

//#endregion
//#region src/index.ts
const db = openDatabase(getDatabaseConfig());
initGraphSchema(db.db);
const projectHash = getProjectHash(process.cwd());
try {
	db.db.prepare(`
    INSERT INTO project_metadata (project_hash, project_path, last_seen_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(project_hash) DO UPDATE SET
      project_path = excluded.project_path,
      last_seen_at = excluded.last_seen_at
  `).run(projectHash, process.cwd());
} catch {}
const embeddingStore = db.hasVectorSupport ? new EmbeddingStore(db.db, projectHash) : null;
const worker = new AnalysisWorker();
worker.start().catch(() => {
	debug("mcp", "Worker failed to start, keyword-only mode");
});
const topicConfig = loadTopicDetectionConfig();
const detector = new TopicShiftDetector();
const adaptiveManager = new AdaptiveThresholdManager({
	sensitivityMultiplier: topicConfig.sensitivityMultiplier,
	alpha: topicConfig.ewmaAlpha
});
applyConfig(topicConfig, detector, adaptiveManager);
const historicalSeed = new ThresholdStore(db.db).loadHistoricalSeed(projectHash);
if (historicalSeed) {
	adaptiveManager.seedFromHistory(historicalSeed.averageDistance, historicalSeed.averageVariance);
	applyConfig(topicConfig, detector, adaptiveManager);
}
const stashManager = new StashManager(db.db);
const decisionLogger = new TopicShiftDecisionLogger(db.db);
const notificationStore = new NotificationStore(db.db);
const topicShiftHandler = new TopicShiftHandler({
	detector,
	stashManager,
	observationStore: new ObservationRepository(db.db, projectHash),
	config: topicConfig,
	decisionLogger,
	adaptiveManager
});
async function processUnembedded() {
	if (!embeddingStore || !worker.isReady()) return;
	const ids = embeddingStore.findUnembedded(10);
	if (ids.length === 0) return;
	const obsRepo = new ObservationRepository(db.db, projectHash);
	for (const id of ids) {
		const obs = obsRepo.getById(id);
		if (!obs) continue;
		const text = obs.title ? `${obs.title}\n${obs.content}` : obs.content;
		const embedding = await worker.embed(text);
		if (embedding) {
			embeddingStore.store(id, embedding);
			obsRepo.update(id, {
				embeddingModel: worker.getEngineName(),
				embeddingVersion: "1"
			});
			broadcast("new_observation", {
				id,
				text: obs.content.length > 120 ? obs.content.substring(0, 120) + "..." : obs.content,
				sessionId: obs.sessionId ?? null,
				createdAt: obs.createdAt
			});
			if (topicConfig.enabled) try {
				const obsWithEmbedding = {
					...obs,
					embedding
				};
				const result = await topicShiftHandler.handleObservation(obsWithEmbedding, obs.sessionId ?? "unknown", projectHash);
				if (result.stashed && result.notification) {
					notificationStore.add(projectHash, result.notification);
					debug("embed", "Topic shift detected, notification queued", { id });
					broadcast("topic_shift", {
						id: result.notification.substring(0, 32),
						fromTopic: null,
						toTopic: null,
						timestamp: (/* @__PURE__ */ new Date()).toISOString(),
						confidence: null
					});
				}
			} catch (topicErr) {
				debug("embed", "Topic shift detection error (non-fatal)", { error: topicErr instanceof Error ? topicErr.message : String(topicErr) });
			}
			try {
				const nodes = extractAndPersist(db.db, text, String(id), { projectHash });
				if (nodes.length > 0) {
					const entityPairs = nodes.map((n) => ({
						name: n.name,
						type: n.type
					}));
					detectAndPersist(db.db, text, entityPairs, { projectHash });
					debug("embed", "Graph updated", {
						id,
						entities: nodes.length
					});
					for (const node of nodes) broadcast("entity_updated", {
						id: node.name,
						label: node.name,
						type: node.type,
						observationCount: 1,
						createdAt: (/* @__PURE__ */ new Date()).toISOString()
					});
				}
			} catch (graphErr) {
				debug("embed", "Graph extraction error (non-fatal)", { error: graphErr instanceof Error ? graphErr.message : String(graphErr) });
			}
		}
	}
}
const embedTimer = setInterval(() => {
	processUnembedded().catch((err) => {
		debug("embed", "Background embedding error", { error: err instanceof Error ? err.message : String(err) });
	});
}, 5e3);
const server = createServer();
registerSaveMemory(server, db.db, projectHash, notificationStore);
registerRecall(server, db.db, projectHash, worker, embeddingStore, notificationStore);
registerTopicContext(server, db.db, projectHash, notificationStore);
registerQueryGraph(server, db.db, projectHash, notificationStore);
registerGraphStats(server, db.db, projectHash, notificationStore);
registerStatus(server, db.db, projectHash, process.cwd(), db.hasVectorSupport, () => worker.isReady(), notificationStore);
startServer(server).catch((err) => {
	debug("mcp", "Fatal: failed to start server", { error: err.message });
	clearInterval(embedTimer);
	db.close();
	process.exit(1);
});
const webPort = parseInt(process.env.LAMINARK_WEB_PORT || "37820", 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, "..", "ui");
startWebServer(createWebServer(db.db, uiRoot, projectHash), webPort);
const curationAgent = new CurationAgent(db.db, {
	intervalMs: 300 * 1e3,
	onComplete: (report) => {
		debug("db", "Curation complete", {
			merged: report.observationsMerged,
			deduped: report.entitiesDeduplicated,
			stale: report.stalenessFlagsAdded,
			pruned: report.lowValuePruned
		});
	}
});
curationAgent.start();
process.on("SIGINT", () => {
	clearInterval(embedTimer);
	curationAgent.stop();
	worker.shutdown().catch(() => {});
	db.close();
	process.exit(0);
});
process.on("SIGTERM", () => {
	clearInterval(embedTimer);
	curationAgent.stop();
	worker.shutdown().catch(() => {});
	db.close();
	process.exit(0);
});
process.on("uncaughtException", (err) => {
	debug("mcp", "Uncaught exception", { error: err.message });
	clearInterval(embedTimer);
	curationAgent.stop();
	worker.shutdown().catch(() => {});
	db.close();
	process.exit(1);
});

//#endregion
export { EmbeddingStore, MIGRATIONS, ObservationRepository, SearchEngine, SessionRepository, StashManager, ThresholdStore, debug, debugTimed, getDatabaseConfig, getDbPath, getProjectHash, isDebugEnabled, openDatabase, runMigrations };
//# sourceMappingURL=index.js.map