#!/usr/bin/env node
import { a as isDebugEnabled, i as getProjectHash, n as getDatabaseConfig, r as getDbPath, t as getConfigDir } from "./config-t8LZeB-u.mjs";
import { C as ObservationRepository, D as runMigrations, E as MIGRATIONS, O as debug, S as SessionRepository, T as openDatabase, _ as upsertNode, a as ResearchBufferRepository, b as hybridSearch, c as inferScope, d as getEdgesForNode, f as getNodeByNameAndType, g as traverseFrom, h as insertEdge, i as NotificationStore, k as debugTimed, l as inferToolType, m as initGraphSchema, n as PathRepository, o as BranchRepository, p as getNodesByType, r as initPathSchema, s as extractServerName, t as ToolRegistryRepository, u as countEdgesForNode, v as SaveGuard, w as rowToObservation, x as SearchEngine, y as jaccardSimilarity$1 } from "./tool-registry-FHfSTose.mjs";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import { Worker } from "node:worker_threads";
import { fileURLToPath as fileURLToPath$1 } from "node:url";
import { Hono } from "hono";
import fs from "fs";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

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
//#region src/config/cross-access.ts
/**
* Cross-Project Access Configuration
*
* Per-project config that controls which other projects' memories
* the current project can read from. Read-only access — no writes
* cross projects.
*
* Config stored at: {configDir}/cross-access-{projectHash}.json
*/
const DEFAULTS$4 = { readableProjects: [] };
function getConfigPath(projectHash) {
	return join(getConfigDir(), `cross-access-${projectHash}.json`);
}
function loadCrossAccessConfig(projectHash) {
	const configPath = getConfigPath(projectHash);
	try {
		if (!existsSync(configPath)) return { ...DEFAULTS$4 };
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return { readableProjects: Array.isArray(parsed.readableProjects) ? parsed.readableProjects.filter((h) => typeof h === "string") : [] };
	} catch {
		return { ...DEFAULTS$4 };
	}
}
function saveCrossAccessConfig(projectHash, config) {
	const configPath = getConfigPath(projectHash);
	const validated = { readableProjects: Array.isArray(config.readableProjects) ? config.readableProjects.filter((h) => typeof h === "string" && h !== projectHash) : [] };
	writeFileSync(configPath, JSON.stringify(validated, null, 2), "utf-8");
}
function resetCrossAccessConfig(projectHash) {
	const configPath = getConfigPath(projectHash);
	try {
		if (existsSync(configPath)) unlinkSync(configPath);
	} catch {}
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
//#region src/config/tool-verbosity-config.ts
/**
* Tool Response Verbosity Configuration
*
* Controls how much detail MCP tool responses include.
* Three levels:
*   1 (minimal): Just confirms the tool ran
*   2 (standard): Shows title/key info (default)
*   3 (verbose):  Full formatted text with all details
*
* Configuration is loaded from .laminark/tool-verbosity.json with
* a 5-second cache to avoid repeated disk reads.
*/
const DEFAULTS$3 = { level: 2 };
const CACHE_TTL_MS = 5e3;
let cachedConfig = null;
let cachedAt = 0;
/**
* Loads tool verbosity configuration from disk with a 5-second cache.
*/
function loadToolVerbosityConfig() {
	const now = Date.now();
	if (cachedConfig && now - cachedAt < CACHE_TTL_MS) return cachedConfig;
	const configPath = join(getConfigDir(), "tool-verbosity.json");
	try {
		const content = readFileSync(configPath, "utf-8");
		const level = JSON.parse(content).level;
		if (level === 1 || level === 2 || level === 3) cachedConfig = { level };
		else cachedConfig = { ...DEFAULTS$3 };
		debug("config", "Loaded tool verbosity config", { level: cachedConfig.level });
	} catch {
		cachedConfig = { ...DEFAULTS$3 };
	}
	cachedAt = now;
	return cachedConfig;
}
/**
* Saves tool verbosity configuration to disk and invalidates cache.
*/
function saveToolVerbosityConfig(config) {
	writeFileSync(join(getConfigDir(), "tool-verbosity.json"), JSON.stringify(config, null, 2), "utf-8");
	cachedConfig = config;
	cachedAt = Date.now();
}
/**
* Resets tool verbosity to defaults by invalidating cache.
*/
function resetToolVerbosityConfig() {
	cachedConfig = null;
	cachedAt = 0;
	return { ...DEFAULTS$3 };
}
/**
* Selects the appropriate response text based on the current verbosity level.
*
* Each tool passes three pre-built strings:
* - minimal:  Level 1 — just confirms the tool ran
* - standard: Level 2 — shows title/key info
* - verbose:  Level 3 — full formatted text
*/
function formatResponse(level, minimal, standard, verbose) {
	switch (level) {
		case 1: return minimal;
		case 2: return standard;
		case 3: return verbose;
	}
}
/**
* Convenience: loads config and selects the response in one call.
*/
function verboseResponse(minimal, standard, verbose) {
	const { level } = loadToolVerbosityConfig();
	return formatResponse(level, minimal, standard, verbose);
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
function prependNotifications$8(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$9(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function errorResponse$4(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
function getProjectNameMap(db) {
	const map = /* @__PURE__ */ new Map();
	try {
		const rows = db.prepare("SELECT project_hash, display_name FROM project_metadata").all();
		for (const row of rows) map.set(row.project_hash, row.display_name ?? row.project_hash.slice(0, 8));
	} catch {}
	return map;
}
function registerRecall(server, db, projectHashRef, worker = null, embeddingStore = null, notificationStore = null, statusCache = null) {
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
			kind: z.enum([
				"change",
				"reference",
				"finding",
				"decision",
				"verification"
			]).optional().describe("Filter results by observation kind: change, reference, finding, decision, verification"),
			limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return"),
			include_purged: z.boolean().default(false).describe("Include soft-deleted items in results (needed for restore)")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$9(prependNotifications$8(notificationStore, projectHash, text));
		try {
			const repo = new ObservationRepository(db, projectHash);
			const searchEngine = new SearchEngine(db, projectHash);
			const hasSearch = args.query !== void 0 || args.id !== void 0 || args.title !== void 0;
			if (args.ids && hasSearch) return errorResponse$4("Provide either a search query or IDs to act on, not both.");
			if ((args.action === "purge" || args.action === "restore") && !args.ids && !args.id) return errorResponse$4(`Provide ids array or id to specify which memories to ${args.action}.`);
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
				const crossConfig = loadCrossAccessConfig(projectHash);
				if (crossConfig.readableProjects.length > 0) {
					const nameMap = getProjectNameMap(db);
					for (const otherHash of crossConfig.readableProjects) {
						const otherEngine = new SearchEngine(db, otherHash);
						let otherResults;
						if (embeddingStore) otherResults = await hybridSearch({
							searchEngine: otherEngine,
							embeddingStore,
							worker,
							query: args.query,
							db,
							projectHash: otherHash,
							options: { limit: args.limit }
						});
						else otherResults = otherEngine.searchKeyword(args.query, { limit: args.limit });
						if (otherResults.length > 0) {
							const projName = nameMap.get(otherHash) ?? otherHash.slice(0, 8);
							for (const r of otherResults) r.observation.title = `[${projName}] ${r.observation.title ?? "untitled"}`;
							searchResults.push(...otherResults);
							observations.push(...otherResults.map((r) => r.observation));
						}
					}
				}
			} else if (args.title) observations = repo.getByTitle(args.title, {
				limit: args.limit,
				includePurged: args.include_purged
			});
			else observations = args.include_purged ? repo.listIncludingDeleted({ limit: args.limit }) : repo.list({
				limit: args.limit,
				kind: args.kind
			});
			if (args.kind && observations.length > 0) observations = observations.filter((obs) => obs.kind === args.kind);
			if (observations.length === 0) return withNotifications(`No memories found matching '${args.query ?? args.title ?? args.id ?? ""}'. Try broader search terms or check the ID.`);
			if (args.action === "view") {
				const verbosity = loadToolVerbosityConfig().level;
				if (verbosity === 1) {
					const searchTerm = args.query ?? args.title ?? "query";
					return textResponse$9(prependNotifications$8(notificationStore, projectHash, `Found ${observations.length} memories matching "${searchTerm}"`));
				}
				if (verbosity === 2) {
					const lines = observations.map((obs, i) => {
						const title = obs.title ?? "untitled";
						return `${i + 1}. ${title}`;
					});
					const footer = `\n---\n${observations.length} result(s)`;
					return textResponse$9(prependNotifications$8(notificationStore, projectHash, lines.join("\n") + footer));
				}
				const originalText = formatViewResponse(observations, searchResults, args.detail, args.id !== void 0).content[0].text;
				return textResponse$9(prependNotifications$8(notificationStore, projectHash, originalText));
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
				if (success > 0) statusCache?.markDirty();
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
				if (success > 0) statusCache?.markDirty();
				let msg = `Restored ${success}/${targetIds.length} memories.`;
				if (failures.length > 0) msg += ` Not found: ${failures.join(", ")}`;
				return withNotifications(msg);
			}
			return errorResponse$4(`Unknown action: ${args.action}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "recall: error", { error: message });
			return errorResponse$4(`Recall error: ${message}`);
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
	return textResponse$9(`${body}\n${footer}`);
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
function registerSaveMemory(server, db, projectHashRef, notificationStore = null, worker = null, embeddingStore = null, statusCache = null) {
	server.registerTool("save_memory", {
		title: "Save Memory",
		description: "Save a new memory observation. Provide text content and an optional title. If title is omitted, one is auto-generated from the text.",
		inputSchema: {
			text: z.string().min(1).max(1e4).describe("The text content to save as a memory"),
			title: z.string().max(200).optional().describe("Optional title for the memory. Auto-generated from text if omitted."),
			source: z.string().default("manual").describe("Source identifier (e.g., manual, hook:PostToolUse)"),
			kind: z.enum([
				"change",
				"reference",
				"finding",
				"decision",
				"verification"
			]).default("finding").describe("Observation kind: change, reference, finding, decision, or verification")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		try {
			const repo = new ObservationRepository(db, projectHash);
			const decision = await new SaveGuard(repo, {
				worker,
				embeddingStore
			}).evaluate(args.text, args.source);
			if (!decision.save) {
				debug("mcp", "save_memory: rejected by save guard", {
					reason: decision.reason,
					duplicateOf: decision.duplicateOf
				});
				return { content: [{
					type: "text",
					text: `Memory not saved: ${decision.reason}` + (decision.duplicateOf ? ` (similar to existing observation ${decision.duplicateOf})` : "")
				}] };
			}
			const resolvedTitle = args.title ?? generateTitle(args.text);
			const obs = repo.create({
				content: args.text,
				title: resolvedTitle,
				source: args.source,
				kind: args.kind
			});
			debug("mcp", "save_memory: saved", {
				id: obs.id,
				title: resolvedTitle
			});
			statusCache?.markDirty();
			let responseText = verboseResponse("Memory saved.", `Saved "${resolvedTitle}"`, `Saved memory "${resolvedTitle}" (id: ${obs.id})`);
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
function prependNotifications$7(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$8(text) {
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
function registerTopicContext(server, db, projectHashRef, notificationStore = null) {
	const stashManager = new StashManager(db);
	server.registerTool("topic_context", {
		title: "Topic Context",
		description: "Shows recently stashed context threads. Use when the user asks 'where was I?' or wants to see abandoned conversation threads.",
		inputSchema: {
			query: z.string().optional().describe("Optional search query to filter threads by topic label or summary"),
			limit: z.number().int().min(1).max(20).default(5).describe("Max threads to return")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$8(prependNotifications$7(notificationStore, projectHash, text));
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
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return withNotifications(`${stashes.length} stashed thread(s)`);
			if (verbosity === 2) return withNotifications(stashes.map((s, i) => `${i + 1}. ${s.topicLabel} (${timeAgo(s.createdAt)})`).join("\n"));
			const formatted = formatStashes(stashes);
			const footer = `\n---\n${stashes.length} stashed thread(s) | Use /laminark:resume {id} to restore`;
			debug("mcp", "topic_context: returning", { count: stashes.length });
			return withNotifications(formatted + footer);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "topic_context: error", { error: message });
			return textResponse$8(`Error retrieving context threads: ${message}`);
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
	"Reference"
];
const RELATIONSHIP_TYPES = [
	"related_to",
	"solved_by",
	"caused_by",
	"modifies",
	"informed_by",
	"references",
	"verified_by",
	"preceded_by"
];
/**
* Runtime type guard for EntityType.
* Uses the ENTITY_TYPES const array for O(n) lookup (n=6, negligible).
*/
function isEntityType(s) {
	return ENTITY_TYPES.includes(s);
}
/**
* Runtime type guard for RelationshipType.
* Uses the RELATIONSHIP_TYPES const array for O(n) lookup (n=8, negligible).
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
function prependNotifications$6(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$7(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function errorResponse$3(text) {
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
function registerQueryGraph(server, db, projectHashRef, notificationStore = null) {
	initGraphSchema(db);
	server.registerTool("query_graph", {
		title: "Query Knowledge Graph",
		description: "Query the knowledge graph to find entities and their relationships. Use to answer questions like 'what files does this decision affect?' or 'what references informed this change?'",
		inputSchema: {
			query: z.string().min(1).describe("Entity name or search text to look for"),
			entity_type: z.string().optional().describe(`Filter to entity type: ${ENTITY_TYPES.join(", ")}`),
			depth: z.number().int().min(1).max(4).default(2).describe("Traversal depth (default: 2, max: 4)"),
			relationship_types: z.array(z.string()).optional().describe(`Filter to relationship types: ${RELATIONSHIP_TYPES.join(", ")}`),
			limit: z.number().int().min(1).max(50).default(20).describe("Max root entities to return (default: 20, max: 50)")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$7(prependNotifications$6(notificationStore, projectHash, text));
		try {
			debug("mcp", "query_graph: request", {
				query: args.query,
				entity_type: args.entity_type,
				depth: args.depth
			});
			if (args.entity_type !== void 0 && !isEntityType(args.entity_type)) return errorResponse$3(`Invalid entity_type "${args.entity_type}". Valid types: ${ENTITY_TYPES.join(", ")}`);
			const entityType = args.entity_type;
			if (args.relationship_types) {
				for (const rt of args.relationship_types) if (!isRelationshipType(rt)) return errorResponse$3(`Invalid relationship_type "${rt}". Valid types: ${RELATIONSHIP_TYPES.join(", ")}`);
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
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) {
				const totalTraversals = [...traversalsByNode.values()].reduce((sum, arr) => sum + arr.length, 0);
				return withNotifications(`${rootNodes.length} entities, ${totalTraversals} connections found`);
			}
			if (verbosity === 2) {
				const lines = [];
				lines.push("## Entities Found");
				lines.push("");
				for (const node of rootNodes) {
					const traversals = traversalsByNode.get(node.id) ?? [];
					lines.push(`- ${formatEntityType(node.type)} ${node.name} (${traversals.length} connections)`);
				}
				return withNotifications(lines.join("\n"));
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
			return errorResponse$3(`Graph query error: ${message}`);
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
function prependNotifications$5(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$6(text) {
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
function registerGraphStats(server, db, projectHashRef, notificationStore = null) {
	initGraphSchema(db);
	server.registerTool("graph_stats", {
		title: "Graph Statistics",
		description: "Get knowledge graph statistics: entity counts, relationship distribution, health metrics. Use to understand the state of accumulated knowledge.",
		inputSchema: {}
	}, async () => {
		const projectHash = projectHashRef.current;
		try {
			debug("mcp", "graph_stats: request");
			const stats = collectGraphStats(db);
			const formatted = formatStats(stats);
			debug("mcp", "graph_stats: returning", {
				nodes: stats.total_nodes,
				edges: stats.total_edges
			});
			return textResponse$6(prependNotifications$5(notificationStore, projectHash, formatted));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "graph_stats: error", { error: message });
			return textResponse$6(`Graph stats error: ${message}`);
		}
	});
}

//#endregion
//#region src/graph/hygiene-analyzer.ts
const WEIGHTS = {
	orphaned: .3,
	islandNode: .15,
	noiseClassified: .25,
	shortContent: .1,
	autoCaptured: .1,
	stale: .1
};
const SHORT_CONTENT_THRESHOLD = 50;
/**
* Analyzes all active observations and scores each on deletion signals.
* Pure read-only — no data is modified.
*/
function analyzeObservations(db, projectHash, opts) {
	const limit = opts?.limit ?? 50;
	const minTier = opts?.minTier ?? "medium";
	debug("hygiene", "Starting analysis", {
		projectHash,
		sessionId: opts?.sessionId
	});
	let obsSql = `
    SELECT id, content, title, source, kind, session_id, classification, created_at
    FROM observations
    WHERE project_hash = ? AND deleted_at IS NULL
  `;
	const obsParams = [projectHash];
	if (opts?.sessionId) {
		obsSql += " AND session_id = ?";
		obsParams.push(opts.sessionId);
	}
	obsSql += " ORDER BY created_at DESC";
	const observations = db.prepare(obsSql).all(...obsParams);
	const linkedObsIds = /* @__PURE__ */ new Set();
	const islandObsIds = /* @__PURE__ */ new Set();
	const allNodes = db.prepare("SELECT id, type, name, observation_ids FROM graph_nodes").all();
	const edgeCounts = /* @__PURE__ */ new Map();
	const edgeRows = db.prepare(`SELECT source_id AS nid, COUNT(*) AS cnt FROM graph_edges GROUP BY source_id
     UNION ALL
     SELECT target_id AS nid, COUNT(*) AS cnt FROM graph_edges GROUP BY target_id`).all();
	for (const row of edgeRows) edgeCounts.set(row.nid, (edgeCounts.get(row.nid) ?? 0) + row.cnt);
	for (const node of allNodes) {
		let obsIds;
		try {
			obsIds = JSON.parse(node.observation_ids);
		} catch {
			continue;
		}
		const degree = edgeCounts.get(node.id) ?? 0;
		for (const oid of obsIds) {
			linkedObsIds.add(oid);
			if (degree === 0) islandObsIds.add(oid);
		}
	}
	const staleIds = /* @__PURE__ */ new Set();
	try {
		initStalenessSchema(db);
		const staleRows = db.prepare("SELECT observation_id FROM staleness_flags WHERE resolved = 0").all();
		for (const row of staleRows) staleIds.add(row.observation_id);
	} catch {}
	const allCandidates = [];
	for (const obs of observations) {
		const signals = {
			orphaned: !linkedObsIds.has(obs.id),
			islandNode: islandObsIds.has(obs.id),
			noiseClassified: obs.classification === "noise",
			shortContent: obs.content.length < SHORT_CONTENT_THRESHOLD,
			autoCaptured: obs.source.startsWith("hook:"),
			stale: staleIds.has(obs.id)
		};
		const confidence = (signals.orphaned ? WEIGHTS.orphaned : 0) + (signals.islandNode ? WEIGHTS.islandNode : 0) + (signals.noiseClassified ? WEIGHTS.noiseClassified : 0) + (signals.shortContent ? WEIGHTS.shortContent : 0) + (signals.autoCaptured ? WEIGHTS.autoCaptured : 0) + (signals.stale ? WEIGHTS.stale : 0);
		const tier = confidence >= .7 ? "high" : confidence >= .5 ? "medium" : "low";
		if (minTier === "high" && tier !== "high") continue;
		if (minTier === "medium" && tier === "low") continue;
		const preview = obs.content.length > 80 ? obs.content.substring(0, 80) + "..." : obs.content;
		allCandidates.push({
			id: obs.id,
			shortId: obs.id.substring(0, 8),
			sessionId: obs.session_id,
			kind: obs.kind,
			source: obs.source,
			contentPreview: preview,
			createdAt: obs.created_at,
			signals,
			confidence: Math.round(confidence * 100) / 100,
			tier
		});
	}
	allCandidates.sort((a, b) => b.confidence - a.confidence);
	const activeObsIds = new Set(observations.map((o) => o.id));
	const orphanNodes = [];
	for (const node of allNodes) {
		if ((edgeCounts.get(node.id) ?? 0) > 0) continue;
		let obsIds;
		try {
			obsIds = JSON.parse(node.observation_ids);
		} catch {
			continue;
		}
		if (obsIds.length === 0 || obsIds.every((oid) => !activeObsIds.has(oid))) orphanNodes.push({
			id: node.id,
			type: node.type,
			name: node.name,
			reason: "zero edges, dead observation refs"
		});
	}
	const limited = allCandidates.slice(0, limit);
	const highCount = allCandidates.filter((c) => c.tier === "high").length;
	const mediumCount = allCandidates.filter((c) => c.tier === "medium").length;
	const lowCount = allCandidates.filter((c) => c.tier === "low").length;
	debug("hygiene", "Analysis complete", {
		total: observations.length,
		high: highCount,
		medium: mediumCount,
		orphanNodes: orphanNodes.length
	});
	return {
		analyzedAt: (/* @__PURE__ */ new Date()).toISOString(),
		totalObservations: observations.length,
		candidates: limited,
		orphanNodes: orphanNodes.slice(0, limit),
		summary: {
			high: highCount,
			medium: mediumCount,
			low: lowCount,
			orphanNodeCount: orphanNodes.length
		}
	};
}
/**
* Soft-deletes observations matching the given tier threshold and removes
* dead orphan graph nodes. Returns counts of affected records.
*/
function executePurge(db, projectHash, report, tier) {
	const candidateIds = report.candidates.filter((c) => {
		if (tier === "high") return c.tier === "high";
		if (tier === "medium") return c.tier === "high" || c.tier === "medium";
		return true;
	}).map((c) => c.id);
	debug("hygiene", "Executing purge", {
		tier,
		candidates: candidateIds.length
	});
	let observationsPurged = 0;
	const softDeleteStmt = db.prepare(`
    UPDATE observations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
  `);
	return db.transaction(() => {
		for (const id of candidateIds) {
			const result = softDeleteStmt.run(id, projectHash);
			observationsPurged += result.changes;
		}
		let orphanNodesRemoved = 0;
		const deleteNodeStmt = db.prepare("DELETE FROM graph_nodes WHERE id = ?");
		for (const node of report.orphanNodes) {
			const result = deleteNodeStmt.run(node.id);
			orphanNodesRemoved += result.changes;
		}
		return {
			observationsPurged,
			orphanNodesRemoved
		};
	})();
}

//#endregion
//#region src/mcp/tools/hygiene.ts
function formatReport(report, mode, tier) {
	const lines = [];
	lines.push("## Database Hygiene Report");
	lines.push(`Analyzed ${report.totalObservations.toLocaleString()} observations`);
	lines.push("");
	lines.push("### Summary");
	lines.push("| Tier | Count | Action |");
	lines.push("|------|-------|--------|");
	lines.push(`| High (>= 0.7) | ${report.summary.high} | Safe to purge |`);
	lines.push(`| Medium (0.5-0.69) | ${report.summary.medium} | Review recommended |`);
	if (report.summary.low > 0) lines.push(`| Low (< 0.5) | ${report.summary.low} | Kept |`);
	lines.push(`| Orphan graph nodes | ${report.summary.orphanNodeCount} | Dead references |`);
	lines.push("");
	if (report.candidates.length === 0) {
		lines.push("No candidates found matching the selected tier.");
		return lines.join("\n");
	}
	const bySession = /* @__PURE__ */ new Map();
	for (const c of report.candidates) {
		const key = c.sessionId ?? "(no session)";
		const list = bySession.get(key) ?? [];
		list.push(c);
		bySession.set(key, list);
	}
	const tierLabel = tier === "all" ? "All" : tier === "medium" ? "Medium+" : "High";
	lines.push(`### ${tierLabel} Confidence Candidates (showing ${report.candidates.length})`);
	lines.push("");
	for (const [sessionId, candidates] of bySession) {
		const sessionDate = candidates[0]?.createdAt?.substring(0, 10) ?? "";
		lines.push(`#### Session: ${sessionId.substring(0, 8)} (${sessionDate}, ${candidates.length} obs)`);
		lines.push("| ID | Kind | Source | Confidence | Signals | Preview |");
		lines.push("|----|------|--------|------------|---------|---------|");
		for (const c of candidates) {
			const signals = [];
			if (c.signals.orphaned) signals.push("orphaned");
			if (c.signals.islandNode) signals.push("island");
			if (c.signals.noiseClassified) signals.push("noise");
			if (c.signals.shortContent) signals.push("short");
			if (c.signals.autoCaptured) signals.push("auto");
			if (c.signals.stale) signals.push("stale");
			const preview = c.contentPreview.replace(/\|/g, "\\|").replace(/\n/g, " ");
			lines.push(`| ${c.shortId} | ${c.kind} | ${c.source} | ${c.confidence.toFixed(2)} | ${signals.join(",") || "-"} | ${preview} |`);
		}
		lines.push("");
	}
	if (mode === "simulate") lines.push(`_Dry run — no data modified. Use \`hygiene(mode="purge", tier="${tier}")\` to execute._`);
	return lines.join("\n");
}
function formatPurgeResult(observationsPurged, orphanNodesRemoved, tier) {
	const lines = [];
	lines.push("## Hygiene Purge Complete");
	lines.push(`- Tier: ${tier}`);
	lines.push(`- Observations soft-deleted: ${observationsPurged}`);
	lines.push(`- Orphan graph nodes removed: ${orphanNodesRemoved}`);
	return lines.join("\n");
}
function prependNotifications$4(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function textResponse$5(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function registerHygiene(server, db, projectHashRef, notificationStore = null) {
	server.registerTool("hygiene", {
		title: "Database Hygiene",
		description: "Analyze observations for deletion candidates with confidence scoring. Simulate mode (default) produces a dry-run report. Purge mode soft-deletes candidates and removes dead orphan graph nodes.",
		inputSchema: {
			mode: z.enum(["simulate", "purge"]).default("simulate").describe("simulate = dry-run report, purge = execute deletions"),
			tier: z.enum([
				"high",
				"medium",
				"all"
			]).default("high").describe("Which confidence tier to act on"),
			session_id: z.string().optional().describe("Optional: scope analysis to a single session"),
			limit: z.number().int().min(1).max(200).default(50).describe("Max results to return")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		try {
			const mode = args.mode ?? "simulate";
			const tier = args.tier ?? "high";
			const sessionId = args.session_id;
			const limit = args.limit ?? 50;
			debug("hygiene", "Request", {
				mode,
				tier,
				sessionId,
				limit
			});
			const report = analyzeObservations(db, projectHash, {
				sessionId,
				limit,
				minTier: tier === "all" ? "low" : tier
			});
			if (mode === "purge") {
				const result = executePurge(db, projectHash, report, tier);
				return textResponse$5(prependNotifications$4(notificationStore, projectHash, formatPurgeResult(result.observationsPurged, result.orphanNodesRemoved, tier)));
			}
			return textResponse$5(prependNotifications$4(notificationStore, projectHash, formatReport(report, mode, tier)));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("hygiene", "Error", { error: message });
			return textResponse$5(`Hygiene analysis error: ${message}`);
		}
	});
}

//#endregion
//#region src/mcp/tools/status.ts
function prependNotifications$3(notificationStore, projectHash, responseText) {
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
function registerStatus(server, cache, projectHashRef, notificationStore = null) {
	server.registerTool("status", {
		title: "Laminark Status",
		description: "Show Laminark system status: connection info, memory count, token estimates, and capabilities.",
		inputSchema: {}
	}, async () => {
		const projectHash = projectHashRef.current;
		try {
			debug("mcp", "status: request (cached)");
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return textResponse$4(prependNotifications$3(notificationStore, projectHash, "Laminark: connected"));
			const formatted = cache.getFormatted();
			if (verbosity === 2) return textResponse$4(prependNotifications$3(notificationStore, projectHash, formatted.split("\n").slice(0, 8).join("\n")));
			return textResponse$4(prependNotifications$3(notificationStore, projectHash, formatted));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "status: error", { error: message });
			return textResponse$4(`Status error: ${message}`);
		}
	});
}

//#endregion
//#region src/mcp/status-cache.ts
function formatUptime(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}
var StatusCache = class {
	db;
	projectHashRef;
	projectPath;
	hasVectorSupport;
	isWorkerReady;
	/** Pre-built markdown string (everything except the uptime line). */
	cachedBody = "";
	/** Uptime snapshot at the time cachedBody was built. */
	builtAtUptime = 0;
	dirty = false;
	constructor(db, projectHashRef, projectPath, hasVectorSupport, isWorkerReady) {
		this.db = db;
		this.projectHashRef = projectHashRef;
		this.projectPath = projectPath;
		this.hasVectorSupport = hasVectorSupport;
		this.isWorkerReady = isWorkerReady;
		this.rebuild();
	}
	/** Flag that underlying data has changed (cheap -- no queries). */
	markDirty() {
		this.dirty = true;
	}
	/** Re-query and rebuild if dirty. Call from a background timer. */
	refreshIfDirty() {
		if (!this.dirty) return;
		this.dirty = false;
		this.rebuild();
	}
	/**
	* Return the formatted status string instantly.
	* Patches the uptime line inline so it's always current.
	*/
	getFormatted() {
		const currentUptime = formatUptime(Math.floor(process.uptime()));
		const workerReady = this.isWorkerReady();
		return this.cachedBody.replace(`Uptime: ${formatUptime(this.builtAtUptime)}`, `Uptime: ${currentUptime}`).replace(/Embedding worker: (?:ready|degraded)/, `Embedding worker: ${workerReady ? "ready" : "degraded"}`);
	}
	rebuild() {
		try {
			const ph = this.projectHashRef.current;
			const totalObs = this.db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL").get(ph).cnt;
			const embeddedObs = this.db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL AND embedding_model IS NOT NULL").get(ph).cnt;
			const deletedObs = this.db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NOT NULL").get(ph).cnt;
			const sessions = this.db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM observations WHERE project_hash = ? AND session_id IS NOT NULL AND deleted_at IS NULL").get(ph).cnt;
			let stashes = 0;
			try {
				stashes = this.db.prepare("SELECT COUNT(*) as cnt FROM context_stashes WHERE project_hash = ? AND status = 'stashed'").get(ph).cnt;
			} catch {}
			const totalChars = this.db.prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) as chars FROM observations WHERE project_hash = ? AND deleted_at IS NULL").get(ph).chars;
			let graphNodes = 0;
			let graphEdges = 0;
			try {
				graphNodes = this.db.prepare("SELECT COUNT(*) as cnt FROM graph_nodes").get().cnt;
				graphEdges = this.db.prepare("SELECT COUNT(*) as cnt FROM graph_edges").get().cnt;
			} catch {}
			const uptimeNow = Math.floor(process.uptime());
			const tokenEstimate = estimateTokens(String("x").repeat(totalChars));
			const workerReady = this.isWorkerReady();
			const lines = [];
			lines.push("## Laminark Status");
			lines.push("");
			lines.push("### Connection");
			lines.push(`Project: ${this.projectPath}`);
			lines.push(`Project hash: ${ph}`);
			lines.push(`Database: ${getDbPath()}`);
			lines.push(`Uptime: ${formatUptime(uptimeNow)}`);
			lines.push("");
			lines.push("### Capabilities");
			lines.push(`Vector search: ${this.hasVectorSupport ? "active" : "unavailable (keyword-only)"}`);
			lines.push(`Embedding worker: ${workerReady ? "ready" : "degraded"}`);
			lines.push("");
			lines.push("### Memories");
			lines.push(`Observations: ${totalObs} (${embeddedObs} embedded, ${deletedObs} deleted)`);
			lines.push(`Sessions: ${sessions}`);
			lines.push(`Stashed threads: ${stashes}`);
			lines.push("");
			lines.push("### Tokens");
			lines.push(`Estimated total: ~${tokenEstimate.toLocaleString()} tokens across all memories`);
			lines.push("");
			lines.push("### Knowledge Graph");
			lines.push(`Nodes: ${graphNodes} | Edges: ${graphEdges}`);
			this.cachedBody = lines.join("\n");
			this.builtAtUptime = uptimeNow;
			debug("mcp", "status-cache: rebuilt", {
				memories: totalObs,
				tokens: tokenEstimate
			});
		} catch (err) {
			debug("mcp", "status-cache: rebuild error", { error: err instanceof Error ? err.message : String(err) });
		}
	}
};

//#endregion
//#region src/mcp/tools/discover-tools.ts
function textResponse$3(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
function errorResponse$2(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
function prependNotifications$2(notificationStore, projectHash, responseText) {
	if (!notificationStore) return responseText;
	const pending = notificationStore.consumePending(projectHash);
	if (pending.length === 0) return responseText;
	return pending.map((n) => `[Laminark] ${n.message}`).join("\n") + "\n\n" + responseText;
}
function formatToolResult(result, index) {
	const { tool, score } = result;
	const description = tool.description ? ` -- ${tool.description}` : "";
	const statusTag = tool.status !== "active" ? ` [${tool.status}]` : "";
	const usageStr = tool.usage_count > 0 ? `${tool.usage_count} uses` : "never used";
	const lastUsedStr = tool.last_used_at ? `last: ${tool.last_used_at.slice(0, 10)}` : "never";
	return `${index}. ${tool.name}${statusTag}${description}\n   [${tool.scope}] | ${usageStr} | ${lastUsedStr} | score: ${score.toFixed(2)}`;
}
/**
* Registers the discover_tools MCP tool on the server.
*
* Allows Claude to search the tool registry by keyword or semantic description,
* with optional scope filtering. Returns ranked results with scope, usage count,
* and last used timestamp metadata.
*/
function registerDiscoverTools(server, toolRegistry, worker, hasVectorSupport, notificationStore, projectHashRef) {
	server.registerTool("discover_tools", {
		title: "Discover Tools",
		description: "Search the tool registry to find available tools by keyword or description. Supports semantic search -- \"file manipulation\" finds tools described as \"read and write files\". Returns scope, usage count, and last used timestamp for each result.",
		inputSchema: {
			query: z.string().min(1).describe("Search query: keywords or natural language description"),
			scope: z.enum([
				"global",
				"project",
				"plugin"
			]).optional().describe("Optional scope filter. Omit to search all scopes."),
			limit: z.number().int().min(1).max(50).default(20).describe("Maximum results to return (default: 20)")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$3(prependNotifications$2(notificationStore, projectHash, text));
		try {
			debug("mcp", "discover_tools: request", {
				query: args.query,
				scope: args.scope,
				limit: args.limit
			});
			const searchResults = await toolRegistry.searchTools(args.query, {
				scope: args.scope,
				limit: args.limit,
				worker,
				hasVectorSupport
			});
			if (searchResults.length === 0) {
				const scopeContext = args.scope ? ` in scope "${args.scope}"` : "";
				return withNotifications(`No tools found matching "${args.query}"${scopeContext}.`);
			}
			const seenServers = /* @__PURE__ */ new Set();
			for (const result of searchResults) if (result.tool.tool_type === "mcp_server") seenServers.add(result.tool.server_name ?? result.tool.name);
			const deduped = searchResults.filter((result) => {
				if (result.tool.tool_type === "mcp_tool" && result.tool.server_name && seenServers.has(result.tool.server_name)) return false;
				return true;
			});
			const budgetResult = enforceTokenBudget(deduped, (r) => formatToolResult(r, deduped.indexOf(r) + 1), TOKEN_BUDGET);
			const body = budgetResult.items.map((r, i) => formatToolResult(r, i + 1)).join("\n");
			const scopeLabel = args.scope ?? "all";
			let footer = `---\n${deduped.length} result(s) | query: "${args.query}" | scope: ${scopeLabel}`;
			if (budgetResult.truncated) footer += " | truncated";
			debug("mcp", "discover_tools: returning", {
				total: searchResults.length,
				deduped: deduped.length,
				displayed: budgetResult.items.length,
				truncated: budgetResult.truncated
			});
			return withNotifications(`${body}\n${footer}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "discover_tools: error", { error: message });
			return errorResponse$2(`Discover tools error: ${message}`);
		}
	});
}

//#endregion
//#region src/mcp/tools/report-tools.ts
function textResponse$2(text) {
	return { content: [{
		type: "text",
		text
	}] };
}
/**
* Registers the report_available_tools MCP tool on the server.
*
* Accepts an array of tool names (with optional descriptions) and upserts
* each into the tool registry. Tool type, scope, and server name are inferred
* from the tool name using the same parser as PostToolUse organic discovery.
*/
function registerReportTools(server, toolRegistry, projectHashRef) {
	server.registerTool("report_available_tools", {
		title: "Report Available Tools",
		description: "Register all tools available in this session with Laminark. Call this once at session start with every tool name you have access to (built-in and MCP). This populates the tool registry for discovery and routing.",
		inputSchema: { tools: z.array(z.object({
			name: z.string().min(1).describe("Tool name exactly as it appears (e.g., \"Read\", \"mcp__playwright__browser_click\")"),
			description: z.string().optional().describe("Brief description of the tool")
		})).min(1).describe("Array of tools available in this session") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		try {
			let registered = 0;
			let skipped = 0;
			for (const tool of args.tools) {
				if (tool.name.startsWith("mcp__plugin_laminark_") || tool.name.startsWith("mcp__laminark__")) {
					skipped++;
					continue;
				}
				const toolType = inferToolType(tool.name);
				const scope = inferScope(tool.name);
				const serverName = extractServerName(tool.name);
				toolRegistry.upsert({
					name: tool.name,
					toolType,
					scope,
					source: "config:session-report",
					projectHash: scope === "global" ? null : projectHash,
					description: tool.description ?? null,
					serverName
				});
				registered++;
			}
			debug("mcp", "report_available_tools: completed", {
				total: args.tools.length,
				registered,
				skipped
			});
			return textResponse$2(`Registered ${registered} tools in the tool registry.${skipped > 0 ? ` Skipped ${skipped} Laminark tools (already known).` : ""}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "report_available_tools: error", { error: message });
			return {
				content: [{
					type: "text",
					text: `Report tools error: ${message}`
				}],
				isError: true
			};
		}
	});
}

//#endregion
//#region src/mcp/tools/debug-paths.ts
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
function errorResponse$1(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
function formatKissSummary(raw) {
	if (!raw) return "KISS summary not yet generated";
	try {
		const kiss = JSON.parse(raw);
		const lines = [];
		lines.push(`**Next time:** ${kiss.kiss_summary}`);
		lines.push(`**Root cause:** ${kiss.root_cause}`);
		lines.push(`**What fixed it:** ${kiss.what_fixed_it}`);
		lines.push(`**Logical:** ${kiss.dimensions.logical}`);
		lines.push(`**Programmatic:** ${kiss.dimensions.programmatic}`);
		lines.push(`**Development:** ${kiss.dimensions.development}`);
		return lines.join("\n");
	} catch {
		return "KISS summary not yet generated";
	}
}
/**
* Registers four debug path MCP tools on the server.
*
* Tools: path_start, path_resolve, path_show, path_list
*/
function registerDebugPathTools(server, pathRepo, pathTracker, notificationStore, projectHashRef) {
	server.registerTool("path_start", {
		title: "Start Debug Path",
		description: "Explicitly start tracking a debug path. Use when auto-detection hasn't triggered but you're actively debugging.",
		inputSchema: { trigger: z.string().describe("Brief description of the issue being debugged") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$1(prependNotifications$1(notificationStore, projectHash, text));
		try {
			debug("mcp", "path_start: request", { trigger: args.trigger });
			const existingPathId = pathTracker.getActivePathId();
			const pathId = pathTracker.startManually(args.trigger);
			if (!pathId) return errorResponse$1("Failed to start debug path");
			if (existingPathId && existingPathId === pathId) return withNotifications(`Debug path already active: ${pathId}`);
			return withNotifications(verboseResponse("Debug path started.", `Debug path started: ${pathId}`, `Debug path started: ${pathId}\nTracking: ${args.trigger}`));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "path_start: error", { error: message });
			return errorResponse$1(`path_start error: ${message}`);
		}
	});
	server.registerTool("path_resolve", {
		title: "Resolve Debug Path",
		description: "Explicitly resolve the active debug path with a resolution summary. Use when auto-detection hasn't detected resolution.",
		inputSchema: { resolution: z.string().describe("What fixed the issue") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$1(prependNotifications$1(notificationStore, projectHash, text));
		try {
			debug("mcp", "path_resolve: request", { resolution: args.resolution });
			const pathId = pathTracker.getActivePathId();
			if (!pathId) return errorResponse$1("No active debug path to resolve");
			pathTracker.resolveManually(args.resolution);
			return withNotifications(verboseResponse("Debug path resolved.", `Debug path resolved: ${pathId}`, `Debug path resolved: ${pathId}\nResolution: ${args.resolution}\nKISS summary generating in background...`));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "path_resolve: error", { error: message });
			return errorResponse$1(`path_resolve error: ${message}`);
		}
	});
	server.registerTool("path_show", {
		title: "Show Debug Path",
		description: "Show a debug path with its waypoints and KISS summary.",
		inputSchema: { path_id: z.string().optional().describe("Path ID to show. Omit for active path.") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$1(prependNotifications$1(notificationStore, projectHash, text));
		try {
			debug("mcp", "path_show: request", { path_id: args.path_id });
			let pathData;
			if (args.path_id) {
				pathData = pathRepo.getPath(args.path_id);
				if (!pathData) return errorResponse$1(`Debug path not found: ${args.path_id}`);
			} else {
				pathData = pathRepo.getActivePath();
				if (!pathData) return errorResponse$1("No active debug path");
			}
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return withNotifications(`Showing debug path: ${pathData.status}`);
			const waypoints = pathRepo.getWaypoints(pathData.id);
			if (verbosity === 2) {
				const lines = [];
				lines.push(`## Debug Path: ${pathData.id}`);
				lines.push(`**Status:** ${pathData.status} | **Trigger:** ${pathData.trigger_summary}`);
				lines.push(`Waypoints: ${waypoints.length}`);
				if (pathData.resolution_summary) lines.push(`Resolution: ${pathData.resolution_summary}`);
				return withNotifications(lines.join("\n"));
			}
			const lines = [];
			lines.push(`## Debug Path: ${pathData.id}`);
			lines.push(`Status: ${pathData.status}`);
			lines.push(`Started: ${pathData.started_at}`);
			lines.push(`Trigger: ${pathData.trigger_summary}`);
			lines.push("");
			lines.push(`### Waypoints (${waypoints.length})`);
			for (let i = 0; i < waypoints.length; i++) {
				const wp = waypoints[i];
				lines.push(`${i + 1}. [${wp.waypoint_type}] ${wp.summary} (${wp.created_at})`);
			}
			lines.push("");
			lines.push("### Resolution");
			lines.push(pathData.resolution_summary ?? "Still active");
			lines.push("");
			lines.push("### KISS Summary");
			lines.push(formatKissSummary(pathData.kiss_summary));
			return withNotifications(lines.join("\n"));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "path_show: error", { error: message });
			return errorResponse$1(`path_show error: ${message}`);
		}
	});
	server.registerTool("path_list", {
		title: "List Debug Paths",
		description: "List recent debug paths, optionally filtered by status.",
		inputSchema: {
			status: z.enum([
				"active",
				"resolved",
				"abandoned"
			]).optional().describe("Filter by status"),
			limit: z.number().int().min(1).max(50).default(10).describe("Max paths to return")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse$1(prependNotifications$1(notificationStore, projectHash, text));
		try {
			debug("mcp", "path_list: request", {
				status: args.status,
				limit: args.limit
			});
			let paths = pathRepo.listPaths(args.limit);
			if (args.status) paths = paths.filter((p) => p.status === args.status);
			if (paths.length === 0) return withNotifications("No debug paths found");
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return withNotifications(`${paths.length} debug paths found`);
			const lines = [];
			lines.push("## Debug Paths");
			lines.push("");
			if (verbosity === 2) {
				lines.push("| Status | Trigger |");
				lines.push("|--------|---------|");
				for (const p of paths) {
					const trigger = p.trigger_summary.length > 60 ? p.trigger_summary.slice(0, 60) + "..." : p.trigger_summary;
					lines.push(`| ${p.status} | ${trigger} |`);
				}
			} else {
				lines.push("| ID (short) | Status | Trigger | Started | Resolved |");
				lines.push("|------------|--------|---------|---------|----------|");
				for (const p of paths) {
					const shortId = p.id.slice(0, 8);
					const trigger = p.trigger_summary.length > 50 ? p.trigger_summary.slice(0, 50) + "..." : p.trigger_summary;
					const resolved = p.resolved_at ?? "-";
					lines.push(`| ${shortId} | ${p.status} | ${trigger} | ${p.started_at} | ${resolved} |`);
				}
			}
			return withNotifications(lines.join("\n"));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "path_list: error", { error: message });
			return errorResponse$1(`path_list error: ${message}`);
		}
	});
}

//#endregion
//#region src/mcp/tools/thought-branches.ts
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
function errorResponse(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
function registerThoughtBranchTools(server, branchRepo, obsRepo, notificationStore, projectHashRef) {
	server.registerTool("query_branches", {
		title: "Query Thought Branches",
		description: "Search and list thought branches - coherent units of work (investigations, bug fixes, features). Use to see work history and what was investigated, fixed, or built.",
		inputSchema: {
			status: z.enum([
				"active",
				"completed",
				"abandoned",
				"merged"
			]).optional().describe("Filter by branch status"),
			branch_type: z.enum([
				"investigation",
				"bug_fix",
				"feature",
				"refactor",
				"research",
				"unknown"
			]).optional().describe("Filter by branch type"),
			limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return")
		}
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse(prependNotifications(notificationStore, projectHash, text));
		try {
			debug("mcp", "query_branches: request", {
				status: args.status,
				branch_type: args.branch_type,
				limit: args.limit
			});
			let branches;
			if (args.status) branches = branchRepo.listByStatus(args.status, args.limit);
			else if (args.branch_type) branches = branchRepo.listByType(args.branch_type, args.limit);
			else branches = branchRepo.listBranches(args.limit);
			if (branches.length === 0) return withNotifications("No thought branches found");
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return withNotifications(`${branches.length} branches found`);
			const lines = [];
			lines.push("## Thought Branches");
			lines.push("");
			if (verbosity === 2) {
				lines.push("| Status | Type | Title |");
				lines.push("|--------|------|-------|");
				for (const b of branches) {
					const title = b.title ? b.title.length > 50 ? b.title.slice(0, 50) + "..." : b.title : "-";
					lines.push(`| ${b.status} | ${b.branch_type} | ${title} |`);
				}
			} else {
				lines.push("| ID (short) | Status | Type | Stage | Title | Observations | Started |");
				lines.push("|------------|--------|------|-------|-------|-------------|---------|");
				for (const b of branches) {
					const shortId = b.id.slice(0, 8);
					const title = b.title ? b.title.length > 40 ? b.title.slice(0, 40) + "..." : b.title : "-";
					lines.push(`| ${shortId} | ${b.status} | ${b.branch_type} | ${b.arc_stage} | ${title} | ${b.observation_count} | ${b.started_at} |`);
				}
			}
			return withNotifications(lines.join("\n"));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "query_branches: error", { error: message });
			return errorResponse(`query_branches error: ${message}`);
		}
	});
	server.registerTool("show_branch", {
		title: "Show Thought Branch",
		description: "Show detailed view of a thought branch with observation timeline and arc stage annotations. Trace the full arc of a work unit.",
		inputSchema: { branch_id: z.string().optional().describe("Branch ID to show. Omit for active branch.") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse(prependNotifications(notificationStore, projectHash, text));
		try {
			debug("mcp", "show_branch: request", { branch_id: args.branch_id });
			let branch;
			if (args.branch_id) {
				branch = branchRepo.getBranch(args.branch_id);
				if (!branch) return errorResponse(`Branch not found: ${args.branch_id}`);
			} else {
				branch = branchRepo.getActiveBranch();
				if (!branch) return errorResponse("No active thought branch");
			}
			const verbosity = loadToolVerbosityConfig().level;
			const branchTitle = branch.title ?? branch.id.slice(0, 12);
			if (verbosity === 1) return withNotifications(`Showing "${branchTitle}"`);
			const observations = branchRepo.getObservations(branch.id);
			if (verbosity === 2) {
				const lines = [];
				lines.push(`## ${branchTitle}`);
				lines.push(`**Status:** ${branch.status} | **Type:** ${branch.branch_type} | **Stage:** ${branch.arc_stage}`);
				if (branch.summary) lines.push(branch.summary);
				lines.push(`Observations: ${observations.length}`);
				return withNotifications(lines.join("\n"));
			}
			const lines = [];
			lines.push(`## Thought Branch: ${branchTitle}`);
			lines.push(`**ID:** ${branch.id}`);
			lines.push(`**Status:** ${branch.status}`);
			lines.push(`**Type:** ${branch.branch_type}`);
			lines.push(`**Arc Stage:** ${branch.arc_stage}`);
			lines.push(`**Started:** ${branch.started_at}`);
			if (branch.ended_at) lines.push(`**Ended:** ${branch.ended_at}`);
			if (branch.trigger_source) lines.push(`**Trigger:** ${branch.trigger_source}`);
			if (branch.linked_debug_path_id) lines.push(`**Linked Debug Path:** ${branch.linked_debug_path_id}`);
			lines.push("");
			const tools = Object.entries(branch.tool_pattern).sort(([, a], [, b]) => b - a);
			if (tools.length > 0) {
				lines.push("### Tool Usage");
				for (const [tool, count] of tools) lines.push(`- ${tool}: ${count}`);
				lines.push("");
			}
			if (branch.summary) {
				lines.push("### Summary");
				lines.push(branch.summary);
				lines.push("");
			}
			lines.push(`### Observation Timeline (${observations.length})`);
			for (const bo of observations) {
				const obs = obsRepo.getById(bo.observation_id);
				const content = obs ? obs.title ?? obs.content.slice(0, 100) : bo.observation_id.slice(0, 8);
				const stageTag = bo.arc_stage_at_add ? `[${bo.arc_stage_at_add}]` : "";
				const toolTag = bo.tool_name ? `(${bo.tool_name})` : "";
				lines.push(`${bo.sequence_order}. ${stageTag} ${toolTag} ${content}`);
			}
			return withNotifications(lines.join("\n"));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "show_branch: error", { error: message });
			return errorResponse(`show_branch error: ${message}`);
		}
	});
	server.registerTool("branch_summary", {
		title: "Branch Activity Summary",
		description: "Summary of recent work activity grouped by time window. Shows what was investigated, fixed, built, and where work left off.",
		inputSchema: { hours: z.number().int().min(1).max(168).default(24).describe("Time window in hours (default 24)") }
	}, async (args) => {
		const projectHash = projectHashRef.current;
		const withNotifications = (text) => textResponse(prependNotifications(notificationStore, projectHash, text));
		try {
			debug("mcp", "branch_summary: request", { hours: args.hours });
			const branches = branchRepo.listRecentBranches(args.hours);
			if (branches.length === 0) return withNotifications(`No work branches in the last ${args.hours} hours`);
			const verbosity = loadToolVerbosityConfig().level;
			if (verbosity === 1) return withNotifications(`${branches.length} branches in ${args.hours}h`);
			const active = branches.filter((b) => b.status === "active");
			const completed = branches.filter((b) => b.status === "completed");
			const abandoned = branches.filter((b) => b.status === "abandoned");
			const lines = [];
			lines.push(`## Work Summary (last ${args.hours}h)`);
			lines.push(`**Total branches:** ${branches.length}`);
			lines.push("");
			if (active.length > 0) {
				lines.push("### Active");
				for (const b of active) {
					const title = b.title ?? b.id.slice(0, 8);
					lines.push(verbosity === 2 ? `- ${title} (${b.branch_type})` : `- **${title}** (${b.branch_type}, ${b.arc_stage}) — ${b.observation_count} obs`);
				}
				lines.push("");
			}
			if (completed.length > 0) {
				lines.push("### Completed");
				for (const b of completed) {
					const title = b.title ?? b.id.slice(0, 8);
					const summary = b.summary ? `: ${b.summary.slice(0, 100)}` : "";
					lines.push(verbosity === 2 ? `- ${title} (${b.branch_type})` : `- **${title}** (${b.branch_type})${summary}`);
				}
				lines.push("");
			}
			if (abandoned.length > 0) {
				lines.push("### Abandoned");
				for (const b of abandoned) {
					const title = b.title ?? b.id.slice(0, 8);
					lines.push(verbosity === 2 ? `- ${title} (${b.branch_type})` : `- **${title}** (${b.branch_type}) — ${b.observation_count} obs`);
				}
				lines.push("");
			}
			if (verbosity === 3) {
				const allTools = {};
				for (const b of branches) for (const [tool, count] of Object.entries(b.tool_pattern)) allTools[tool] = (allTools[tool] ?? 0) + count;
				const toolEntries = Object.entries(allTools).sort(([, a], [, b]) => b - a);
				if (toolEntries.length > 0) {
					lines.push("### Tool Distribution");
					for (const [tool, count] of toolEntries.slice(0, 10)) lines.push(`- ${tool}: ${count}`);
				}
			}
			return withNotifications(lines.join("\n"));
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			debug("mcp", "branch_summary: error", { error: message });
			return errorResponse(`branch_summary error: ${message}`);
		}
	});
}

//#endregion
//#region src/branches/arc-detector.ts
const BUILTIN_CATEGORY = {
	"Read": "investigation",
	"Glob": "investigation",
	"Grep": "investigation",
	"WebSearch": "investigation",
	"WebFetch": "investigation",
	"Task": "investigation",
	"AskUserQuestion": "investigation",
	"Write": "write",
	"Edit": "write",
	"NotebookEdit": "write",
	"Bash": "verification",
	"EnterPlanMode": "planning",
	"ExitPlanMode": "planning",
	"TaskCreate": "planning",
	"TaskUpdate": "planning",
	"TaskList": "planning",
	"TaskGet": "planning",
	"Skill": "uncategorized"
};
/** Keywords matched against tool descriptions (case-insensitive). */
const DESCRIPTION_RULES = [
	{
		category: "planning",
		keywords: /\b(plan|todo|task|roadmap|milestone|phase|design|architect)\b/i
	},
	{
		category: "verification",
		keywords: /\b(run|test|build|execute|evaluate|validate|verify|check|assert|lint|compile)\b/i
	},
	{
		category: "write",
		keywords: /\b(write|edit|create|update|save|upload|modify|delete|remove|fill|type|click|select|drag|press|submit|install|deploy|push|commit|insert|drop|replace)\b/i
	},
	{
		category: "investigation",
		keywords: /\b(read|search|query|find|list|get|fetch|browse|snapshot|screenshot|inspect|show|view|discover|status|stats|navigate|hover|recall|monitor|log|trace|debug|profile|measure|analyze|explore)\b/i
	}
];
/**
* Classify a tool from its description text.
* Returns null if no confident match.
*/
function classifyFromDescription(description) {
	for (const rule of DESCRIPTION_RULES) if (rule.keywords.test(description)) return rule.category;
	return null;
}
const NAME_RULES = [
	{
		category: "planning",
		pattern: /\b(plan|todo|task|roadmap|phase|milestone)\b/i
	},
	{
		category: "verification",
		pattern: /\b(run|test|build|exec|evaluate|validate|check|verify)\b/i
	},
	{
		category: "write",
		pattern: /\b(write|edit|create|update|save|upload|fill|type|click|select|drag|press|install)\b/i
	},
	{
		category: "investigation",
		pattern: /\b(search|query|find|list|get|read|fetch|browse|snapshot|screenshot|inspect|show|view|recall|discover|status|stats|console|network|navigate|tabs|hover)\b/i
	}
];
function classifyFromName(toolName) {
	const actionPart = toolName.includes("__") ? toolName.substring(toolName.lastIndexOf("__") + 2) : toolName;
	for (const rule of NAME_RULES) if (rule.pattern.test(actionPart)) return rule.category;
	if (toolName.includes("laminark")) return "investigation";
	return "uncategorized";
}
const classificationCache = /* @__PURE__ */ new Map();
let lastRegistryCount = -1;
/**
* Re-reads the tool_registry table and classifies every tool by its
* description. Only rescans when the registry row count has changed.
*
* Call on startup and periodically (e.g., during BranchTracker maintenance).
*/
function primeFromRegistry(db, projectHash) {
	try {
		const currentCount = db.prepare("SELECT COUNT(*) AS cnt FROM tool_registry").get()?.cnt ?? 0;
		if (currentCount === lastRegistryCount && lastRegistryCount >= 0) return;
		const rows = db.prepare(`
      SELECT name, description FROM tool_registry
      WHERE status = 'active'
        AND (scope = 'global' OR project_hash IS NULL OR project_hash = ?)
    `).all(projectHash);
		let primed = 0;
		for (const row of rows) {
			if (BUILTIN_CATEGORY[row.name]) continue;
			let category = null;
			if (row.description) category = classifyFromDescription(row.description);
			if (!category) category = classifyFromName(row.name);
			classificationCache.set(row.name, category);
			primed++;
		}
		lastRegistryCount = currentCount;
		debug("branches", "Arc detector cache primed from registry", {
			registryTools: rows.length,
			primed
		});
	} catch {}
}
/**
* Classify any tool name into an arc category.
*
* Priority: built-in table > registry-primed cache > name-pattern fallback.
*/
function classifyTool(toolName) {
	const cached = classificationCache.get(toolName);
	if (cached) return cached;
	const builtin = BUILTIN_CATEGORY[toolName];
	if (builtin) {
		classificationCache.set(toolName, builtin);
		return builtin;
	}
	const fromName = classifyFromName(toolName);
	classificationCache.set(toolName, fromName);
	return fromName;
}
/**
* Infers the current arc stage from tool usage pattern counts.
*
* Handles all tool types: builtins, MCP tools, plugins, skills, slash commands.
* Uncategorized tools are excluded from ratio calculations so they don't
* dilute the signal from known tools.
*
* @param toolPattern - Map of tool name to usage count within the branch
* @param classification - Optional dominant observation classification
* @returns The inferred arc stage
*/
function inferArcStage(toolPattern, classification) {
	let investigationCount = 0;
	let writeCount = 0;
	let verificationCount = 0;
	let planningCount = 0;
	let categorizedCount = 0;
	for (const [tool, count] of Object.entries(toolPattern)) switch (classifyTool(tool)) {
		case "investigation":
			investigationCount += count;
			categorizedCount += count;
			break;
		case "write":
			writeCount += count;
			categorizedCount += count;
			break;
		case "verification":
			verificationCount += count;
			categorizedCount += count;
			break;
		case "planning":
			planningCount += count;
			categorizedCount += count;
			break;
		case "uncategorized": break;
	}
	if (categorizedCount === 0) return "investigation";
	if (verificationCount > 0 && writeCount > 0) {
		if (verificationCount / categorizedCount > .2) return "verification";
	}
	if (writeCount / categorizedCount > .4) return "execution";
	if (planningCount > 0) {
		if (planningCount / categorizedCount > .1) return "planning";
	}
	if (classification === "problem" && writeCount > 0 && investigationCount > 0) return "diagnosis";
	return "investigation";
}

//#endregion
//#region src/config/haiku-config.ts
function loadHaikuConfig() {
	return {
		model: "claude-haiku-4-5-20251001",
		maxTokensPerCall: 1024
	};
}

//#endregion
//#region src/intelligence/haiku-client.ts
/**
* Shared Haiku client using Claude Agent SDK V2 session.
*
* Routes Haiku calls through the user's Claude Code subscription
* instead of requiring a separate API key. Uses a persistent session
* to avoid 12s cold-start overhead on sequential calls.
*
* Provides the core infrastructure for all Haiku agent modules:
* - callHaiku() helper for structured prompt/response calls
* - extractJsonFromResponse() for defensive JSON parsing
* - Session reuse across batch processing cycles
*/
let _session = null;
function getOrCreateSession() {
	if (!_session) _session = unstable_v2_createSession({
		model: loadHaikuConfig().model,
		permissionMode: "bypassPermissions",
		allowedTools: []
	});
	return _session;
}
/**
* Returns whether Haiku enrichment is available.
* Always true with subscription auth -- no API key check needed.
*/
function isHaikuEnabled() {
	return true;
}
/**
* Calls Haiku with a system prompt and user content.
* Returns the text content from the response.
*
* Uses a persistent V2 session to avoid cold-start overhead on sequential calls.
* System prompt is embedded in the user message since session-level systemPrompt
* is set at creation time and we need different prompts per agent.
*
* @param systemPrompt - Instructions for the model
* @param userContent - The content to process
* @param _maxTokens - Kept for signature compatibility (unused -- Agent SDK constrains output via prompts)
* @throws Error if the Haiku call fails or session expires
*/
async function callHaiku(systemPrompt, userContent, _maxTokens) {
	const session = getOrCreateSession();
	const fullPrompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userContent}`;
	try {
		await session.send(fullPrompt);
		for await (const msg of session.stream()) if (msg.type === "result") {
			if (msg.subtype === "success") return msg.result;
			const errorMsg = ("errors" in msg ? msg.errors : void 0)?.join(", ") ?? msg.subtype;
			throw new Error(`Haiku call failed: ${errorMsg}`);
		}
		return "";
	} catch (error) {
		try {
			_session?.close();
		} catch {}
		_session = null;
		throw error;
	}
}
/**
* Defensive JSON extraction from Haiku response text.
*
* Handles common LLM response quirks:
* - Markdown code fences (```json ... ```)
* - Explanatory text before/after JSON
* - Both array and object JSON shapes
*
* @throws Error if no JSON structure found in text
*/
function extractJsonFromResponse(text) {
	const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
	if (arrayMatch) return JSON.parse(arrayMatch[0]);
	const objMatch = cleaned.match(/\{[\s\S]*\}/);
	if (objMatch) return JSON.parse(objMatch[0]);
	throw new Error("No JSON found in Haiku response");
}

//#endregion
//#region src/branches/branch-classifier-agent.ts
/**
* Haiku agent for classifying thought branch type and generating title/summary.
*
* Uses a single Haiku call to determine:
* 1. Branch type (investigation, bug_fix, feature, refactor, research)
* 2. A concise title for the branch
* 3. An optional summary (for completed branches)
*
* Follows the same pattern as haiku-classifier-agent.ts.
*/
const ClassifyBranchSchema = z.object({
	branch_type: z.enum([
		"investigation",
		"bug_fix",
		"feature",
		"refactor",
		"research"
	]),
	title: z.string().max(100)
});
const SummarizeBranchSchema = z.object({ summary: z.string().max(500) });
const CLASSIFY_PROMPT = `You classify developer work branches for a knowledge management system.

Given a sequence of observations from a work session, determine:
1. branch_type: What kind of work is this?
   - "investigation": Exploring code, reading docs, understanding behavior
   - "bug_fix": Fixing an error, test failure, or unexpected behavior
   - "feature": Building new functionality
   - "refactor": Restructuring existing code without changing behavior
   - "research": Looking up external resources, comparing approaches

2. title: A concise title (3-8 words) describing the work unit. Use imperative form.
   Examples: "Fix auth token refresh", "Add branch detection system", "Investigate memory leak"

Return JSON: {"branch_type": "...", "title": "..."}
No markdown, no explanation, ONLY the JSON object.`;
const SUMMARIZE_PROMPT = `You summarize completed developer work branches for a knowledge management system.

Given a sequence of observations from a completed work branch, write a concise summary (1-3 sentences) that captures:
- What was the goal
- What was done
- What was the outcome

Return JSON: {"summary": "..."}
No markdown, no explanation, ONLY the JSON object.`;
/**
* Classifies a branch type and generates a title from observation content.
*/
async function classifyBranchWithHaiku(observationTexts, toolPattern) {
	const parsed = extractJsonFromResponse(await callHaiku(CLASSIFY_PROMPT, [
		`Tool usage: ${Object.entries(toolPattern).sort(([, a], [, b]) => b - a).map(([tool, count]) => `${tool}: ${count}`).join(", ")}`,
		"",
		"Observations:",
		...observationTexts.slice(0, 10).map((t, i) => `${i + 1}. ${t.slice(0, 200)}`)
	].join("\n"), 256));
	return ClassifyBranchSchema.parse(parsed);
}
/**
* Generates a completion summary for a finished branch.
*/
async function summarizeBranchWithHaiku(title, branchType, observationTexts) {
	const parsed = extractJsonFromResponse(await callHaiku(SUMMARIZE_PROMPT, [
		`Branch: ${title} (${branchType})`,
		"",
		"Observations:",
		...observationTexts.slice(0, 15).map((t, i) => `${i + 1}. ${t.slice(0, 200)}`)
	].join("\n"), 256));
	return SummarizeBranchSchema.parse(parsed);
}

//#endregion
//#region src/branches/branch-tracker.ts
const TIME_GAP_MS = 900 * 1e3;
var BranchTracker = class {
	state = "idle";
	activeBranchId = null;
	activeProjectHash = null;
	activeSessionId = null;
	lastObservationTime = 0;
	toolPattern = {};
	repo;
	db;
	projectHash;
	constructor(repo, db, projectHash) {
		this.repo = repo;
		this.db = db;
		this.projectHash = projectHash;
		primeFromRegistry(db, projectHash);
		const activeBranch = repo.findRecentActiveBranch();
		if (activeBranch) {
			this.state = "tracking";
			this.activeBranchId = activeBranch.id;
			this.activeProjectHash = activeBranch.project_hash;
			this.activeSessionId = activeBranch.session_id;
			this.toolPattern = activeBranch.tool_pattern;
			this.lastObservationTime = new Date(activeBranch.started_at).getTime();
			debug("branches", "Recovered active branch from DB", { branchId: activeBranch.id });
		}
	}
	/**
	* Process a new observation through the boundary detection state machine.
	* Called from HaikuProcessor after classification (Step 1.6).
	*/
	processObservation(obs) {
		const now = Date.now();
		const obsTime = new Date(obs.createdAt).getTime();
		const toolName = this.extractToolName(obs.source);
		const boundary = this.detectBoundary(obs, obsTime);
		if (boundary) {
			if (this.state === "tracking" && this.activeBranchId) this.completeBranch();
			this.startBranch(boundary, obs);
		} else if (this.state === "idle") this.startBranch("session_start", obs);
		if (this.activeBranchId) {
			const arcStage = inferArcStage(this.toolPattern, obs.classification);
			if (toolName) {
				this.toolPattern[toolName] = (this.toolPattern[toolName] ?? 0) + 1;
				this.repo.updateToolPattern(this.activeBranchId, this.toolPattern);
			}
			this.repo.addObservation(this.activeBranchId, obs.id, toolName, arcStage);
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
	onTopicShift(observationId) {
		if (this.state === "tracking" && this.activeBranchId) {
			this.completeBranch();
			debug("branches", "Topic shift boundary detected", { observationId });
		}
	}
	/**
	* Link the active branch to a debug path (when PathTracker activates).
	*/
	linkDebugPath(debugPathId) {
		if (this.activeBranchId) {
			this.repo.linkDebugPath(this.activeBranchId, debugPathId);
			debug("branches", "Linked debug path to branch", {
				branchId: this.activeBranchId,
				debugPathId
			});
		}
	}
	/**
	* Get the active branch ID (for external callers).
	*/
	getActiveBranchId() {
		return this.activeBranchId;
	}
	/**
	* Run periodic maintenance tasks:
	* - Classify branches with 3+ observations via Haiku
	* - Generate summaries for recently completed branches
	* - Auto-abandon stale branches (>24h)
	* - Link branches to debug paths
	*/
	async runMaintenance() {
		try {
			primeFromRegistry(this.db, this.projectHash);
			const stale = this.repo.findStaleBranches();
			for (const branch of stale) {
				this.repo.abandonBranch(branch.id);
				if (this.activeBranchId === branch.id) {
					this.state = "idle";
					this.activeBranchId = null;
					this.toolPattern = {};
				}
				debug("branches", "Auto-abandoned stale branch", { branchId: branch.id });
			}
			if (isHaikuEnabled()) {
				const unclassified = this.repo.findUnclassifiedBranches(3);
				for (const branch of unclassified) try {
					const observations = this.repo.getObservations(branch.id);
					const obsRepo = new ObservationRepository(this.db, branch.project_hash);
					const texts = observations.map((bo) => {
						const obs = obsRepo.getById(bo.observation_id);
						return obs ? obs.title ? `${obs.title}: ${obs.content}` : obs.content : null;
					}).filter((t) => t !== null);
					if (texts.length === 0) continue;
					const result = await classifyBranchWithHaiku(texts, branch.tool_pattern);
					this.repo.updateClassification(branch.id, result.branch_type, result.title);
					debug("branches", "Branch classified", {
						branchId: branch.id,
						type: result.branch_type,
						title: result.title
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					debug("branches", "Branch classification failed (non-fatal)", {
						branchId: branch.id,
						error: msg
					});
				}
				const unsummarized = this.repo.findRecentCompletedUnsummarized(2);
				for (const branch of unsummarized) try {
					const observations = this.repo.getObservations(branch.id);
					const obsRepo = new ObservationRepository(this.db, branch.project_hash);
					const texts = observations.map((bo) => {
						const obs = obsRepo.getById(bo.observation_id);
						return obs ? obs.title ? `${obs.title}: ${obs.content}` : obs.content : null;
					}).filter((t) => t !== null);
					if (texts.length === 0) continue;
					const result = await summarizeBranchWithHaiku(branch.title ?? "Untitled", branch.branch_type, texts);
					this.repo.updateSummary(branch.id, result.summary);
					debug("branches", "Branch summarized", { branchId: branch.id });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					debug("branches", "Branch summarization failed (non-fatal)", {
						branchId: branch.id,
						error: msg
					});
				}
			}
		} catch (err) {
			debug("branches", "Maintenance error (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
		}
	}
	detectBoundary(obs, obsTime) {
		if (this.activeProjectHash && obs.projectHash !== this.activeProjectHash) return "project_switch";
		if (this.activeSessionId && obs.sessionId && obs.sessionId !== this.activeSessionId) return "session_start";
		if (this.lastObservationTime > 0) {
			if (obsTime - this.lastObservationTime > TIME_GAP_MS) return "time_gap";
		}
		return null;
	}
	startBranch(triggerSource, obs) {
		const branch = this.repo.createBranch(obs.sessionId ?? null, triggerSource, obs.id);
		this.state = "tracking";
		this.activeBranchId = branch.id;
		this.toolPattern = {};
		debug("branches", "New branch started", {
			branchId: branch.id,
			trigger: triggerSource
		});
	}
	completeBranch() {
		if (!this.activeBranchId) return;
		this.repo.completeBranch(this.activeBranchId);
		debug("branches", "Branch completed", { branchId: this.activeBranchId });
		this.state = "idle";
		this.activeBranchId = null;
		this.toolPattern = {};
	}
	extractToolName(source) {
		if (source.startsWith("hook:")) return source.slice(5);
		if (source.startsWith("mcp:")) return source.slice(4);
		return null;
	}
};

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
				limit: 20,
				includeUnclassified: true
			}).filter((obs) => obs.createdAt < observation.createdAt);
			if (previousObservations.length === 0) {
				debug("hook", "TopicShiftHandler: no previous observations to stash, skipping");
				return {
					stashed: false,
					notification: null
				};
			}
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
	* Generate a semantic topic label from the observations.
	*
	* Priority: use observation titles (most semantic), then fall back
	* to content. Scans all observations for the best available label
	* rather than just using the first one.
	*/
	generateTopicLabel(observations) {
		if (observations.length === 0) return "Unknown topic";
		for (const obs of observations) if (obs.title) {
			const cleaned = obs.title.replace(/\n/g, " ").trim();
			if (cleaned.length > 0) return cleaned.slice(0, 80);
		}
		return observations[observations.length - 1].content.replace(/\n/g, " ").trim().slice(0, 80) || "Unknown topic";
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
const DEFAULTS$2 = {
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
		return { ...DEFAULTS$2 };
	}
	const preset = [
		"sensitive",
		"balanced",
		"relaxed"
	].includes(raw.sensitivityPreset) ? raw.sensitivityPreset : DEFAULTS$2.sensitivityPreset;
	const multiplier = typeof raw.sensitivityMultiplier === "number" && raw.sensitivityMultiplier > 0 ? raw.sensitivityMultiplier : sensitivityPresetToMultiplier(preset);
	const manualThreshold = typeof raw.manualThreshold === "number" ? raw.manualThreshold : null;
	const ewmaAlpha = typeof raw.ewmaAlpha === "number" && raw.ewmaAlpha > 0 && raw.ewmaAlpha <= 1 ? raw.ewmaAlpha : DEFAULTS$2.ewmaAlpha;
	let boundsMin = typeof raw.thresholdBounds?.min === "number" ? raw.thresholdBounds.min : DEFAULTS$2.thresholdBounds.min;
	let boundsMax = typeof raw.thresholdBounds?.max === "number" ? raw.thresholdBounds.max : DEFAULTS$2.thresholdBounds.max;
	if (boundsMin < .05) boundsMin = .05;
	if (boundsMax > .95) boundsMax = .95;
	if (boundsMin >= boundsMax) {
		boundsMin = DEFAULTS$2.thresholdBounds.min;
		boundsMax = DEFAULTS$2.thresholdBounds.max;
	}
	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS$2.enabled;
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
//#region src/config/graph-extraction-config.ts
/**
* Graph Extraction Configuration
*
* User-configurable settings for knowledge graph extraction behavior.
* Follows the same pattern as topic-detection-config.ts.
*
* Configuration is loaded from .laminark/graph-extraction.json with
* safe defaults when the file does not exist.
*/
const DEFAULTS$1 = {
	enabled: true,
	signalClassifier: {
		highSignalSources: [
			"manual",
			"hook:Write",
			"hook:Edit",
			"hook:WebFetch",
			"hook:WebSearch"
		],
		mediumSignalSources: ["hook:Bash", "curation:merge"],
		skipSources: [
			"hook:TaskUpdate",
			"hook:TaskCreate",
			"hook:EnterPlanMode",
			"hook:ExitPlanMode",
			"hook:Read",
			"hook:Glob",
			"hook:Grep"
		],
		minContentLength: 30
	},
	qualityGate: {
		minNameLength: 3,
		maxNameLength: 200,
		maxFilesPerObservation: 5,
		typeConfidenceThresholds: {
			File: .95,
			Project: .8,
			Reference: .85,
			Decision: .65,
			Problem: .6,
			Solution: .6
		},
		fileNonChangeMultiplier: .74
	},
	relationshipDetector: { minEdgeConfidence: .45 },
	temporalDecay: {
		halfLifeDays: 30,
		minFloor: .05,
		deletionThreshold: .08,
		maxAgeDays: 180
	},
	fuzzyDedup: {
		maxLevenshteinDistance: 2,
		jaccardThreshold: .7
	}
};
/**
* Loads graph extraction configuration from disk.
*
* Reads .laminark/graph-extraction.json (relative to the Laminark data
* directory). Falls back to defaults if the file does not exist or
* cannot be parsed. Validates threshold constraints.
*/
function loadGraphExtractionConfig() {
	const configPath = join(getConfigDir(), "graph-extraction.json");
	let raw = {};
	try {
		const content = readFileSync(configPath, "utf-8");
		raw = JSON.parse(content);
		debug("config", "Loaded graph extraction config", { path: configPath });
	} catch {
		debug("config", "No graph extraction config found, using defaults");
		return { ...DEFAULTS$1 };
	}
	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS$1.enabled;
	const signalClassifier = {
		highSignalSources: Array.isArray(raw.signalClassifier?.highSignalSources) ? raw.signalClassifier.highSignalSources : DEFAULTS$1.signalClassifier.highSignalSources,
		mediumSignalSources: Array.isArray(raw.signalClassifier?.mediumSignalSources) ? raw.signalClassifier.mediumSignalSources : DEFAULTS$1.signalClassifier.mediumSignalSources,
		skipSources: Array.isArray(raw.signalClassifier?.skipSources) ? raw.signalClassifier.skipSources : DEFAULTS$1.signalClassifier.skipSources,
		minContentLength: typeof raw.signalClassifier?.minContentLength === "number" && raw.signalClassifier.minContentLength >= 0 ? raw.signalClassifier.minContentLength : DEFAULTS$1.signalClassifier.minContentLength
	};
	const rawQG = raw.qualityGate;
	const typeConf = { ...DEFAULTS$1.qualityGate.typeConfidenceThresholds };
	if (rawQG?.typeConfidenceThresholds) {
		for (const [key, val] of Object.entries(rawQG.typeConfidenceThresholds)) if (typeof val === "number" && val >= 0 && val <= 1) typeConf[key] = val;
	}
	let fileMultiplier = typeof rawQG?.fileNonChangeMultiplier === "number" ? rawQG.fileNonChangeMultiplier : DEFAULTS$1.qualityGate.fileNonChangeMultiplier;
	if (fileMultiplier < 0 || fileMultiplier > 1) fileMultiplier = DEFAULTS$1.qualityGate.fileNonChangeMultiplier;
	const qualityGate = {
		minNameLength: typeof rawQG?.minNameLength === "number" && rawQG.minNameLength >= 1 ? rawQG.minNameLength : DEFAULTS$1.qualityGate.minNameLength,
		maxNameLength: typeof rawQG?.maxNameLength === "number" && rawQG.maxNameLength >= 10 ? rawQG.maxNameLength : DEFAULTS$1.qualityGate.maxNameLength,
		maxFilesPerObservation: typeof rawQG?.maxFilesPerObservation === "number" && rawQG.maxFilesPerObservation >= 1 ? rawQG.maxFilesPerObservation : DEFAULTS$1.qualityGate.maxFilesPerObservation,
		typeConfidenceThresholds: typeConf,
		fileNonChangeMultiplier: fileMultiplier
	};
	let minEdge = typeof raw.relationshipDetector?.minEdgeConfidence === "number" ? raw.relationshipDetector.minEdgeConfidence : DEFAULTS$1.relationshipDetector.minEdgeConfidence;
	if (minEdge < 0 || minEdge > 1) minEdge = DEFAULTS$1.relationshipDetector.minEdgeConfidence;
	const relationshipDetector = { minEdgeConfidence: minEdge };
	const rawTD = raw.temporalDecay;
	const temporalDecay = {
		halfLifeDays: typeof rawTD?.halfLifeDays === "number" && rawTD.halfLifeDays > 0 ? rawTD.halfLifeDays : DEFAULTS$1.temporalDecay.halfLifeDays,
		minFloor: typeof rawTD?.minFloor === "number" && rawTD.minFloor >= 0 && rawTD.minFloor < 1 ? rawTD.minFloor : DEFAULTS$1.temporalDecay.minFloor,
		deletionThreshold: typeof rawTD?.deletionThreshold === "number" && rawTD.deletionThreshold >= 0 && rawTD.deletionThreshold < 1 ? rawTD.deletionThreshold : DEFAULTS$1.temporalDecay.deletionThreshold,
		maxAgeDays: typeof rawTD?.maxAgeDays === "number" && rawTD.maxAgeDays > 0 ? rawTD.maxAgeDays : DEFAULTS$1.temporalDecay.maxAgeDays
	};
	const rawFD = raw.fuzzyDedup;
	return {
		enabled,
		signalClassifier,
		qualityGate,
		relationshipDetector,
		temporalDecay,
		fuzzyDedup: {
			maxLevenshteinDistance: typeof rawFD?.maxLevenshteinDistance === "number" && rawFD.maxLevenshteinDistance >= 1 ? rawFD.maxLevenshteinDistance : DEFAULTS$1.fuzzyDedup.maxLevenshteinDistance,
			jaccardThreshold: typeof rawFD?.jaccardThreshold === "number" && rawFD.jaccardThreshold > 0 && rawFD.jaccardThreshold <= 1 ? rawFD.jaccardThreshold : DEFAULTS$1.fuzzyDedup.jaccardThreshold
		}
	};
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
	const sim = jaccardSimilarity$1(a.text, b.text);
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
//#region src/graph/fuzzy-dedup.ts
const DEFAULT_MAX_LEVENSHTEIN = 2;
const DEFAULT_JACCARD_THRESHOLD = .7;
/**
* Computes Levenshtein edit distance between two strings.
* Uses the iterative matrix approach with O(min(m,n)) space.
*/
function levenshteinDistance(a, b) {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (a.length > b.length) [a, b] = [b, a];
	const aLen = a.length;
	const bLen = b.length;
	let prev = new Array(aLen + 1);
	let curr = new Array(aLen + 1);
	for (let i = 0; i <= aLen; i++) prev[i] = i;
	for (let j = 1; j <= bLen; j++) {
		curr[0] = j;
		for (let i = 1; i <= aLen; i++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[aLen];
}
/**
* Tokenizes a name by splitting on common delimiters: / . _ -
* and lowercasing all tokens.
*/
function tokenizeName(name) {
	const tokens = name.toLowerCase().split(/[/._\-\s]+/).filter((t) => t.length > 0);
	return new Set(tokens);
}
/**
* Computes Jaccard similarity between two token sets.
* J(A,B) = |A ∩ B| / |A ∪ B|
* Returns 0 if both sets are empty.
*/
function jaccardSimilarity(a, b) {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection++;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
/**
* Checks if two File paths refer to the same file via suffix matching.
* For example: "src/graph/types.ts" and "graph/types.ts" match because
* one is a suffix of the other.
*/
function isPathSuffixMatch(path1, path2) {
	const norm1 = path1.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
	const norm2 = path2.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
	if (norm1 === norm2) return false;
	return norm1.endsWith("/" + norm2) || norm2.endsWith("/" + norm1);
}
/**
* Finds fuzzy duplicates among a list of same-type nodes.
*
* Strategies applied:
*   1. Levenshtein distance ≤ max (default 2) for typo tolerance
*   2. Jaccard word similarity ≥ threshold (default 0.7)
*   3. Path suffix matching for File type
*
* Only compares nodes of the same type. Returns grouped duplicate
* candidates with reasons.
*
* @param nodes - Nodes to check (should be same type for best results)
* @param config - Optional configuration overrides
* @returns Array of duplicate groups with entities and reason
*/
function findFuzzyDuplicates(nodes, config) {
	const maxLev = config?.fuzzyDedup?.maxLevenshteinDistance ?? DEFAULT_MAX_LEVENSHTEIN;
	const jaccardThresh = config?.fuzzyDedup?.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;
	const duplicates = [];
	const seen = /* @__PURE__ */ new Set();
	for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
		const a = nodes[i];
		const b = nodes[j];
		if (a.type !== b.type) continue;
		const pairKey = [a.id, b.id].sort().join(",");
		if (seen.has(pairKey)) continue;
		const aLower = a.name.toLowerCase();
		const bLower = b.name.toLowerCase();
		if (aLower === bLower) continue;
		if (aLower.length <= 50 && bLower.length <= 50) {
			if (Math.abs(aLower.length - bLower.length) <= maxLev) {
				const dist = levenshteinDistance(aLower, bLower);
				if (dist > 0 && dist <= maxLev) {
					seen.add(pairKey);
					duplicates.push({
						entities: [a, b],
						reason: `Fuzzy match (Levenshtein distance ${dist}): "${a.name}" ↔ "${b.name}"`
					});
					continue;
				}
			}
		}
		const tokensA = tokenizeName(a.name);
		const tokensB = tokenizeName(b.name);
		if (tokensA.size >= 2 && tokensB.size >= 2) {
			const similarity = jaccardSimilarity(tokensA, tokensB);
			if (similarity >= jaccardThresh) {
				seen.add(pairKey);
				duplicates.push({
					entities: [a, b],
					reason: `Fuzzy match (Jaccard similarity ${similarity.toFixed(2)}): "${a.name}" ↔ "${b.name}"`
				});
				continue;
			}
		}
		if (a.type === "File") {
			if (isPathSuffixMatch(a.name, b.name)) {
				seen.add(pairKey);
				duplicates.push({
					entities: [a, b],
					reason: `Path suffix match: "${a.name}" ↔ "${b.name}"`
				});
			}
		}
	}
	return duplicates;
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
	rs: "rust"
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
	const byType = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		const group = byType.get(node.type) ?? [];
		group.push(node);
		byType.set(node.type, group);
	}
	for (const [, typeNodes] of byType) {
		const fuzzyResults = findFuzzyDuplicates(typeNodes, opts?.graphConfig);
		for (const result of fuzzyResults) {
			const ids = result.entities.map((n) => n.id).sort().join(",");
			if (!seen.has(ids)) {
				seen.add(ids);
				duplicates.push(result);
			}
		}
	}
	return duplicates;
}

//#endregion
//#region src/graph/temporal-decay.ts
const DEFAULTS = {
	halfLifeDays: 30,
	minFloor: .05,
	deletionThreshold: .08,
	maxAgeDays: 180
};
/**
* Calculates the decayed weight for an edge based on its age.
*
* Uses exponential decay: weight * e^(-ln(2)/halfLife * ageDays)
* Result is clamped to the minimum floor.
*
* @param originalWeight - The edge's current stored weight
* @param ageDays - Age of the edge in days
* @param config - Decay parameters
* @returns The decayed weight value
*/
function calculateDecayedWeight(originalWeight, ageDays, config) {
	const halfLife = config?.halfLifeDays ?? DEFAULTS.halfLifeDays;
	const minFloor = config?.minFloor ?? DEFAULTS.minFloor;
	if (ageDays <= 0) return originalWeight;
	const decayRate = Math.LN2 / halfLife;
	const decayed = originalWeight * Math.exp(-decayRate * ageDays);
	return Math.max(decayed, minFloor);
}
/**
* Applies temporal decay to all edges in the graph.
*
* For each edge:
*   1. Calculate age from created_at timestamp
*   2. Apply exponential decay formula
*   3. Delete edges below deletion threshold or older than max age
*   4. Update remaining edges with new decayed weights
*
* Runs in a transaction for atomicity.
*
* @param db - Database handle
* @param graphConfig - Optional configuration from graph-extraction-config
* @returns Count of updated and deleted edges
*/
function applyTemporalDecay(db, graphConfig) {
	const halfLife = graphConfig?.temporalDecay?.halfLifeDays ?? DEFAULTS.halfLifeDays;
	const minFloor = graphConfig?.temporalDecay?.minFloor ?? DEFAULTS.minFloor;
	const deletionThreshold = graphConfig?.temporalDecay?.deletionThreshold ?? DEFAULTS.deletionThreshold;
	const maxAgeDays = graphConfig?.temporalDecay?.maxAgeDays ?? DEFAULTS.maxAgeDays;
	let updated = 0;
	let deleted = 0;
	db.transaction(() => {
		const edges = db.prepare(`
      SELECT id, weight,
        julianday('now') - julianday(created_at) as age_days
      FROM graph_edges
    `).all();
		const deleteStmt = db.prepare("DELETE FROM graph_edges WHERE id = ?");
		const updateStmt = db.prepare("UPDATE graph_edges SET weight = ? WHERE id = ?");
		for (const edge of edges) {
			if (edge.age_days > maxAgeDays) {
				deleteStmt.run(edge.id);
				deleted++;
				continue;
			}
			const decayed = calculateDecayedWeight(edge.weight, edge.age_days, {
				halfLifeDays: halfLife,
				minFloor
			});
			if (decayed < deletionThreshold) {
				deleteStmt.run(edge.id);
				deleted++;
				continue;
			}
			if (Math.abs(decayed - edge.weight) > .001) {
				updateStmt.run(decayed, edge.id);
				updated++;
			}
		}
	})();
	return {
		updated,
		deleted
	};
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
async function runCuration(db, graphConfig) {
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	const errors = [];
	let observationsMerged = 0;
	let entitiesDeduplicated = 0;
	let stalenessFlagsAdded = 0;
	let lowValuePruned = 0;
	let temporalDecayUpdated = 0;
	let temporalDecayDeleted = 0;
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
	try {
		const decayResult = applyTemporalDecay(db, graphConfig);
		temporalDecayUpdated = decayResult.updated;
		temporalDecayDeleted = decayResult.deleted;
	} catch (err) {
		errors.push(`Step 6 (temporal decay): ${err instanceof Error ? err.message : String(err)}`);
	}
	const report = {
		startedAt,
		completedAt: (/* @__PURE__ */ new Date()).toISOString(),
		observationsMerged,
		entitiesDeduplicated,
		stalenessFlagsAdded,
		lowValuePruned,
		temporalDecayUpdated,
		temporalDecayDeleted,
		errors
	};
	process.stderr.write(`[laminark:curation] Cycle complete: ${observationsMerged} merged, ${entitiesDeduplicated} deduped, ${stalenessFlagsAdded} flagged stale, ${lowValuePruned} pruned, ${temporalDecayUpdated} decayed, ${temporalDecayDeleted} decay-deleted\n`);
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
	graphConfig;
	running = false;
	cycling = false;
	lastRun = null;
	timer = null;
	constructor(db, opts) {
		this.db = db;
		this.intervalMs = opts?.intervalMs ?? 3e5;
		this.onComplete = opts?.onComplete;
		this.graphConfig = opts?.graphConfig;
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
		if (this.cycling) return {
			startedAt: "",
			completedAt: "",
			observationsMerged: 0,
			entitiesDeduplicated: 0,
			stalenessFlagsAdded: 0,
			lowValuePruned: 0,
			temporalDecayUpdated: 0,
			temporalDecayDeleted: 0,
			errors: ["skipped: previous cycle still running"]
		};
		this.cycling = true;
		try {
			const report = await runCuration(this.db, this.graphConfig);
			this.lastRun = report.completedAt;
			if (this.onComplete) this.onComplete(report);
			return report;
		} finally {
			this.cycling = false;
		}
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
//#region src/intelligence/haiku-classifier-agent.ts
/**
* Combined noise/signal and observation classification agent.
*
* Uses a single Haiku call to determine:
* 1. Whether an observation is noise or signal
* 2. If signal, what kind of observation it is (discovery/problem/solution)
* 3. Whether the observation contains debug signals (error/resolution detection)
*
* Replaces both the regex-based noise-patterns.ts/signal-classifier.ts and the
* broken MCP sampling observation-classifier.ts with a single focused LLM call.
*/
const DebugSignalSchema = z.object({
	is_error: z.boolean(),
	is_resolution: z.boolean(),
	waypoint_hint: z.enum([
		"error",
		"attempt",
		"failure",
		"success",
		"pivot",
		"revert",
		"discovery",
		"resolution"
	]).nullable(),
	confidence: z.number()
}).nullable();
const ClassificationSchema = z.object({
	signal: z.enum(["noise", "signal"]),
	classification: z.enum([
		"discovery",
		"problem",
		"solution"
	]).nullable(),
	reason: z.string(),
	debug_signal: DebugSignalSchema.default(null)
});
const SYSTEM_PROMPT$3 = `You classify developer observations for a knowledge management system.

For each observation, determine:
1. signal: Is this noise or signal?
   - "noise": build output, linter spam, package install logs, empty/trivial content, routine navigation, repeated boilerplate, test runner output with no failures
   - "signal": meaningful findings, decisions, problems, solutions, reference material, architectural insights

2. classification (only if signal): What kind of observation is this?
   - "discovery": new understanding, finding, insight, or reference material
   - "problem": error, bug, failure, or obstacle encountered
   - "solution": fix, resolution, workaround, or decision that resolved something

3. debug_signal (always, even for noise): Is this related to ACTIVE debugging (the developer hit an actual error)?
   - is_error: Did an actual error/failure OCCUR in this observation? An error message, stack trace, test failure, or build failure that happened RIGHT NOW. NOT research about errors — searching for "reconnection problems" or reading docs about error handling is NOT is_error. The tool itself must have failed or produced an error.
   - is_resolution: Does this indicate a successful fix, passing test, or resolved error?
   - waypoint_hint: If debug-related, what type? "error" (an actual error occurred), "attempt" (trying a fix), "failure" (fix didn't work), "success" (something passed), "pivot" (changing approach), "revert" (undoing a change), "discovery" (learned something new), "resolution" (final fix). null if not debug-related. WebSearch/WebFetch/AskUserQuestion are typically "discovery" or null, NOT "error".
   - confidence: 0.0-1.0 how confident this is debug activity

Return JSON: {"signal": "noise"|"signal", "classification": "discovery"|"problem"|"solution"|null, "reason": "brief", "debug_signal": {"is_error": bool, "is_resolution": bool, "waypoint_hint": "type"|null, "confidence": 0.0-1.0}|null}
If noise, classification must be null. debug_signal can be non-null even for noise (e.g., build failure output is noise but debug-relevant).
No markdown, no explanation, ONLY the JSON object.`;
/**
* Classifies an observation as noise/signal and determines its kind using Haiku.
*
* @param text - The observation content to classify
* @param source - Optional source context (e.g., "PostToolUse:Read", "UserMessage")
* @returns Classification result with signal/noise determination and observation kind
*/
async function classifyWithHaiku(text, source) {
	let userContent = text;
	if (source) userContent = `Source: ${source}\n\nObservation:\n${text}`;
	const parsed = extractJsonFromResponse(await callHaiku(SYSTEM_PROMPT$3, userContent, 512));
	return ClassificationSchema.parse(parsed);
}

//#endregion
//#region src/intelligence/haiku-entity-agent.ts
/**
* Entity extraction agent.
*
* Uses Haiku to extract typed entities from observation text.
* Replaces the regex-based extraction-rules.ts with LLM-powered analysis.
* Returns entities validated against the fixed 6-type taxonomy from graph/types.ts.
*/
const EntitySchema = z.object({
	name: z.string().min(1),
	type: z.enum(ENTITY_TYPES),
	confidence: z.number().min(0).max(1)
});
const EntityArraySchema = z.array(EntitySchema);
const SYSTEM_PROMPT$2 = `You extract structured entities from developer observations.

Entity types (use ONLY these exact strings):
- File: file paths (src/foo/bar.ts, package.json, ./config.yml)
- Project: repository names (org/repo), npm packages (@scope/pkg)
- Reference: URLs (https://...)
- Decision: explicit choices made ("decided to use X", "chose Y over Z")
- Problem: bugs, errors, failures, obstacles encountered
- Solution: fixes, resolutions, workarounds applied

Rules:
- Extract ALL entities present in the text
- For Decision/Problem/Solution, extract the descriptive phrase (not just the keyword)
- Confidence: 0.9+ for unambiguous (file paths, URLs), 0.7-0.8 for clear context, 0.5-0.6 for inferred
- Return a JSON array: [{"name": "...", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no entities found
- No markdown, no explanation, ONLY the JSON array`;
/**
* Extracts entities from observation text using Haiku.
*
* @param text - The observation content to analyze
* @returns Validated array of extracted entities with type and confidence
*/
async function extractEntitiesWithHaiku(text) {
	const parsed = extractJsonFromResponse(await callHaiku(SYSTEM_PROMPT$2, text, 512));
	return EntityArraySchema.parse(parsed);
}

//#endregion
//#region src/intelligence/haiku-relationship-agent.ts
/**
* Relationship inference agent.
*
* Uses Haiku to infer typed relationships between entities extracted from
* observation text. Replaces the regex-based relationship-detector.ts with
* LLM-powered contextual inference.
* Returns relationships validated against the fixed 8-type taxonomy from graph/types.ts.
*/
const RelationshipSchema = z.object({
	source: z.string(),
	target: z.string(),
	type: z.enum(RELATIONSHIP_TYPES),
	confidence: z.number().min(0).max(1)
});
const RelationshipArraySchema = z.array(RelationshipSchema);
const SYSTEM_PROMPT$1 = `You infer relationships between entities extracted from a developer observation.

Given observation text and a list of entities, determine which entities are related and how.

Relationship types (use ONLY these exact strings):
- modifies: entity A changed/edited/created entity B
- informed_by: entity A was researched/consulted using entity B
- verified_by: entity A was tested/confirmed by entity B
- caused_by: entity A was caused by entity B
- solved_by: entity A was resolved by entity B
- references: entity A references/links to entity B
- preceded_by: entity A came after entity B temporally
- related_to: generic relationship (use sparingly, prefer specific types)

Rules:
- Only infer relationships with clear textual evidence
- Source and target must both be in the provided entity list
- Confidence: 0.8+ for explicit language, 0.5-0.7 for implied
- Return JSON array: [{"source": "entity name", "target": "entity name", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no relationships found
- No markdown, no explanation, ONLY the JSON array`;
/**
* Infers relationships between entities using Haiku.
*
* @param text - The observation content providing context
* @param entities - Array of entities extracted from the same observation
* @returns Validated array of inferred relationships with type and confidence
*/
async function inferRelationshipsWithHaiku(text, entities) {
	const parsed = extractJsonFromResponse(await callHaiku(SYSTEM_PROMPT$1, `Observation:\n${text}\n\nEntities found:\n${JSON.stringify(entities.map((e) => ({
		name: e.name,
		type: e.type
	})))}`, 512));
	return RelationshipArraySchema.parse(parsed);
}

//#endregion
//#region src/graph/write-quality-gate.ts
const DEFAULT_MIN_NAME_LENGTH = 3;
const DEFAULT_MAX_NAME_LENGTH = 200;
const DEFAULT_MAX_FILES_PER_OBSERVATION = 5;
/**
* Vague name prefixes that indicate low-quality entity names.
* Case-insensitive match against the start of the entity name.
*/
const VAGUE_PREFIXES = [
	"the ",
	"this ",
	"that ",
	"it ",
	"some ",
	"a ",
	"an ",
	"here ",
	"there ",
	"now ",
	"just ",
	"ok ",
	"yes ",
	"no ",
	"maybe ",
	"done ",
	"tmp "
];
/**
* Per-type minimum confidence thresholds.
* High-signal types (Decision, Problem, Solution) have lower thresholds
* to capture more of the valuable knowledge. File has the highest
* threshold to reduce noise.
*/
const DEFAULT_TYPE_CONFIDENCE = {
	File: .95,
	Project: .8,
	Reference: .85,
	Decision: .65,
	Problem: .6,
	Solution: .6
};
/**
* Context-aware confidence multiplier for File paths from non-change
* observations. Reduces 0.95 -> ~0.70, below the 0.95 File threshold.
*/
const DEFAULT_FILE_NON_CHANGE_MULTIPLIER = .74;
/**
* Applies quality gate filters to a list of extracted entities.
*
* Steps:
*   1. Apply context-aware confidence adjustment (File paths in non-change obs)
*   2. Reject entities with names outside length bounds
*   3. Reject entities with vague/filler name prefixes
*   4. Apply per-type confidence thresholds
*   5. Cap File nodes to max per observation (keep highest confidence)
*
* @param entities - Extracted entities to filter
* @param isChangeObservation - Whether the source observation is a change/write
* @param config - Optional configuration overrides
* @returns Entities that passed the gate, plus rejected entities with reasons
*/
function applyQualityGate(entities, isChangeObservation, config) {
	const minNameLen = config?.qualityGate?.minNameLength ?? DEFAULT_MIN_NAME_LENGTH;
	const maxNameLen = config?.qualityGate?.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
	const maxFiles = config?.qualityGate?.maxFilesPerObservation ?? DEFAULT_MAX_FILES_PER_OBSERVATION;
	const typeConfidence = config?.qualityGate?.typeConfidenceThresholds ?? DEFAULT_TYPE_CONFIDENCE;
	const fileMultiplier = config?.qualityGate?.fileNonChangeMultiplier ?? DEFAULT_FILE_NON_CHANGE_MULTIPLIER;
	const passed = [];
	const rejected = [];
	for (const entity of entities) {
		let adjustedConfidence = entity.confidence;
		if (entity.type === "File" && !isChangeObservation) adjustedConfidence = entity.confidence * fileMultiplier;
		const adjusted = {
			...entity,
			confidence: adjustedConfidence
		};
		if (adjusted.name.length < minNameLen) {
			rejected.push({
				entity: adjusted,
				reason: `Name too short (${adjusted.name.length} < ${minNameLen})`
			});
			continue;
		}
		if (adjusted.name.length > maxNameLen) {
			rejected.push({
				entity: adjusted,
				reason: `Name too long (${adjusted.name.length} > ${maxNameLen})`
			});
			continue;
		}
		const lowerName = adjusted.name.toLowerCase();
		if (VAGUE_PREFIXES.some((prefix) => lowerName.startsWith(prefix))) {
			rejected.push({
				entity: adjusted,
				reason: `Vague name prefix: "${adjusted.name}"`
			});
			continue;
		}
		const threshold = typeConfidence[adjusted.type] ?? DEFAULT_TYPE_CONFIDENCE[adjusted.type] ?? .5;
		if (adjusted.confidence < threshold) {
			rejected.push({
				entity: adjusted,
				reason: `Below ${adjusted.type} confidence threshold (${adjusted.confidence.toFixed(2)} < ${threshold})`
			});
			continue;
		}
		passed.push(adjusted);
	}
	const fileEntities = passed.filter((e) => e.type === "File");
	if (fileEntities.length > maxFiles) {
		fileEntities.sort((a, b) => b.confidence - a.confidence);
		const toRemove = new Set(fileEntities.slice(maxFiles).map((e) => e.name));
		const finalPassed = [];
		for (const e of passed) if (e.type === "File" && toRemove.has(e.name)) rejected.push({
			entity: e,
			reason: `File cap exceeded (max ${maxFiles} per observation)`
		});
		else finalPassed.push(e);
		return {
			passed: finalPassed,
			rejected
		};
	}
	return {
		passed,
		rejected
	};
}

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
//#region src/intelligence/haiku-processor.ts
var HaikuProcessor = class {
	db;
	projectHash;
	intervalMs;
	batchSize;
	concurrency;
	pathTracker;
	branchTracker;
	timer = null;
	constructor(db, projectHash, opts) {
		this.db = db;
		this.projectHash = projectHash;
		this.intervalMs = opts?.intervalMs ?? 3e4;
		this.batchSize = opts?.batchSize ?? 10;
		this.concurrency = opts?.concurrency ?? 3;
		this.pathTracker = opts?.pathTracker ?? null;
		this.branchTracker = opts?.branchTracker ?? null;
	}
	start() {
		if (this.timer) return;
		debug("haiku", "HaikuProcessor started", {
			intervalMs: this.intervalMs,
			batchSize: this.batchSize,
			concurrency: this.concurrency
		});
		this.timer = setInterval(() => {
			this.processOnce().catch((err) => {
				debug("haiku", "HaikuProcessor cycle error", { error: err instanceof Error ? err.message : String(err) });
			});
		}, this.intervalMs);
	}
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			debug("haiku", "HaikuProcessor stopped");
		}
	}
	async processOnce() {
		if (!isHaikuEnabled()) return;
		const unclassified = ObservationRepository.listAllUnclassified(this.db, this.batchSize);
		if (unclassified.length === 0) return;
		debug("haiku", "Processing unclassified observations", { count: unclassified.length });
		const byProject = /* @__PURE__ */ new Map();
		for (const obs of unclassified) {
			const hash = obs.projectHash;
			if (!byProject.has(hash)) byProject.set(hash, []);
			byProject.get(hash).push(obs);
		}
		for (const [hash, projectObs] of byProject) {
			const repo = new ObservationRepository(this.db, hash);
			for (let i = 0; i < projectObs.length; i += this.concurrency) {
				const batch = projectObs.slice(i, i + this.concurrency);
				await Promise.all(batch.map((obs) => this.processOne(obs, repo, hash)));
			}
		}
		if (this.branchTracker) try {
			await this.branchTracker.runMaintenance();
		} catch (err) {
			debug("haiku", "Branch maintenance error (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
		}
	}
	async processOne(obs, repo, obsProjectHash) {
		const projectHash = obsProjectHash ?? this.projectHash;
		try {
			let classification;
			try {
				const result = await classifyWithHaiku(obs.content, obs.source);
				if (this.pathTracker && result.debug_signal) try {
					this.pathTracker.processSignal(result.debug_signal, obs.id, obs.content);
				} catch (pathErr) {
					const msg = pathErr instanceof Error ? pathErr.message : String(pathErr);
					debug("haiku", "Path tracking failed (non-fatal)", {
						id: obs.id,
						error: msg
					});
				}
				if (this.branchTracker) try {
					this.branchTracker.processObservation({
						id: obs.id,
						content: obs.content,
						source: obs.source,
						projectHash: obsProjectHash ?? this.projectHash,
						sessionId: void 0,
						classification: result.classification,
						createdAt: (/* @__PURE__ */ new Date()).toISOString()
					});
				} catch (branchErr) {
					const msg = branchErr instanceof Error ? branchErr.message : String(branchErr);
					debug("haiku", "Branch tracking failed (non-fatal)", {
						id: obs.id,
						error: msg
					});
				}
				if (result.signal === "noise") {
					repo.updateClassification(obs.id, "noise");
					repo.softDelete(obs.id);
					debug("haiku", "Observation classified as noise, soft-deleted", { id: obs.id });
					return;
				}
				classification = result.classification ?? "discovery";
				repo.updateClassification(obs.id, classification);
				debug("haiku", "Observation classified", {
					id: obs.id,
					classification
				});
			} catch (classifyErr) {
				const msg = classifyErr instanceof Error ? classifyErr.message : String(classifyErr);
				debug("haiku", "Classification failed, will retry next cycle", {
					id: obs.id,
					error: msg
				});
				return;
			}
			let entities = [];
			try {
				entities = await extractEntitiesWithHaiku(obs.content);
			} catch (entityErr) {
				const msg = entityErr instanceof Error ? entityErr.message : String(entityErr);
				debug("haiku", "Entity extraction failed (non-fatal)", {
					id: obs.id,
					error: msg
				});
				return;
			}
			if (entities.length === 0) return;
			const isChange = obs.source === "hook:Write" || obs.source === "hook:Edit";
			const gateResult = applyQualityGate(entities, isChange);
			const persistedNodes = [];
			for (const entity of gateResult.passed) try {
				const node = upsertNode(this.db, {
					type: entity.type,
					name: entity.name,
					metadata: { confidence: entity.confidence },
					observation_ids: [String(obs.id)],
					project_hash: projectHash
				});
				persistedNodes.push(node);
			} catch {
				continue;
			}
			if (persistedNodes.length > 0) {
				for (const node of persistedNodes) broadcast("entity_updated", {
					id: node.name,
					label: node.name,
					type: node.type,
					observationCount: 1,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					projectHash
				});
				debug("haiku", "Entities persisted", {
					id: obs.id,
					count: persistedNodes.length
				});
			}
			if (persistedNodes.length >= 2) try {
				const entityPairs = persistedNodes.map((n) => ({
					name: n.name,
					type: n.type
				}));
				const relationships = await inferRelationshipsWithHaiku(obs.content, entityPairs);
				const affectedNodeIds = /* @__PURE__ */ new Set();
				for (const rel of relationships) {
					const sourceNode = getNodeByNameAndType(this.db, rel.source, entityPairs.find((e) => e.name === rel.source)?.type ?? "File");
					const targetNode = getNodeByNameAndType(this.db, rel.target, entityPairs.find((e) => e.name === rel.target)?.type ?? "File");
					if (!sourceNode || !targetNode) continue;
					try {
						insertEdge(this.db, {
							source_id: sourceNode.id,
							target_id: targetNode.id,
							type: rel.type,
							weight: rel.confidence,
							metadata: { source: "haiku" },
							project_hash: projectHash
						});
						affectedNodeIds.add(sourceNode.id);
						affectedNodeIds.add(targetNode.id);
					} catch {}
				}
				for (const nodeId of affectedNodeIds) enforceMaxDegree(this.db, nodeId);
				debug("haiku", "Relationships persisted", {
					id: obs.id,
					count: relationships.length
				});
			} catch (relErr) {
				const msg = relErr instanceof Error ? relErr.message : String(relErr);
				debug("haiku", "Relationship inference failed (non-fatal)", {
					id: obs.id,
					error: msg
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			debug("haiku", "processOne failed (non-fatal)", {
				id: obs.id,
				error: msg
			});
		}
	}
};

//#endregion
//#region src/paths/kiss-summary-agent.ts
/**
* KISS summary agent — generates actionable "next time, just do X" summaries.
*
* When a debug path resolves, this agent analyzes the waypoints (errors,
* attempts, failures, resolution) and produces a multi-layer summary:
*   - kiss_summary: The one-liner takeaway
*   - root_cause: What actually caused the issue
*   - what_fixed_it: The specific fix that resolved it
*   - dimensions: logical, programmatic, development perspectives
*
* Uses the shared Haiku client (callHaiku + extractJsonFromResponse) following
* the same pattern as haiku-classifier-agent.ts.
*/
const KissSummarySchema = z.object({
	kiss_summary: z.string(),
	root_cause: z.string(),
	what_fixed_it: z.string(),
	dimensions: z.object({
		logical: z.string(),
		programmatic: z.string(),
		development: z.string()
	})
});
const SYSTEM_PROMPT = `You analyze completed debug resolution paths and produce actionable summaries.

Given a debug path with its trigger, waypoints (errors, attempts, failures, resolution), and resolution summary, generate:

1. kiss_summary: A "Next time, just do X" one-liner. This is the actionable takeaway a developer should remember.
2. root_cause: What actually caused the issue (1-2 sentences max).
3. what_fixed_it: The specific fix or change that resolved it (1-2 sentences max).
4. dimensions:
   - logical: What mental model was wrong? What assumption led the developer astray? (1-2 sentences)
   - programmatic: What code-level change fixed it? Be specific about files, functions, or patterns. (1-2 sentences)
   - development: What workflow improvement would catch this faster next time? (1-2 sentences)

Keep every field concise. Developers will scan these quickly.
Return ONLY JSON, no markdown, no explanation.`;
const KEY_WAYPOINT_TYPES = new Set([
	"error",
	"failure",
	"success",
	"resolution",
	"discovery"
]);
/**
* Generates a KISS summary for a resolved debug path.
*
* Pre-filters waypoints to key types (error, failure, success, resolution,
* discovery) and caps at 10 to keep the prompt small. Returns a structured
* KissSummary with multi-layer dimensions.
*
* @param triggerSummary - What started the debug path
* @param waypoints - All waypoints from the path
* @param resolutionSummary - How the path was resolved
* @returns Structured KISS summary with dimensions
*/
async function generateKissSummary(triggerSummary, waypoints, resolutionSummary) {
	const parsed = extractJsonFromResponse(await callHaiku(SYSTEM_PROMPT, `Trigger: ${triggerSummary}

Waypoints:
${waypoints.filter((w) => KEY_WAYPOINT_TYPES.has(w.waypoint_type)).slice(0, 10).map((w) => `- [${w.waypoint_type}] ${w.summary}`).join("\n")}

Resolution: ${resolutionSummary}`));
	return KissSummarySchema.parse(parsed);
}

//#endregion
//#region src/paths/path-tracker.ts
var PathTracker = class {
	state = "idle";
	errorBuffer = [];
	consecutiveSuccesses = 0;
	currentPathId = null;
	errorThreshold;
	windowMs;
	resolutionThreshold;
	maxWaypoints;
	constructor(repo, opts) {
		this.repo = repo;
		this.errorThreshold = opts?.errorThreshold ?? 3;
		this.windowMs = opts?.windowMs ?? 300 * 1e3;
		this.resolutionThreshold = opts?.resolutionThreshold ?? 3;
		this.maxWaypoints = opts?.maxWaypoints ?? 30;
		const activePath = this.repo.getActivePath();
		if (activePath) {
			this.state = "active_debug";
			this.currentPathId = activePath.id;
			debug("paths", "Recovered active path from SQLite", { pathId: activePath.id });
		}
	}
	/**
	* Process a debug signal from the Haiku classifier.
	*
	* Called for every classified observation (both noise and signal).
	* Drives state transitions and persists waypoints when in active_debug.
	*/
	processSignal(signal, observationId, observationContent) {
		if (signal.confidence < .3) return;
		const summary = observationContent.substring(0, 200).trim();
		switch (this.state) {
			case "idle":
				this.handleIdle(signal, summary);
				break;
			case "potential_debug":
				this.handlePotentialDebug(signal, summary, observationId);
				break;
			case "active_debug":
				this.handleActiveDebug(signal, summary, observationId);
				break;
			case "resolved":
				this.state = "idle";
				debug("paths", "Transitioned resolved -> idle");
				this.handleIdle(signal, summary);
				break;
		}
	}
	handleIdle(signal, summary) {
		if (signal.is_error && signal.confidence >= .5) {
			this.errorBuffer.push({
				timestamp: Date.now(),
				summary
			});
			this.state = "potential_debug";
			debug("paths", "Transitioned idle -> potential_debug", { bufferSize: this.errorBuffer.length });
		}
	}
	handlePotentialDebug(signal, summary, observationId) {
		if (signal.is_error && signal.confidence >= .5) this.errorBuffer.push({
			timestamp: Date.now(),
			summary
		});
		const cutoff = Date.now() - this.windowMs;
		this.errorBuffer = this.errorBuffer.filter((e) => e.timestamp >= cutoff);
		if (this.errorBuffer.length === 0) {
			this.state = "idle";
			debug("paths", "Error buffer expired, potential_debug -> idle");
			return;
		}
		if (this.errorBuffer.length >= this.errorThreshold) {
			const triggerSummary = this.errorBuffer[0].summary;
			const path = this.repo.createPath(triggerSummary);
			this.currentPathId = path.id;
			this.state = "active_debug";
			this.consecutiveSuccesses = 0;
			debug("paths", "Debug path confirmed, potential_debug -> active_debug", {
				pathId: path.id,
				errorCount: this.errorBuffer.length
			});
			for (const entry of this.errorBuffer) this.repo.addWaypoint(path.id, "error", entry.summary, observationId);
			this.errorBuffer = [];
		}
	}
	handleActiveDebug(signal, summary, observationId) {
		if (!this.currentPathId) return;
		if (this.repo.countWaypoints(this.currentPathId) >= this.maxWaypoints) {
			debug("paths", "Waypoint cap reached, skipping", {
				pathId: this.currentPathId,
				cap: this.maxWaypoints
			});
			this.updateResolutionCounter(signal, summary, observationId);
			return;
		}
		let waypointType;
		if (signal.waypoint_hint) waypointType = signal.waypoint_hint;
		else if (signal.is_error) waypointType = "error";
		else if (signal.is_resolution) waypointType = "success";
		else waypointType = "attempt";
		this.repo.addWaypoint(this.currentPathId, waypointType, summary, observationId);
		debug("paths", "Waypoint added", {
			pathId: this.currentPathId,
			type: waypointType,
			observationId
		});
		this.updateResolutionCounter(signal, summary, observationId);
	}
	updateResolutionCounter(signal, summary, observationId) {
		if (!this.currentPathId) return;
		if (signal.is_resolution) {
			this.consecutiveSuccesses++;
			if (this.consecutiveSuccesses >= this.resolutionThreshold) {
				if (this.repo.countWaypoints(this.currentPathId) < this.maxWaypoints) this.repo.addWaypoint(this.currentPathId, "resolution", summary, observationId);
				this.repo.resolvePath(this.currentPathId, summary);
				debug("paths", "Path auto-resolved", {
					pathId: this.currentPathId,
					consecutiveSuccesses: this.consecutiveSuccesses
				});
				const savedPathId = this.currentPathId;
				const savedResolutionSummary = summary;
				this.generateAndStoreKiss(savedPathId, savedResolutionSummary).catch((err) => {
					debug("paths", "KISS generation failed (fire-and-forget)", { error: String(err) });
				});
				this.state = "idle";
				this.currentPathId = null;
				this.consecutiveSuccesses = 0;
				this.errorBuffer = [];
			}
		} else if (signal.is_error) this.consecutiveSuccesses = 0;
	}
	/**
	* Generates and stores a KISS summary for a resolved path.
	* Non-fatal — failures are logged but do not affect path resolution.
	*/
	async generateAndStoreKiss(pathId, resolutionSummary) {
		try {
			const path = this.repo.getPath(pathId);
			if (!path) return;
			const waypoints = this.repo.getWaypoints(pathId);
			const kiss = await generateKissSummary(path.trigger_summary, waypoints, resolutionSummary);
			this.repo.updateKissSummary(pathId, JSON.stringify(kiss));
			debug("paths", "KISS summary stored", { pathId });
		} catch (err) {
			debug("paths", "KISS generation failed", {
				pathId,
				error: String(err)
			});
		}
	}
	/**
	* Manually starts a debug path. Used by MCP tools.
	* If already tracking, returns the existing path ID.
	*/
	startManually(triggerSummary) {
		if (this.state === "active_debug" && this.currentPathId) return this.currentPathId;
		const path = this.repo.createPath(triggerSummary);
		this.state = "active_debug";
		this.currentPathId = path.id;
		this.consecutiveSuccesses = 0;
		this.errorBuffer = [];
		debug("paths", "Path started manually", { pathId: path.id });
		return path.id;
	}
	/**
	* Manually resolves the active debug path. Used by MCP tools.
	* Adds a resolution waypoint, resolves the path, and fires KISS generation.
	*/
	resolveManually(resolutionSummary) {
		if (!this.currentPathId || this.state !== "active_debug") return;
		this.repo.addWaypoint(this.currentPathId, "resolution", resolutionSummary);
		this.repo.resolvePath(this.currentPathId, resolutionSummary);
		const savedPathId = this.currentPathId;
		this.generateAndStoreKiss(savedPathId, resolutionSummary).catch((err) => {
			debug("paths", "KISS generation failed (fire-and-forget)", { error: String(err) });
		});
		this.state = "idle";
		this.currentPathId = null;
		this.consecutiveSuccesses = 0;
		this.errorBuffer = [];
		debug("paths", "Path resolved manually", { pathId: savedPathId });
	}
	/**
	* Returns the active path ID, or null if no path is being tracked.
	*/
	getActivePathId() {
		return this.currentPathId;
	}
};

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
function getDb$1(c) {
	return c.get("db");
}
function getProjectHash$2(c) {
	return c.req.query("project") || c.get("defaultProject") || null;
}
const apiRoutes = new Hono();
/**
* GET /api/projects
*
* Returns list of known projects from project_metadata table.
*/
apiRoutes.get("/projects", (c) => {
	const db = getDb$1(c);
	const defaultProject = c.get("defaultProject") || null;
	let projects = [];
	try {
		projects = db.prepare("SELECT project_hash, project_path, display_name, last_seen_at FROM project_metadata ORDER BY last_seen_at DESC").all();
	} catch {}
	const resolvedDefault = (projects.length > 0 ? projects[0].project_hash : null) || defaultProject;
	return c.json({
		projects: projects.map((p) => ({
			hash: p.project_hash,
			path: p.project_path,
			displayName: p.display_name || p.project_path.split("/").pop() || p.project_hash.substring(0, 8),
			lastSeenAt: p.last_seen_at
		})),
		defaultProject: resolvedDefault
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
	const db = getDb$1(c);
	const typeFilter = c.req.query("type");
	const sinceFilter = c.req.query("since");
	const untilFilter = c.req.query("until");
	const projectFilter = getProjectHash$2(c);
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
	const db = getDb$1(c);
	const from = c.req.query("from");
	const to = c.req.query("to");
	const limitStr = c.req.query("limit");
	const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 500, 2e3) : 500;
	const offsetStr = c.req.query("offset");
	const offset = offsetStr ? Math.max(parseInt(offsetStr, 10) || 0, 0) : 0;
	const projectFilter = getProjectHash$2(c);
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
	const db = getDb$1(c);
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
/**
* GET /api/node/:id/neighborhood
*
* Returns the N-hop subgraph around a node. Powers the focus/drill-down view.
* Query params:
*   ?depth=1  - hop count (1 or 2, default 1)
*/
apiRoutes.get("/node/:id/neighborhood", (c) => {
	const db = getDb$1(c);
	const centerId = c.req.param("id");
	const depthParam = c.req.query("depth");
	const depth = Math.min(Math.max(parseInt(depthParam || "1", 10) || 1, 1), 2);
	let centerRow;
	try {
		centerRow = db.prepare("SELECT id, name, type, observation_ids, created_at FROM graph_nodes WHERE id = ?").get(centerId);
	} catch {}
	if (!centerRow) return c.json({ error: "Node not found" }, 404);
	const visitedNodeIds = new Set([centerId]);
	let frontier = new Set([centerId]);
	const allEdgeRows = [];
	const seenEdgeIds = /* @__PURE__ */ new Set();
	for (let d = 0; d < depth; d++) {
		if (frontier.size === 0) break;
		const frontierIds = Array.from(frontier);
		const placeholders = frontierIds.map(() => "?").join(", ");
		const nextFrontier = /* @__PURE__ */ new Set();
		try {
			const edgeRows = db.prepare(`SELECT id, source_id, target_id, type, weight FROM graph_edges
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).all(...frontierIds, ...frontierIds);
			for (const edge of edgeRows) {
				if (!seenEdgeIds.has(edge.id)) {
					seenEdgeIds.add(edge.id);
					allEdgeRows.push(edge);
				}
				if (!visitedNodeIds.has(edge.source_id)) {
					visitedNodeIds.add(edge.source_id);
					nextFrontier.add(edge.source_id);
				}
				if (!visitedNodeIds.has(edge.target_id)) {
					visitedNodeIds.add(edge.target_id);
					nextFrontier.add(edge.target_id);
				}
			}
		} catch {}
		frontier = nextFrontier;
	}
	const nodeIds = Array.from(visitedNodeIds);
	let nodeRows = [];
	if (nodeIds.length > 0) try {
		const placeholders = nodeIds.map(() => "?").join(", ");
		nodeRows = db.prepare(`SELECT id, name, type, observation_ids, created_at FROM graph_nodes WHERE id IN (${placeholders})`).all(...nodeIds);
	} catch {}
	const nodes = nodeRows.map((row) => ({
		id: row.id,
		label: row.name,
		type: row.type,
		observationCount: safeParseJsonArray(row.observation_ids).length,
		createdAt: row.created_at
	}));
	const nodeIdSet = new Set(nodeIds);
	const edges = allEdgeRows.filter((e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id)).map((row) => ({
		id: row.id,
		source: row.source_id,
		target: row.target_id,
		type: row.type
	}));
	return c.json({
		center: centerId,
		nodes,
		edges
	});
});
/**
* GET /api/graph/search
*
* Two-tier search: name-based LIKE matching on graph_nodes, then FTS fallback
* on observations_fts for richer content matching.
* Query params:
*   ?q=       - search query (required)
*   ?type=    - entity type filter
*   ?limit=20 - max results
*   ?project= - project hash filter
*/
apiRoutes.get("/graph/search", (c) => {
	const db = getDb$1(c);
	const query = (c.req.query("q") || "").trim();
	const typeFilter = c.req.query("type") || null;
	const limitStr = c.req.query("limit");
	const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 20, 50) : 20;
	const projectFilter = getProjectHash$2(c);
	if (!query) return c.json({ results: [] });
	const results = [];
	const seenIds = /* @__PURE__ */ new Set();
	try {
		let nameSql = `SELECT id, name, type, observation_ids FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE`;
		const nameParams = [`%${query}%`];
		if (projectFilter) {
			nameSql += " AND project_hash = ?";
			nameParams.push(projectFilter);
		}
		if (typeFilter) {
			nameSql += " AND type = ?";
			nameParams.push(typeFilter);
		}
		nameSql += " LIMIT 100";
		const rows = db.prepare(nameSql).all(...nameParams);
		const lowerQuery = query.toLowerCase();
		const ranked = rows.map((row) => {
			const lowerName = row.name.toLowerCase();
			let rank;
			if (lowerName === lowerQuery) rank = "exact";
			else if (lowerName.startsWith(lowerQuery)) rank = "prefix";
			else rank = "contains";
			return {
				row,
				rank
			};
		});
		const rankOrder = {
			exact: 0,
			prefix: 1,
			contains: 2
		};
		ranked.sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank]);
		for (const { row, rank } of ranked) {
			if (results.length >= limit) break;
			seenIds.add(row.id);
			results.push({
				id: row.id,
				label: row.name,
				type: row.type,
				observationCount: safeParseJsonArray(row.observation_ids).length,
				matchSource: rank,
				snippet: null
			});
		}
	} catch {}
	if (results.length < limit) try {
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").get()) {
			let ftsSql = `
          SELECT o.id AS obs_id, o.content, o.title,
                 gn.id AS node_id, gn.name, gn.type, gn.observation_ids
          FROM observations_fts fts
          JOIN observations o ON o.id = fts.rowid
          JOIN graph_nodes gn ON EXISTS (
            SELECT 1 FROM json_each(gn.observation_ids) je WHERE je.value = o.id
          )
          WHERE observations_fts MATCH ?
            AND o.deleted_at IS NULL`;
			const ftsParams = [query + "*"];
			if (projectFilter) {
				ftsSql += " AND gn.project_hash = ?";
				ftsParams.push(projectFilter);
			}
			if (typeFilter) {
				ftsSql += " AND gn.type = ?";
				ftsParams.push(typeFilter);
			}
			ftsSql += " LIMIT 50";
			const ftsRows = db.prepare(ftsSql).all(...ftsParams);
			for (const row of ftsRows) {
				if (results.length >= limit) break;
				if (seenIds.has(row.node_id)) continue;
				seenIds.add(row.node_id);
				const text = row.title ? `${row.title}: ${row.content}` : row.content;
				const snippet = text.length > 120 ? text.substring(0, 120) + "..." : text;
				results.push({
					id: row.node_id,
					label: row.name,
					type: row.type,
					observationCount: safeParseJsonArray(row.observation_ids).length,
					matchSource: "fts",
					snippet
				});
			}
		}
	} catch {}
	return c.json({ results });
});
/**
* GET /api/graph/analysis
*
* Returns graph analysis insights: type distributions, top entities by degree,
* connected components, and recent activity stats.
* 30-second in-memory cache to avoid recomputation.
*/
let analysisCache = null;
apiRoutes.get("/graph/analysis", (c) => {
	const db = getDb$1(c);
	const projectFilter = getProjectHash$2(c);
	const cacheKey = `analysis:${projectFilter || "all"}`;
	const now = Date.now();
	if (analysisCache && analysisCache.key === cacheKey && analysisCache.expiry > now) return c.json(analysisCache.data);
	let entityTypes = [];
	try {
		let sql = "SELECT type, COUNT(*) as count FROM graph_nodes";
		const params = [];
		if (projectFilter) {
			sql += " WHERE project_hash = ?";
			params.push(projectFilter);
		}
		sql += " GROUP BY type ORDER BY count DESC";
		entityTypes = db.prepare(sql).all(...params);
	} catch {}
	let relationshipTypes = [];
	try {
		let sql = "SELECT type, COUNT(*) as count FROM graph_edges";
		const params = [];
		if (projectFilter) {
			sql += " WHERE project_hash = ?";
			params.push(projectFilter);
		}
		sql += " GROUP BY type ORDER BY count DESC";
		relationshipTypes = db.prepare(sql).all(...params);
	} catch {}
	let topEntities = [];
	try {
		let sql = `
      SELECT gn.id, gn.name AS label, gn.type,
        (SELECT COUNT(*) FROM graph_edges e WHERE e.source_id = gn.id${projectFilter ? " AND e.project_hash = ?" : ""})
        + (SELECT COUNT(*) FROM graph_edges e WHERE e.target_id = gn.id${projectFilter ? " AND e.project_hash = ?" : ""})
        AS degree
      FROM graph_nodes gn`;
		const params = [];
		if (projectFilter) {
			sql += " WHERE gn.project_hash = ?";
			params.push(projectFilter);
			params.unshift(projectFilter, projectFilter);
		}
		sql += " ORDER BY degree DESC LIMIT 10";
		topEntities = db.prepare(sql).all(...params);
	} catch {}
	let components = [];
	try {
		components = findConnectedComponents(db, projectFilter).components.map((comp, i) => ({
			id: i,
			label: comp.label,
			nodeIds: comp.nodeIds,
			nodeCount: comp.nodeIds.length,
			edgeCount: comp.edgeCount
		}));
	} catch {}
	let recentActivity = {
		lastDay: 0,
		lastWeek: 0
	};
	try {
		const dayAgo = (/* @__PURE__ */ new Date(Date.now() - 1440 * 60 * 1e3)).toISOString();
		const weekAgo = (/* @__PURE__ */ new Date(Date.now() - 10080 * 60 * 1e3)).toISOString();
		let daySql = "SELECT COUNT(*) as count FROM graph_nodes WHERE created_at >= ?";
		let weekSql = "SELECT COUNT(*) as count FROM graph_nodes WHERE created_at >= ?";
		const dayParams = [dayAgo];
		const weekParams = [weekAgo];
		if (projectFilter) {
			daySql += " AND project_hash = ?";
			weekSql += " AND project_hash = ?";
			dayParams.push(projectFilter);
			weekParams.push(projectFilter);
		}
		const dayRow = db.prepare(daySql).get(...dayParams);
		const weekRow = db.prepare(weekSql).get(...weekParams);
		recentActivity = {
			lastDay: dayRow?.count ?? 0,
			lastWeek: weekRow?.count ?? 0
		};
	} catch {}
	const result = {
		entityTypes,
		relationshipTypes,
		topEntities,
		components,
		recentActivity
	};
	analysisCache = {
		key: cacheKey,
		data: result,
		expiry: now + 3e4
	};
	return c.json(result);
});
/**
* GET /api/graph/communities
*
* Returns community assignments with colors from a 10-color palette.
* Builds on the same BFS component detection as analysis.
*/
apiRoutes.get("/graph/communities", (c) => {
	const db = getDb$1(c);
	const projectFilter = getProjectHash$2(c);
	const COMMUNITY_COLORS = [
		"#58a6ff",
		"#3fb950",
		"#d2a8ff",
		"#f0883e",
		"#f85149",
		"#79c0ff",
		"#d29922",
		"#7ee787",
		"#f778ba",
		"#a5d6ff"
	];
	const communities = [];
	let isolatedNodes = [];
	try {
		const bfs = findConnectedComponents(db, projectFilter);
		isolatedNodes = bfs.isolatedNodes;
		for (let i = 0; i < bfs.components.length; i++) {
			const comp = bfs.components[i];
			communities.push({
				id: i,
				label: comp.label,
				color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
				nodeIds: comp.nodeIds
			});
		}
	} catch {}
	return c.json({
		communities,
		isolatedNodes
	});
});
/**
* GET /api/paths
*
* Returns a list of recent debug paths for the current project.
* Query params:
*   ?limit=20  - max results (default 20, max 50)
*/
apiRoutes.get("/paths", (c) => {
	const db = getDb$1(c);
	const projectHash = getProjectHash$2(c);
	if (!projectHash) return c.json({ paths: [] });
	const limitStr = c.req.query("limit");
	const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 50) : 20;
	try {
		const paths = new PathRepository(db, projectHash).listPaths(limit);
		return c.json({ paths });
	} catch (err) {
		console.error("[laminark] Failed to list paths:", err);
		return c.json({ paths: [] });
	}
});
/**
* GET /api/paths/active
*
* Returns the currently active debug path for the current project.
*/
apiRoutes.get("/paths/active", (c) => {
	const db = getDb$1(c);
	const projectHash = getProjectHash$2(c);
	if (!projectHash) return c.json({ path: null });
	try {
		const path = new PathRepository(db, projectHash).getActivePath();
		return c.json({ path });
	} catch (err) {
		console.error("[laminark] Failed to get active path:", err);
		return c.json({ path: null });
	}
});
/**
* GET /api/paths/:id
*
* Returns a single debug path with its waypoints.
*/
apiRoutes.get("/paths/:id", (c) => {
	const db = getDb$1(c);
	const projectHash = getProjectHash$2(c);
	const pathId = c.req.param("id");
	if (!projectHash) return c.json({ error: "Path not found" }, 404);
	try {
		const repo = new PathRepository(db, projectHash);
		const path = repo.getPath(pathId);
		if (!path) return c.json({ error: "Path not found" }, 404);
		const waypoints = repo.getWaypoints(pathId);
		let kissSummary = null;
		if (path.kiss_summary) try {
			kissSummary = JSON.parse(path.kiss_summary);
		} catch {
			kissSummary = path.kiss_summary;
		}
		return c.json({
			path: {
				...path,
				kiss_summary: kissSummary
			},
			waypoints
		});
	} catch (err) {
		console.error("[laminark] Failed to get path:", err);
		return c.json({ error: "Path not found" }, 404);
	}
});
/**
* GET /api/tools
*
* Returns all tools from tool_registry with usage stats.
*/
apiRoutes.get("/tools", (c) => {
	const db = getDb$1(c);
	let tools = [];
	try {
		tools = db.prepare(`
      SELECT id, name, tool_type, scope, status, usage_count, server_name, description, last_used_at, discovered_at
      FROM tool_registry
      ORDER BY usage_count DESC, discovered_at DESC
    `).all();
	} catch {}
	return c.json({ tools: tools.map((t) => ({
		id: t.id,
		name: t.name,
		toolType: t.tool_type,
		scope: t.scope,
		status: t.status,
		usageCount: t.usage_count,
		serverName: t.server_name,
		description: t.description,
		lastUsedAt: t.last_used_at,
		discoveredAt: t.discovered_at
	})) });
});
/**
* GET /api/tools/flows
*
* Returns edges for the tool topology graph:
* 1. Pre-computed routing_patterns (preceding_tools -> target_tool)
* 2. Pairwise co-occurrence from tool_usage_events session sequences
*/
apiRoutes.get("/tools/flows", (c) => {
	const db = getDb$1(c);
	const projectFilter = getProjectHash$2(c);
	const edges = [];
	const edgeKey = /* @__PURE__ */ new Set();
	try {
		let sql = "SELECT target_tool, preceding_tools, frequency FROM routing_patterns";
		const params = [];
		if (projectFilter) {
			sql += " WHERE project_hash = ?";
			params.push(projectFilter);
		}
		sql += " ORDER BY frequency DESC LIMIT 200";
		const rows = db.prepare(sql).all(...params);
		for (const row of rows) {
			let preceding;
			try {
				preceding = JSON.parse(row.preceding_tools);
			} catch {
				preceding = [];
			}
			for (const src of preceding) {
				const key = src + "->" + row.target_tool;
				if (!edgeKey.has(key)) {
					edgeKey.add(key);
					edges.push({
						source: src,
						target: row.target_tool,
						frequency: row.frequency,
						edgeType: "pattern"
					});
				}
			}
		}
	} catch {}
	try {
		let sql = `
      SELECT session_id, tool_name, created_at
      FROM tool_usage_events
      WHERE session_id IS NOT NULL
    `;
		const params = [];
		if (projectFilter) {
			sql += " AND project_hash = ?";
			params.push(projectFilter);
		}
		sql += " ORDER BY session_id, created_at ASC LIMIT 5000";
		const rows = db.prepare(sql).all(...params);
		const pairFreq = /* @__PURE__ */ new Map();
		let prevSession = "";
		let prevTool = "";
		for (const row of rows) {
			if (row.session_id === prevSession && prevTool && prevTool !== row.tool_name) {
				const key = prevTool + "->" + row.tool_name;
				pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
			}
			prevSession = row.session_id;
			prevTool = row.tool_name;
		}
		for (const [key, freq] of pairFreq) if (!edgeKey.has(key) && freq >= 2) {
			edgeKey.add(key);
			const [source, target] = key.split("->");
			edges.push({
				source,
				target,
				frequency: freq,
				edgeType: "session"
			});
		}
	} catch {}
	return c.json({ edges });
});
/**
* GET /api/tools/:name/stats
*
* Returns detailed stats for a single tool.
*/
apiRoutes.get("/tools/:name/stats", (c) => {
	const db = getDb$1(c);
	const toolName = c.req.param("name");
	const projectFilter = getProjectHash$2(c);
	let tool;
	try {
		tool = db.prepare("SELECT id, name, tool_type, scope, status, usage_count, server_name, description, last_used_at, discovered_at FROM tool_registry WHERE name = ? ORDER BY usage_count DESC LIMIT 1").get(toolName);
	} catch {}
	if (!tool) return c.json({ error: "Tool not found" }, 404);
	let successRate = null;
	let totalEvents = 0;
	try {
		let sql = "SELECT success FROM tool_usage_events WHERE tool_name = ?";
		const params = [toolName];
		if (projectFilter) {
			sql += " AND project_hash = ?";
			params.push(projectFilter);
		}
		sql += " ORDER BY created_at DESC LIMIT 50";
		const events = db.prepare(sql).all(...params);
		totalEvents = events.length;
		if (totalEvents > 0) successRate = events.filter((e) => e.success === 1).length / totalEvents;
	} catch {}
	let sessionsUsedIn = 0;
	try {
		let sql = "SELECT COUNT(DISTINCT session_id) as cnt FROM tool_usage_events WHERE tool_name = ? AND session_id IS NOT NULL";
		const params = [toolName];
		if (projectFilter) {
			sql += " AND project_hash = ?";
			params.push(projectFilter);
		}
		sessionsUsedIn = db.prepare(sql).get(...params)?.cnt ?? 0;
	} catch {}
	let coOccurring = [];
	try {
		let sql = `
      SELECT e2.tool_name as name, COUNT(*) as count
      FROM tool_usage_events e1
      JOIN tool_usage_events e2
        ON e1.session_id = e2.session_id AND e1.tool_name != e2.tool_name
      WHERE e1.tool_name = ? AND e1.session_id IS NOT NULL
    `;
		const params = [toolName];
		if (projectFilter) {
			sql += " AND e1.project_hash = ?";
			params.push(projectFilter);
		}
		sql += " GROUP BY e2.tool_name ORDER BY count DESC LIMIT 10";
		coOccurring = db.prepare(sql).all(...params);
	} catch {}
	return c.json({
		tool: {
			id: tool.id,
			name: tool.name,
			toolType: tool.tool_type,
			scope: tool.scope,
			status: tool.status,
			usageCount: tool.usage_count,
			serverName: tool.server_name,
			description: tool.description,
			lastUsedAt: tool.last_used_at,
			discoveredAt: tool.discovered_at
		},
		successRate,
		totalEvents,
		sessionsUsedIn,
		coOccurring
	});
});
/**
* GET /api/tools/sessions
*
* Returns recent session tool sequences for the flow strip.
*/
apiRoutes.get("/tools/sessions", (c) => {
	const db = getDb$1(c);
	const projectFilter = getProjectHash$2(c);
	const limitStr = c.req.query("limit");
	const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 10, 30) : 10;
	let sessions = [];
	try {
		let sessionSql = `
      SELECT DISTINCT session_id FROM tool_usage_events
      WHERE session_id IS NOT NULL
    `;
		const sessionParams = [];
		if (projectFilter) {
			sessionSql += " AND project_hash = ?";
			sessionParams.push(projectFilter);
		}
		sessionSql += " ORDER BY created_at DESC LIMIT ?";
		sessionParams.push(limit);
		const sessionIds = db.prepare(sessionSql).all(...sessionParams);
		if (sessionIds.length > 0) {
			const placeholders = sessionIds.map(() => "?").join(", ");
			const ids = sessionIds.map((s) => s.session_id);
			const eventRows = db.prepare(`
        SELECT session_id, tool_name, created_at
        FROM tool_usage_events
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, created_at ASC
      `).all(...ids);
			const sessionMap = /* @__PURE__ */ new Map();
			for (const row of eventRows) {
				if (!sessionMap.has(row.session_id)) sessionMap.set(row.session_id, []);
				sessionMap.get(row.session_id).push({
					name: row.tool_name,
					time: row.created_at
				});
			}
			sessions = sessionIds.filter((s) => sessionMap.has(s.session_id)).map((s) => ({
				sessionId: s.session_id,
				tools: sessionMap.get(s.session_id)
			}));
		}
	} catch {}
	return c.json({ sessions });
});
/**
* Finds connected components in the graph via BFS.
* Shared by /api/graph/analysis and /api/graph/communities.
*/
function findConnectedComponents(db, projectFilter) {
	let nodesSql = "SELECT id, name FROM graph_nodes";
	const nodesParams = [];
	if (projectFilter) {
		nodesSql += " WHERE project_hash = ?";
		nodesParams.push(projectFilter);
	}
	const allNodes = db.prepare(nodesSql).all(...nodesParams);
	const nodeNameMap = new Map(allNodes.map((n) => [n.id, n.name]));
	let edgesSql = "SELECT source_id, target_id FROM graph_edges";
	const edgesParams = [];
	if (projectFilter) {
		edgesSql += " WHERE project_hash = ?";
		edgesParams.push(projectFilter);
	}
	const allEdges = db.prepare(edgesSql).all(...edgesParams);
	const adj = /* @__PURE__ */ new Map();
	for (const node of allNodes) adj.set(node.id, /* @__PURE__ */ new Set());
	for (const edge of allEdges) {
		if (adj.has(edge.source_id)) adj.get(edge.source_id).add(edge.target_id);
		if (adj.has(edge.target_id)) adj.get(edge.target_id).add(edge.source_id);
	}
	const visited = /* @__PURE__ */ new Set();
	const components = [];
	const isolatedNodes = [];
	for (const nodeId of adj.keys()) {
		if (visited.has(nodeId)) continue;
		const queue = [nodeId];
		visited.add(nodeId);
		const compNodes = [];
		while (queue.length > 0) {
			const current = queue.shift();
			compNodes.push(current);
			for (const neighbor of adj.get(current) || []) if (!visited.has(neighbor)) {
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
		if (compNodes.length === 1 && (adj.get(compNodes[0])?.size ?? 0) === 0) {
			isolatedNodes.push(compNodes[0]);
			continue;
		}
		const compSet = new Set(compNodes);
		let edgeCount = 0;
		for (const edge of allEdges) if (compSet.has(edge.source_id) && compSet.has(edge.target_id)) edgeCount++;
		let maxDeg = -1;
		let labelNodeId = compNodes[0];
		for (const nid of compNodes) {
			const deg = (adj.get(nid) || /* @__PURE__ */ new Set()).size;
			if (deg > maxDeg) {
				maxDeg = deg;
				labelNodeId = nid;
			}
		}
		components.push({
			nodeIds: compNodes,
			label: nodeNameMap.get(labelNodeId) || labelNodeId,
			edgeCount
		});
	}
	components.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
	return {
		components,
		isolatedNodes,
		adj
	};
}
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
//#region src/web/routes/admin.ts
/**
* Admin API routes for database statistics and reset operations.
*
* @module web/routes/admin
*/
function getDb(c) {
	return c.get("db");
}
function getProjectHash$1(c) {
	return c.req.query("project") || c.get("defaultProject") || null;
}
const ALLOWED_TABLES = new Set([
	"observations",
	"observations_fts",
	"observation_embeddings",
	"staleness_flags",
	"graph_nodes",
	"graph_edges",
	"sessions",
	"context_stashes",
	"threshold_history",
	"shift_decisions",
	"pending_notifications",
	"project_metadata",
	"_migrations",
	"tool_registry",
	"tool_usage_events",
	"research_buffer"
]);
function tableCount(db, table, where, params) {
	if (!ALLOWED_TABLES.has(table)) return 0;
	try {
		const sql = where ? `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS cnt FROM ${table}`;
		return db.prepare(sql).get(...params || [])?.cnt ?? 0;
	} catch {
		return 0;
	}
}
const adminRoutes = new Hono();
/**
* GET /api/admin/stats
*
* Returns row counts per table group, optionally scoped to a project.
*/
adminRoutes.get("/stats", (c) => {
	const db = getDb(c);
	const project = c.req.query("project") || getProjectHash$1(c);
	const projectWhere = project ? "project_hash = ?" : void 0;
	const projectIdWhere = project ? "project_id = ?" : void 0;
	const projectParams = project ? [project] : void 0;
	const observations = tableCount(db, "observations", projectWhere, projectParams);
	const observationsFts = tableCount(db, "observations_fts");
	const observationEmbeddings = tableCount(db, "observation_embeddings");
	const stalenessFlags = tableCount(db, "staleness_flags");
	const graphNodes = tableCount(db, "graph_nodes", projectWhere, projectParams);
	const graphEdges = tableCount(db, "graph_edges", projectWhere, projectParams);
	const sessions = tableCount(db, "sessions", projectWhere, projectParams);
	const contextStashes = tableCount(db, "context_stashes", projectIdWhere, projectParams);
	const thresholdHistory = tableCount(db, "threshold_history", projectIdWhere, projectParams);
	const shiftDecisions = tableCount(db, "shift_decisions", projectIdWhere, projectParams);
	const pendingNotifications = tableCount(db, "pending_notifications", projectIdWhere, projectParams);
	const projects = tableCount(db, "project_metadata");
	return c.json({
		observations,
		observationsFts,
		observationEmbeddings,
		stalenessFlags,
		graphNodes,
		graphEdges,
		sessions,
		contextStashes,
		thresholdHistory,
		shiftDecisions,
		pendingNotifications,
		projects,
		scopedToProject: project || null
	});
});
/**
* POST /api/admin/reset
*
* Hard-deletes data by group inside a transaction.
* Body: { type: 'observations'|'graph'|'sessions'|'all', scope: 'current'|'all', projectHash?: string }
*/
adminRoutes.post("/reset", async (c) => {
	const db = getDb(c);
	const body = await c.req.json();
	const { type, scope } = body;
	const project = body.projectHash || getProjectHash$1(c);
	const validTypes = [
		"observations",
		"graph",
		"sessions",
		"all"
	];
	if (!validTypes.includes(type)) return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
	const scoped = scope === "current" && project;
	const deleted = [];
	const exec = (sql) => {
		try {
			db.exec(sql);
		} catch {}
	};
	const run = (sql, params) => {
		try {
			db.prepare(sql).run(...params || []);
		} catch {}
	};
	db.transaction(() => {
		if (type === "observations" || type === "all") {
			exec("DROP TRIGGER IF EXISTS observations_ai");
			exec("DROP TRIGGER IF EXISTS observations_au");
			exec("DROP TRIGGER IF EXISTS observations_ad");
			if (scoped) {
				run("DELETE FROM observation_embeddings WHERE observation_id IN (SELECT id FROM observations WHERE project_hash = ?)", [project]);
				run("DELETE FROM staleness_flags WHERE observation_id IN (SELECT id FROM observations WHERE project_hash = ?)", [project]);
				run("DELETE FROM observations WHERE project_hash = ?", [project]);
			} else {
				run("DELETE FROM observation_embeddings");
				run("DELETE FROM staleness_flags");
				run("DELETE FROM observations");
			}
			exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
			exec(`
        CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
      `);
			exec(`
        CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, old.content);
          INSERT INTO observations_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
      `);
			exec(`
        CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, old.content);
        END
      `);
			deleted.push("observations", "observations_fts", "observation_embeddings", "staleness_flags");
		}
		if (type === "graph" || type === "all") {
			if (scoped) {
				run("DELETE FROM graph_edges WHERE project_hash = ?", [project]);
				run("DELETE FROM graph_nodes WHERE project_hash = ?", [project]);
			} else {
				run("DELETE FROM graph_edges");
				run("DELETE FROM graph_nodes");
			}
			deleted.push("graph_nodes", "graph_edges");
		}
		if (type === "sessions" || type === "all") {
			if (scoped) {
				run("DELETE FROM shift_decisions WHERE project_id = ?", [project]);
				run("DELETE FROM threshold_history WHERE project_id = ?", [project]);
				run("DELETE FROM context_stashes WHERE project_id = ?", [project]);
				run("DELETE FROM pending_notifications WHERE project_id = ?", [project]);
				run("DELETE FROM sessions WHERE project_hash = ?", [project]);
			} else {
				run("DELETE FROM shift_decisions");
				run("DELETE FROM threshold_history");
				run("DELETE FROM context_stashes");
				run("DELETE FROM pending_notifications");
				run("DELETE FROM sessions");
			}
			deleted.push("sessions", "context_stashes", "threshold_history", "shift_decisions", "pending_notifications");
		}
		if (type === "all" && !scoped) {
			run("DELETE FROM project_metadata");
			run("DELETE FROM _migrations");
			deleted.push("project_metadata", "_migrations");
		}
	})();
	return c.json({
		ok: true,
		deleted,
		scope: scoped ? "project" : "all"
	});
});
adminRoutes.get("/hygiene", (c) => {
	const db = getDb(c);
	const project = getProjectHash$1(c);
	if (!project) return c.json({ error: "No project context available" }, 400);
	const tier = c.req.query("tier") || "high";
	const report = analyzeObservations(db, project, {
		sessionId: c.req.query("session_id"),
		limit: parseInt(c.req.query("limit") || "50", 10),
		minTier: tier === "all" ? "low" : tier
	});
	return c.json(report);
});
adminRoutes.post("/hygiene/purge", async (c) => {
	const db = getDb(c);
	const project = getProjectHash$1(c);
	if (!project) return c.json({ error: "No project context available" }, 400);
	const tier = (await c.req.json()).tier || "high";
	const result = executePurge(db, project, analyzeObservations(db, project, {
		minTier: tier === "all" ? "low" : tier,
		limit: 500
	}), tier);
	return c.json({
		ok: true,
		observationsPurged: result.observationsPurged,
		orphanNodesRemoved: result.orphanNodesRemoved,
		tier
	});
});
adminRoutes.get("/config/topic-detection", (c) => {
	return c.json(loadTopicDetectionConfig());
});
adminRoutes.put("/config/topic-detection", async (c) => {
	const body = await c.req.json();
	const configPath = join(getConfigDir(), "topic-detection.json");
	if (body && body.__reset === true) {
		try {
			if (existsSync(configPath)) unlinkSync(configPath);
		} catch {}
		return c.json(loadTopicDetectionConfig());
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Request body must be a JSON object" }, 400);
	const { __reset: _, ...data } = body;
	writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
	const validated = loadTopicDetectionConfig();
	writeFileSync(configPath, JSON.stringify(validated, null, 2), "utf-8");
	return c.json(validated);
});
adminRoutes.get("/config/graph-extraction", (c) => {
	return c.json(loadGraphExtractionConfig());
});
adminRoutes.put("/config/graph-extraction", async (c) => {
	const body = await c.req.json();
	const configPath = join(getConfigDir(), "graph-extraction.json");
	if (body && body.__reset === true) {
		try {
			if (existsSync(configPath)) unlinkSync(configPath);
		} catch {}
		return c.json(loadGraphExtractionConfig());
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Request body must be a JSON object" }, 400);
	const { __reset: _, ...data } = body;
	writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
	const validated = loadGraphExtractionConfig();
	writeFileSync(configPath, JSON.stringify(validated, null, 2), "utf-8");
	return c.json(validated);
});
adminRoutes.get("/config/cross-access", (c) => {
	const project = c.req.query("project");
	if (!project) return c.json({ error: "project query parameter is required" }, 400);
	return c.json(loadCrossAccessConfig(project));
});
adminRoutes.put("/config/cross-access", async (c) => {
	const project = c.req.query("project");
	if (!project) return c.json({ error: "project query parameter is required" }, 400);
	const body = await c.req.json();
	if (body && body.__reset === true) {
		resetCrossAccessConfig(project);
		return c.json(loadCrossAccessConfig(project));
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Request body must be a JSON object" }, 400);
	saveCrossAccessConfig(project, { readableProjects: body.readableProjects || [] });
	return c.json(loadCrossAccessConfig(project));
});
adminRoutes.get("/config/tool-verbosity", (c) => {
	return c.json(loadToolVerbosityConfig());
});
adminRoutes.put("/config/tool-verbosity", async (c) => {
	const body = await c.req.json();
	if (body && body.__reset === true) {
		const config = resetToolVerbosityConfig();
		saveToolVerbosityConfig(config);
		return c.json(config);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Request body must be a JSON object" }, 400);
	const level = body.level;
	if (level !== 1 && level !== 2 && level !== 3) return c.json({ error: "level must be 1, 2, or 3" }, 400);
	saveToolVerbosityConfig({ level });
	return c.json(loadToolVerbosityConfig());
});

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
	app.route("/api/admin", adminRoutes);
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
* Starts the Hono web server on the specified port.
*
* If the port is already in use (EADDRINUSE), skips starting — the first
* MCP instance owns the web server and all instances share the same SQLite
* database via WAL mode, so a single web server suffices.
*
* @param app - Configured Hono app from createWebServer()
* @param port - Port number (default: 37820)
* @returns The Node.js HTTP server instance, or null if port is already taken
*/
function startWebServer(app, port = 37820) {
	debug("db", `Starting web server on port ${port}`);
	const server = serve({
		fetch: app.fetch,
		port
	});
	server.on("error", (err) => {
		if (err.code === "EADDRINUSE") {
			server.close();
			debug("db", `Web server already running on port ${port}, skipping`);
		} else debug("db", `Web server error: ${err.message}`);
	});
	server.on("listening", () => {
		const addr = server.address();
		debug("db", `Web server listening on http://localhost:${typeof addr === "object" && addr ? addr.port : port}`);
	});
	return server;
}

//#endregion
//#region src/index.ts
const noGui = process.argv.includes("--no_gui");
const db = openDatabase(getDatabaseConfig());
initGraphSchema(db.db);
initPathSchema(db.db);
var LiveProjectHashRef = class LiveProjectHashRef {
	_current;
	_lastChecked = 0;
	_db;
	static CHECK_INTERVAL_MS = 2e3;
	constructor(sqliteDb) {
		this._db = sqliteDb;
		this._current = this.resolve();
	}
	get current() {
		const now = Date.now();
		if (now - this._lastChecked >= LiveProjectHashRef.CHECK_INTERVAL_MS) {
			this._lastChecked = now;
			const fresh = this.resolve();
			if (fresh !== this._current) {
				debug("mcp", "Project hash refreshed from database", {
					old: this._current,
					new: fresh
				});
				this._current = fresh;
			}
		}
		return this._current;
	}
	resolve() {
		try {
			const row = this._db.prepare("SELECT project_hash FROM project_metadata ORDER BY last_seen_at DESC LIMIT 1").get();
			if (row?.project_hash) return row.project_hash;
		} catch {}
		return getProjectHash(process.cwd());
	}
};
const projectHashRef = new LiveProjectHashRef(db.db);
let toolRegistry = null;
try {
	toolRegistry = new ToolRegistryRepository(db.db);
} catch {
	debug("mcp", "Tool registry not available (pre-migration-16)");
}
const embeddingStore = db.hasVectorSupport ? new EmbeddingStore(db.db, projectHashRef.current) : null;
const worker = new AnalysisWorker();
worker.start().catch(() => {
	debug("mcp", "Worker failed to start, keyword-only mode");
});
const topicConfig = loadTopicDetectionConfig();
const graphConfig = loadGraphExtractionConfig();
const detector = new TopicShiftDetector();
const adaptiveManager = new AdaptiveThresholdManager({
	sensitivityMultiplier: topicConfig.sensitivityMultiplier,
	alpha: topicConfig.ewmaAlpha
});
applyConfig(topicConfig, detector, adaptiveManager);
const historicalSeed = new ThresholdStore(db.db).loadHistoricalSeed(projectHashRef.current);
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
	observationStore: new ObservationRepository(db.db, projectHashRef.current),
	config: topicConfig,
	decisionLogger,
	adaptiveManager
});
const TOPIC_SHIFT_SOURCES = new Set([
	"hook:Write",
	"hook:Edit",
	"hook:Bash",
	"manual"
]);
async function processUnembedded() {
	if (!embeddingStore || !worker.isReady()) return;
	const ids = embeddingStore.findUnembedded(10);
	if (ids.length === 0) return;
	const currentHash = projectHashRef.current;
	const obsRepo = new ObservationRepository(db.db, currentHash);
	let shiftDetectedThisCycle = false;
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
				createdAt: obs.createdAt,
				projectHash: currentHash
			});
			if (topicConfig.enabled && !shiftDetectedThisCycle && TOPIC_SHIFT_SOURCES.has(obs.source)) try {
				const obsWithEmbedding = {
					...obs,
					embedding
				};
				const result = await topicShiftHandler.handleObservation(obsWithEmbedding, obs.sessionId ?? "unknown", currentHash);
				if (result.stashed && result.notification) {
					shiftDetectedThisCycle = true;
					notificationStore.add(currentHash, result.notification);
					debug("embed", "Topic shift detected, notification queued", { id });
					broadcast("topic_shift", {
						id: result.notification.substring(0, 32),
						fromTopic: null,
						toTopic: null,
						timestamp: (/* @__PURE__ */ new Date()).toISOString(),
						confidence: null,
						projectHash: currentHash
					});
				}
			} catch (topicErr) {
				debug("embed", "Topic shift detection error (non-fatal)", { error: topicErr instanceof Error ? topicErr.message : String(topicErr) });
			}
		}
	}
}
let researchBufferForFlush = null;
try {
	researchBufferForFlush = new ResearchBufferRepository(db.db, projectHashRef.current);
} catch {}
async function processUnembeddedTools() {
	if (!toolRegistry || !worker.isReady() || !db.hasVectorSupport) return;
	try {
		const unembedded = toolRegistry.findUnembeddedTools(5);
		for (const tool of unembedded) {
			const text = `${tool.name} ${tool.description}`;
			const embedding = await worker.embed(text);
			if (embedding) toolRegistry.storeEmbedding(tool.id, embedding);
		}
	} catch (err) {
		debug("embed", "Tool embedding error (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
	}
}
const embedTimer = setInterval(() => {
	processUnembedded().catch((err) => {
		debug("embed", "Background embedding error", { error: err instanceof Error ? err.message : String(err) });
	});
	processUnembeddedTools().catch((err) => {
		debug("embed", "Tool embedding background error", { error: err instanceof Error ? err.message : String(err) });
	});
	try {
		researchBufferForFlush?.flush(30);
	} catch {}
	statusCache.refreshIfDirty();
}, 5e3);
const statusCache = new StatusCache(db.db, projectHashRef, process.cwd(), db.hasVectorSupport, () => worker.isReady());
const server = createServer();
registerSaveMemory(server, db.db, projectHashRef, notificationStore, worker, embeddingStore, statusCache);
registerRecall(server, db.db, projectHashRef, worker, embeddingStore, notificationStore, statusCache);
registerTopicContext(server, db.db, projectHashRef, notificationStore);
registerQueryGraph(server, db.db, projectHashRef, notificationStore);
registerGraphStats(server, db.db, projectHashRef, notificationStore);
registerHygiene(server, db.db, projectHashRef, notificationStore);
registerStatus(server, statusCache, projectHashRef, notificationStore);
if (toolRegistry) {
	registerDiscoverTools(server, toolRegistry, worker, db.hasVectorSupport, notificationStore, projectHashRef);
	registerReportTools(server, toolRegistry, projectHashRef);
}
const pathRepo = new PathRepository(db.db, projectHashRef.current);
const pathTracker = new PathTracker(pathRepo);
registerDebugPathTools(server, pathRepo, pathTracker, notificationStore, projectHashRef);
let branchRepo = null;
let branchTracker = null;
try {
	branchRepo = new BranchRepository(db.db, projectHashRef.current);
	branchTracker = new BranchTracker(branchRepo, db.db, projectHashRef.current);
	const obsRepoForBranches = new ObservationRepository(db.db, projectHashRef.current);
	registerThoughtBranchTools(server, branchRepo, obsRepoForBranches, notificationStore, projectHashRef);
} catch {
	debug("mcp", "Branch tracking not available (pre-migration-21)");
}
const haikuProcessor = new HaikuProcessor(db.db, projectHashRef.current, {
	intervalMs: 3e4,
	batchSize: 10,
	concurrency: 3,
	pathTracker,
	branchTracker
});
startServer(server).then(() => {
	haikuProcessor.start();
}).catch((err) => {
	debug("mcp", "Fatal: failed to start server", { error: err.message });
	clearInterval(embedTimer);
	db.close();
	process.exit(1);
});
if (!noGui) {
	const webPort = parseInt(process.env.LAMINARK_WEB_PORT || "37820", 10);
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	const uiRoot = path.resolve(__dirname, "..", "ui");
	startWebServer(createWebServer(db.db, uiRoot, projectHashRef.current), webPort);
} else debug("mcp", "Web UI disabled (--no_gui)");
const curationAgent = new CurationAgent(db.db, {
	intervalMs: 300 * 1e3,
	graphConfig,
	onComplete: (report) => {
		debug("db", "Curation complete", {
			merged: report.observationsMerged,
			deduped: report.entitiesDeduplicated,
			stale: report.stalenessFlagsAdded,
			pruned: report.lowValuePruned,
			decayed: report.temporalDecayUpdated,
			decayDeleted: report.temporalDecayDeleted
		});
		statusCache.markDirty();
	}
});
curationAgent.start();
function shutdown(code) {
	clearInterval(embedTimer);
	haikuProcessor.stop();
	curationAgent.stop();
	worker.shutdown().catch(() => {});
	db.close();
	process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
	debug("mcp", "Uncaught exception", { error: err.message });
	shutdown(1);
});

//#endregion
export { EmbeddingStore, MIGRATIONS, ObservationRepository, SearchEngine, SessionRepository, StashManager, ThresholdStore, debug, debugTimed, getDatabaseConfig, getDbPath, getProjectHash, isDebugEnabled, openDatabase, runMigrations };
//# sourceMappingURL=index.js.map