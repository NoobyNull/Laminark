import { i as getProjectHash, n as getDatabaseConfig } from "../config-t8LZeB-u.mjs";
import { E as traverseFrom, F as openDatabase, M as SessionRepository, N as ObservationRepository, O as SaveGuard, P as rowToObservation, R as debug, S as getNodeByNameAndType, a as ResearchBufferRepository, c as inferScope, i as NotificationStore, j as SearchEngine, k as jaccardSimilarity, l as inferToolType, n as PathRepository, o as BranchRepository, p as runAutoCleanup, r as initPathSchema, s as extractServerName, t as ToolRegistryRepository } from "../tool-registry-e710BvXq.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

//#region src/hooks/self-referential.ts
/**
* Self-referential tool detection for Laminark.
*
* Laminark's MCP tools appear with different prefixes depending on
* how Claude Code discovers the server:
*
* - Project-scoped (.mcp.json): `mcp__laminark__<tool>`
* - Global plugin (~/.claude/plugins/): `mcp__plugin_laminark_laminark__<tool>`
*
* Both prefixes must be detected to prevent Laminark from capturing
* its own tool calls as observations, which would create a feedback loop.
*/
/**
* All known prefixes for Laminark's own MCP tools.
* Order: project-scoped first (most common), plugin-scoped second.
*/
const LAMINARK_PREFIXES = ["mcp__laminark__", "mcp__plugin_laminark_laminark__"];
/**
* Returns true if the given tool name belongs to Laminark.
*
* Checks against all known Laminark MCP prefixes to detect self-referential
* tool calls regardless of installation method (project-scoped or global plugin).
*/
function isLaminarksOwnTool(toolName) {
	return LAMINARK_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

//#endregion
//#region src/hooks/capture.ts
/**
* Truncates a string to maxLength, appending '...' if truncated.
*/
function truncate$2(text, maxLength) {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength) + "...";
}
/**
* Extracts a semantic observation summary from a PostToolUse payload.
* Returns null if no meaningful observation can be derived.
*
* Summaries are human-readable, not raw tool output. Each tool type
* gets a format optimized for later search and recall.
*/
function extractObservation(payload) {
	const { tool_name, tool_input, tool_response } = payload;
	switch (tool_name) {
		case "Write": return `[Write] Created ${tool_input.file_path}\n${truncate$2(String(tool_input.content ?? ""), 200)}`;
		case "Edit": return `[Edit] Modified ${tool_input.file_path}: replaced "${truncate$2(String(tool_input.old_string ?? ""), 80)}" with "${truncate$2(String(tool_input.new_string ?? ""), 80)}"`;
		case "Bash": return `[Bash] $ ${truncate$2(String(tool_input.command ?? ""), 100)}\n${truncate$2(JSON.stringify(tool_response ?? ""), 200)}`;
		case "Read":
		case "Glob":
		case "Grep": return null;
		case "WebFetch": return `[WebFetch] ${String(tool_input.url ?? "")}\nPrompt: ${truncate$2(String(tool_input.prompt ?? ""), 100)}\n${truncate$2(JSON.stringify(tool_response ?? ""), 300)}`;
		case "WebSearch": return `[WebSearch] "${String(tool_input.query ?? "")}"\n${truncate$2(JSON.stringify(tool_response ?? ""), 300)}`;
		default: return `[${tool_name}] ${truncate$2(JSON.stringify(tool_input), 200)}`;
	}
}

//#endregion
//#region src/curation/summarizer.ts
/**
* Groups observations by their kind field.
*/
function groupByKind(observations) {
	const groups = {
		change: [],
		reference: [],
		finding: [],
		decision: [],
		verification: []
	};
	for (const obs of observations) {
		const kind = obs.kind ?? "finding";
		if (groups[kind]) groups[kind].push(obs);
		else groups.finding.push(obs);
	}
	return groups;
}
/**
* Extracts a snippet from observation content (first line, max 120 chars).
*/
function snippet(content, maxLen = 120) {
	const firstLine = content.split("\n")[0].trim();
	if (firstLine.length <= maxLen) return firstLine;
	return firstLine.slice(0, maxLen - 3) + "...";
}
/**
* Compresses an array of session observations into a structured text summary.
*
* Kind-aware: groups observations by their `kind` field instead of heuristic
* keyword matching. Produces structured sections:
* - Changes (kind='change'): file modifications
* - Decisions (kind='decision'): choices made
* - Verifications (kind='verification'): test/build results
* - References (kind='reference'): external resources consulted
* - Findings (kind='finding'): manual saves and insights
*
* Target output: under 500 tokens (~2000 characters).
* If the raw extraction exceeds this budget, sections are trimmed by priority:
* references first, then findings, then verifications, then changes.
*/
function compressObservations(observations) {
	if (observations.length === 0) return "";
	const groups = groupByKind(observations);
	const sections = [];
	sections.push("## Session Summary");
	const sorted = [...observations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const startedAt = sorted[0].createdAt;
	const endedAt = sorted[sorted.length - 1].createdAt;
	sections.push(`**Duration:** ${startedAt} to ${endedAt}`);
	sections.push(`**Observations:** ${observations.length}`);
	if (groups.change.length > 0) {
		sections.push("");
		sections.push("### Changes");
		for (const obs of groups.change.slice(0, 10)) sections.push(`- ${snippet(obs.content)}`);
	}
	if (groups.decision.length > 0) {
		sections.push("");
		sections.push("### Decisions");
		for (const obs of groups.decision.slice(0, 5)) sections.push(`- ${snippet(obs.content)}`);
	}
	if (groups.verification.length > 0) {
		sections.push("");
		sections.push("### Verifications");
		for (const obs of groups.verification.slice(0, 5)) sections.push(`- ${snippet(obs.content)}`);
	}
	if (groups.reference.length > 0) {
		sections.push("");
		sections.push("### References");
		for (const obs of groups.reference.slice(0, 3)) sections.push(`- ${snippet(obs.content)}`);
	}
	if (groups.finding.length > 0) {
		sections.push("");
		sections.push("### Findings");
		for (const obs of groups.finding.slice(0, 5)) sections.push(`- ${snippet(obs.content)}`);
	}
	let result = sections.join("\n");
	if (result.length > 2e3) {
		const trimSections = [];
		trimSections.push("## Session Summary");
		trimSections.push(`**Duration:** ${startedAt} to ${endedAt}`);
		trimSections.push(`**Observations:** ${observations.length}`);
		if (groups.change.length > 0) {
			trimSections.push("");
			trimSections.push("### Changes");
			for (const obs of groups.change.slice(0, 5)) trimSections.push(`- ${snippet(obs.content)}`);
		}
		if (groups.decision.length > 0) {
			trimSections.push("");
			trimSections.push("### Decisions");
			for (const obs of groups.decision.slice(0, 3)) trimSections.push(`- ${snippet(obs.content)}`);
		}
		if (groups.verification.length > 0) {
			trimSections.push("");
			trimSections.push("### Verifications");
			for (const obs of groups.verification.slice(0, 3)) trimSections.push(`- ${snippet(obs.content)}`);
		}
		result = trimSections.join("\n");
	}
	return result;
}
/**
* Generates a session summary by reading all observations for the given session,
* compressing them into a concise summary, and storing it back on the session row.
*
* Returns null if the session has zero observations (graceful no-op).
*
* @param sessionId - The session ID to summarize
* @param obsRepo - Repository for reading observations
* @param sessionRepo - Repository for updating the session summary
* @returns SessionSummary or null if no observations
*/
function generateSessionSummary(sessionId, obsRepo, sessionRepo) {
	debug("curation", "Generating session summary", { sessionId });
	const observations = obsRepo.list({
		sessionId,
		limit: 1e3
	});
	if (observations.length === 0) {
		debug("curation", "No observations for session, skipping summary", { sessionId });
		return null;
	}
	const summary = compressObservations(observations);
	const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
	sessionRepo.updateSessionSummary(sessionId, summary);
	debug("curation", "Session summary generated", {
		sessionId,
		observationCount: observations.length,
		summaryLength: summary.length
	});
	return {
		sessionId,
		summary,
		observationCount: observations.length,
		generatedAt
	};
}

//#endregion
//#region src/context/injection.ts
/**
* Maximum character budget for injected context (~2000 tokens at ~3 chars/token).
* If the assembled context exceeds this, observations are truncated.
*/
const MAX_CONTEXT_CHARS = 6e3;
/**
* Maximum number of characters to show per observation in the index.
*/
const OBSERVATION_CONTENT_LIMIT = 120;
/**
* Maximum character budget for the "## Available Tools" section.
* Prevents tool listings from consuming too much of the 6000-char overall budget.
*/
const TOOL_SECTION_BUDGET = 500;
/**
* Welcome message for first-ever session (no prior sessions or observations).
*/
const WELCOME_MESSAGE = `[Laminark] First session detected. Memory system is active and capturing observations.
Use /laminark:remember to save important context. Use /laminark:recall to search memories.`;
/**
* Formats an ISO 8601 timestamp into a human-readable relative time string.
*
* @param isoDate - ISO 8601 timestamp string
* @returns Relative time string (e.g., "2 hours ago", "yesterday", "3 days ago")
*/
function formatRelativeTime(isoDate) {
	const diffMs = Date.now() - new Date(isoDate).getTime();
	if (diffMs < 0) return "just now";
	const seconds = Math.floor(diffMs / 1e3);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	if (minutes < 1) return "just now";
	if (minutes === 1) return "1 minute ago";
	if (minutes < 60) return `${minutes} minutes ago`;
	if (hours === 1) return "1 hour ago";
	if (hours < 24) return `${hours} hours ago`;
	if (days === 1) return "yesterday";
	if (days < 7) return `${days} days ago`;
	if (weeks === 1) return "1 week ago";
	return `${weeks} weeks ago`;
}
/**
* Truncates a string to `maxLen` characters, appending "..." if truncated.
*/
function truncate$1(text, maxLen) {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLen) return normalized;
	return normalized.slice(0, maxLen) + "...";
}
/**
* Queries recent observations filtered by kind with a time window.
*/
function getRecentByKind(db, projectHash, kind, limit, sinceDays) {
	const since = (/* @__PURE__ */ new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1e3)).toISOString();
	return db.prepare(`SELECT * FROM observations
       WHERE project_hash = ? AND kind = ? AND deleted_at IS NULL
         AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`).all(projectHash, kind, since, limit).map(rowToObservation);
}
/**
* Formats the context using structured kind-aware sections.
*
* Produces a compact index suitable for Claude's context window:
* - Last session summary
* - Recent changes (with provenance context)
* - Active decisions
* - Reference docs
* - Findings
*/
function formatContextIndex(lastSession, sections) {
	if (!(lastSession?.summary || sections.changes.length > 0 || sections.decisions.length > 0 || sections.findings.length > 0 || sections.references.length > 0)) return WELCOME_MESSAGE;
	const lines = ["[Laminark - Session Context]", ""];
	if (lastSession && lastSession.summary) {
		lines.push("## Previous Session");
		lines.push(lastSession.summary);
		lines.push("");
	}
	if (sections.changes.length > 0) {
		lines.push("## Recent Changes");
		for (const obs of sections.changes) {
			const content = truncate$1(obs.content, OBSERVATION_CONTENT_LIMIT);
			const relTime = formatRelativeTime(obs.createdAt);
			lines.push(`- ${content} (${relTime})`);
		}
		lines.push("");
	}
	if (sections.decisions.length > 0) {
		lines.push("## Active Decisions");
		for (const obs of sections.decisions) {
			const content = truncate$1(obs.content, OBSERVATION_CONTENT_LIMIT);
			lines.push(`- ${content}`);
		}
		lines.push("");
	}
	if (sections.references.length > 0) {
		lines.push("## Reference Docs");
		for (const obs of sections.references) {
			const content = truncate$1(obs.content, OBSERVATION_CONTENT_LIMIT);
			lines.push(`- ${content}`);
		}
		lines.push("");
	}
	if (sections.findings.length > 0) {
		lines.push("## Recent Findings");
		for (const obs of sections.findings) {
			const shortId = obs.id.slice(0, 8);
			const content = truncate$1(obs.content, OBSERVATION_CONTENT_LIMIT);
			lines.push(`- [${shortId}] ${content}`);
		}
	}
	return lines.join("\n");
}
/**
* Gets the most recent completed session with a non-null summary.
*/
function getLastCompletedSession(db, projectHash) {
	const row = db.prepare(`SELECT * FROM sessions
       WHERE project_hash = ? AND summary IS NOT NULL AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, rowid DESC
       LIMIT 1`).get(projectHash);
	if (!row) return null;
	return {
		id: row.id,
		projectHash: row.project_hash,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		summary: row.summary
	};
}
/**
* Ranks tools by relevance using a weighted combination of recent usage
* frequency and recency. Tools with no recent usage score 0.
*
* Formula: score = eventCount / totalEvents (frequency share among peers)
*
* Uses event-count-based window (last N events) instead of time-based decay.
* This is immune to usage gaps — if you don't use the app for a week,
* your usage patterns are preserved because the window slides by event
* count, not calendar time.
*
* MCP server entries aggregate usage stats from their individual tool events
* to ensure accurate scoring.
*/
function rankToolsByRelevance(tools, usageStats) {
	if (usageStats.length === 0) return tools;
	const statsMap = /* @__PURE__ */ new Map();
	for (const stat of usageStats) statsMap.set(stat.tool_name, stat);
	const serverStats = /* @__PURE__ */ new Map();
	for (const stat of usageStats) {
		const match = stat.tool_name.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
		if (match) {
			const serverName = match[1];
			const existing = serverStats.get(serverName);
			if (existing) existing.usage_count += stat.usage_count;
			else serverStats.set(serverName, { usage_count: stat.usage_count });
		}
	}
	const totalEvents = Math.max(1, [...statsMap.values()].reduce((sum, s) => sum + s.usage_count, 0));
	const scored = tools.map((row) => {
		let count = statsMap.get(row.name)?.usage_count;
		if (count === void 0 && row.tool_type === "mcp_server" && row.server_name) count = serverStats.get(row.server_name)?.usage_count;
		if (count === void 0) return {
			row,
			score: 0
		};
		let score = count / totalEvents;
		if (row.status === "stale" || row.status === "demoted") score *= .25;
		const lastUsed = row.last_used_at || row.discovered_at;
		const lastSeen = new Date(Math.max(new Date(lastUsed).getTime(), new Date(row.updated_at).getTime()));
		if ((Date.now() - lastSeen.getTime()) / (1e3 * 60 * 60 * 24) > 30) score *= .5;
		return {
			row,
			score
		};
	});
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.row.usage_count - a.row.usage_count;
	});
	return scored.map((s) => s.row);
}
/**
* Formats available tools as a compact section for session context.
*
* Deduplicates MCP servers vs individual MCP tools (prefers server entries).
* Excludes built-in tools (Claude already knows Read, Write, Edit, Bash, etc.).
* Enforces a 500-character sub-budget via incremental line checking.
*/
function formatToolSection(tools) {
	if (tools.length === 0) return "";
	const seenServers = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const tool of tools) if (tool.tool_type === "mcp_server") {
		seenServers.add(tool.server_name ?? tool.name);
		deduped.push(tool);
	}
	for (const tool of tools) if (tool.tool_type !== "mcp_server") {
		if (tool.tool_type === "mcp_tool" && tool.server_name && seenServers.has(tool.server_name)) continue;
		deduped.push(tool);
	}
	const displayable = deduped.filter((t) => t.tool_type !== "builtin");
	if (displayable.length === 0) return "";
	const lines = ["## Available Tools"];
	for (const tool of displayable) {
		const scopeTag = tool.scope === "project" ? "project" : "global";
		const usageStr = tool.usage_count > 0 ? `, ${tool.usage_count}x` : "";
		let candidateLine;
		if (tool.tool_type === "mcp_server") candidateLine = `- MCP: ${tool.server_name ?? tool.name} (${scopeTag}${usageStr})`;
		else if (tool.tool_type === "slash_command") candidateLine = `- ${tool.name} (${scopeTag}${usageStr})`;
		else if (tool.tool_type === "skill") {
			const desc = tool.description ? ` - ${tool.description}` : "";
			candidateLine = `- skill: ${tool.name} (${scopeTag})${desc}`;
		} else if (tool.tool_type === "plugin") candidateLine = `- plugin: ${tool.name} (${scopeTag})`;
		else candidateLine = `- ${tool.name} (${scopeTag}${usageStr})`;
		if ([...lines, candidateLine].join("\n").length > TOOL_SECTION_BUDGET) break;
		lines.push(candidateLine);
	}
	const added = lines.length - 1;
	if (displayable.length > added && added > 0) {
		const overflow = `(${displayable.length - added} more available)`;
		if ((lines.join("\n") + "\n" + overflow).length <= TOOL_SECTION_BUDGET) lines.push(overflow);
	}
	return lines.join("\n");
}
/**
* Assembles the complete context string for SessionStart injection.
*
* Kind-aware: queries changes (last 24h), decisions (last 7d),
* findings (last 7d), and references (last 3d) separately,
* then assembles them into structured sections.
*
* Token budget: Total output stays under 2000 tokens (~6000 characters).
*/
function assembleSessionContext(db, projectHash, toolRegistry) {
	debug("context", "Assembling session context", { projectHash });
	const lastSession = getLastCompletedSession(db, projectHash);
	const changes = getRecentByKind(db, projectHash, "change", 10, 1);
	const decisions = getRecentByKind(db, projectHash, "decision", 5, 7);
	const findings = getRecentByKind(db, projectHash, "finding", 5, 7);
	const references = getRecentByKind(db, projectHash, "reference", 3, 3);
	let toolSection = "";
	if (toolRegistry) try {
		toolSection = formatToolSection(rankToolsByRelevance(toolRegistry.getAvailableForSession(projectHash), toolRegistry.getRecentUsage(projectHash, 200)));
	} catch {}
	let context = formatContextIndex(lastSession, {
		changes,
		decisions,
		findings,
		references
	});
	if (toolSection) context = context + "\n\n" + toolSection;
	if (context.length > MAX_CONTEXT_CHARS) {
		debug("context", "Context exceeds budget, trimming", {
			length: context.length,
			budget: MAX_CONTEXT_CHARS
		});
		if (toolSection) {
			context = formatContextIndex(lastSession, {
				changes,
				decisions,
				findings,
				references
			});
			toolSection = "";
		}
	}
	if (context.length > MAX_CONTEXT_CHARS) {
		let trimmedRefs = references.slice();
		let trimmedFindings = findings.slice();
		let trimmedChanges = changes.slice();
		while (context.length > MAX_CONTEXT_CHARS && trimmedRefs.length > 0) {
			trimmedRefs = trimmedRefs.slice(0, -1);
			context = formatContextIndex(lastSession, {
				changes: trimmedChanges,
				decisions,
				findings: trimmedFindings,
				references: trimmedRefs
			});
		}
		if (context.length > MAX_CONTEXT_CHARS) while (context.length > MAX_CONTEXT_CHARS && trimmedFindings.length > 0) {
			trimmedFindings = trimmedFindings.slice(0, -1);
			context = formatContextIndex(lastSession, {
				changes: trimmedChanges,
				decisions,
				findings: trimmedFindings,
				references: trimmedRefs
			});
		}
		if (context.length > MAX_CONTEXT_CHARS) while (context.length > MAX_CONTEXT_CHARS && trimmedChanges.length > 0) {
			trimmedChanges = trimmedChanges.slice(0, -1);
			context = formatContextIndex(lastSession, {
				changes: trimmedChanges,
				decisions,
				findings: trimmedFindings,
				references: trimmedRefs
			});
		}
	}
	debug("context", "Session context assembled", { length: context.length });
	return context;
}

//#endregion
//#region src/hooks/config-scanner.ts
/**
* Extracts a description from YAML frontmatter in a Markdown file.
* Reads only the first 2000 bytes for performance.
*/
function extractDescription(filePath) {
	try {
		const fmMatch = readFileSync(filePath, {
			encoding: "utf-8",
			flag: "r"
		}).slice(0, 2e3).match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) return null;
		const descMatch = fmMatch[1].match(/description:\s*(.+)/);
		return descMatch ? descMatch[1].trim() : null;
	} catch {
		return null;
	}
}
/**
* Extracts trigger hints from a command/skill file for proactive suggestion matching.
* Reads YAML frontmatter `description` + content from `<objective>` blocks.
* Returns a concatenated string or null if nothing found.
*/
function extractTriggerHints(filePath) {
	try {
		const content = readFileSync(filePath, {
			encoding: "utf-8",
			flag: "r"
		});
		const head = content.slice(0, 2e3);
		const parts = [];
		const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const descMatch = fmMatch[1].match(/description:\s*(.+)/);
			if (descMatch) parts.push(descMatch[1].trim());
		}
		const objMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
		if (objMatch) parts.push(objMatch[1].trim());
		return parts.length > 0 ? parts.join(" ") : null;
	} catch {
		return null;
	}
}
/**
* Scans an .mcp.json file for MCP server entries.
* Each server key becomes a wildcard tool entry (individual tool names are not in config).
*/
function scanMcpJson(filePath, scope, projectHash, tools) {
	try {
		if (!existsSync(filePath)) return;
		const raw = readFileSync(filePath, "utf-8");
		const mcpServers = JSON.parse(raw).mcpServers;
		if (!mcpServers || typeof mcpServers !== "object") return;
		for (const serverName of Object.keys(mcpServers)) tools.push({
			name: `mcp__${serverName}__*`,
			toolType: "mcp_server",
			scope,
			source: `config:${filePath}`,
			projectHash,
			description: null,
			serverName,
			triggerHints: null
		});
	} catch (err) {
		debug("scanner", "Failed to scan MCP config", {
			filePath,
			error: String(err)
		});
	}
}
/**
* Scans ~/.claude.json for MCP servers (top-level and per-project).
*/
function scanClaudeJson(filePath, tools) {
	try {
		if (!existsSync(filePath)) return;
		const raw = readFileSync(filePath, "utf-8");
		const config = JSON.parse(raw);
		const topServers = config.mcpServers;
		if (topServers && typeof topServers === "object") for (const serverName of Object.keys(topServers)) tools.push({
			name: `mcp__${serverName}__*`,
			toolType: "mcp_server",
			scope: "global",
			source: "config:~/.claude.json",
			projectHash: null,
			description: null,
			serverName,
			triggerHints: null
		});
		const projects = config.projects;
		if (projects && typeof projects === "object") for (const projectEntry of Object.values(projects)) {
			const projServers = projectEntry.mcpServers;
			if (projServers && typeof projServers === "object") for (const serverName of Object.keys(projServers)) tools.push({
				name: `mcp__${serverName}__*`,
				toolType: "mcp_server",
				scope: "global",
				source: "config:~/.claude.json",
				projectHash: null,
				description: null,
				serverName,
				triggerHints: null
			});
		}
	} catch (err) {
		debug("scanner", "Failed to scan claude.json", {
			filePath,
			error: String(err)
		});
	}
}
/**
* Scans a commands directory for slash command .md files.
* Supports one level of subdirectory nesting for namespaced commands.
*/
function scanCommands(dirPath, scope, projectHash, tools) {
	try {
		if (!existsSync(dirPath)) return;
		const entries = readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".md")) {
			const cmdName = `/${basename(entry.name, ".md")}`;
			const filePath = join(dirPath, entry.name);
			const description = extractDescription(filePath);
			const triggerHints = extractTriggerHints(filePath);
			tools.push({
				name: cmdName,
				toolType: "slash_command",
				scope,
				source: `config:${dirPath}`,
				projectHash,
				description,
				serverName: null,
				triggerHints
			});
		} else if (entry.isDirectory()) {
			const subDir = join(dirPath, entry.name);
			try {
				const subEntries = readdirSync(subDir, { withFileTypes: true });
				for (const subEntry of subEntries) if (subEntry.isFile() && subEntry.name.endsWith(".md")) {
					const cmdName = `/${entry.name}:${basename(subEntry.name, ".md")}`;
					const subFilePath = join(subDir, subEntry.name);
					const description = extractDescription(subFilePath);
					const triggerHints = extractTriggerHints(subFilePath);
					tools.push({
						name: cmdName,
						toolType: "slash_command",
						scope,
						source: `config:${dirPath}`,
						projectHash,
						description,
						serverName: null,
						triggerHints
					});
				}
			} catch {}
		}
	} catch (err) {
		debug("scanner", "Failed to scan commands directory", {
			dirPath,
			error: String(err)
		});
	}
}
/**
* Scans a skills directory for skill subdirectories containing SKILL.md.
*/
function scanSkills(dirPath, scope, projectHash, tools) {
	try {
		if (!existsSync(dirPath)) return;
		const entries = readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) if (entry.isDirectory()) {
			const skillMdPath = join(dirPath, entry.name, "SKILL.md");
			if (existsSync(skillMdPath)) {
				const description = extractDescription(skillMdPath);
				const triggerHints = extractTriggerHints(skillMdPath);
				tools.push({
					name: entry.name,
					toolType: "skill",
					scope,
					source: `config:${dirPath}`,
					projectHash,
					description,
					serverName: null,
					triggerHints
				});
			}
		}
	} catch (err) {
		debug("scanner", "Failed to scan skills directory", {
			dirPath,
			error: String(err)
		});
	}
}
/**
* Scans installed_plugins.json for installed Claude plugins.
* Version 2 format: { version: 2, plugins: { "name@marketplace": [{ scope, installPath, version }] } }
*/
function scanInstalledPlugins(filePath, tools) {
	try {
		if (!existsSync(filePath)) return;
		const raw = readFileSync(filePath, "utf-8");
		const plugins = JSON.parse(raw).plugins;
		if (!plugins || typeof plugins !== "object") return;
		for (const [key, installations] of Object.entries(plugins)) {
			const pluginName = key.split("@")[0];
			if (!Array.isArray(installations)) continue;
			for (const install of installations) {
				const inst = install;
				const instScope = inst.scope === "user" ? "global" : "project";
				tools.push({
					name: pluginName,
					toolType: "plugin",
					scope: instScope,
					source: "config:installed_plugins.json",
					projectHash: null,
					description: null,
					serverName: null,
					triggerHints: null
				});
				if (typeof inst.installPath === "string") scanMcpJson(join(inst.installPath, ".mcp.json"), "plugin", null, tools);
			}
		}
	} catch (err) {
		debug("scanner", "Failed to scan installed plugins", {
			filePath,
			error: String(err)
		});
	}
}
/**
* Scans all Claude Code config surfaces for tool discovery.
* Called during SessionStart to proactively populate the tool registry.
*
* All filesystem operations are synchronous (SessionStart hook is synchronous).
* Every scanner is wrapped in try/catch -- malformed configs never crash the hook.
*
* Config surfaces scanned:
*   DISC-01: .mcp.json (project) + ~/.claude.json (global)
*   DISC-02: .claude/commands (project) + ~/.claude/commands (global)
*   DISC-03: .claude/skills (project) + ~/.claude/skills (global)
*   DISC-04: installed_plugins.json (global plugins)
*/
function scanConfigForTools(cwd, projectHash) {
	const tools = [];
	const home = homedir();
	scanMcpJson(join(cwd, ".mcp.json"), "project", projectHash, tools);
	scanClaudeJson(join(home, ".claude.json"), tools);
	scanCommands(join(cwd, ".claude", "commands"), "project", projectHash, tools);
	scanCommands(join(home, ".claude", "commands"), "global", null, tools);
	scanSkills(join(cwd, ".claude", "skills"), "project", projectHash, tools);
	scanSkills(join(home, ".claude", "skills"), "global", null, tools);
	scanInstalledPlugins(join(home, ".claude", "plugins", "installed_plugins.json"), tools);
	return tools;
}

//#endregion
//#region src/routing/intent-patterns.ts
/**
* Extracts tool sequence patterns from historical tool_usage_events.
*
* Scans all successful tool usage events for the project, groups them by session,
* and identifies recurring sliding-window patterns where a specific sequence of
* preceding tool calls led to a target tool activation.
*
* Runs at SessionStart and stores results in the routing_patterns table for
* cheap PostToolUse lookup.
*
* @param db - Database connection
* @param projectHash - Project identifier
* @param windowSize - Number of preceding tools to consider (default 5)
* @returns Extracted patterns sorted by frequency descending
*/
function extractPatterns(db, projectHash, windowSize = 5) {
	const events = db.prepare(`
    SELECT tool_name, session_id
    FROM tool_usage_events
    WHERE project_hash = ? AND success = 1
    ORDER BY session_id, created_at
  `).all(projectHash);
	const sessions = /* @__PURE__ */ new Map();
	for (const evt of events) {
		if (!sessions.has(evt.session_id)) sessions.set(evt.session_id, []);
		sessions.get(evt.session_id).push(evt.tool_name);
	}
	const patternCounts = /* @__PURE__ */ new Map();
	for (const [, toolSequence] of sessions) for (let i = windowSize; i < toolSequence.length; i++) {
		const target = toolSequence[i];
		const preceding = toolSequence.slice(i - windowSize, i);
		if (inferToolType(target) === "builtin") continue;
		if (isLaminarksOwnTool(target)) continue;
		const key = `${target}:${preceding.join(",")}`;
		const existing = patternCounts.get(key);
		if (existing) existing.count++;
		else patternCounts.set(key, {
			target,
			preceding,
			count: 1
		});
	}
	return Array.from(patternCounts.values()).filter((p) => p.count >= 2).map((p) => ({
		targetTool: p.target,
		precedingTools: p.preceding,
		frequency: p.count
	})).sort((a, b) => b.frequency - a.frequency);
}
/**
* Stores pre-computed routing patterns in the routing_patterns table.
*
* Creates the table inline (CREATE TABLE IF NOT EXISTS), deletes old patterns
* for the project, and inserts new ones in a transaction.
*
* @param db - Database connection
* @param projectHash - Project identifier
* @param patterns - Pre-computed patterns from extractPatterns()
*/
function storePrecomputedPatterns(db, projectHash, patterns) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS routing_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_hash TEXT NOT NULL,
      target_tool TEXT NOT NULL,
      preceding_tools TEXT NOT NULL,
      frequency INTEGER NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
	db.exec(`
    CREATE INDEX IF NOT EXISTS idx_routing_patterns_project ON routing_patterns(project_hash)
  `);
	const deleteStmt = db.prepare("DELETE FROM routing_patterns WHERE project_hash = ?");
	const insertStmt = db.prepare("INSERT INTO routing_patterns (project_hash, target_tool, preceding_tools, frequency) VALUES (?, ?, ?, ?)");
	db.transaction(() => {
		deleteStmt.run(projectHash);
		for (const pattern of patterns) insertStmt.run(projectHash, pattern.targetTool, JSON.stringify(pattern.precedingTools), pattern.frequency);
	})();
	debug("routing", "Stored pre-computed patterns", {
		projectHash,
		count: patterns.length
	});
}
/**
* Evaluates the current session's recent tool sequence against pre-computed patterns.
*
* Queries the current session's recent tool names, compares against stored patterns,
* and returns the best match if it exceeds the confidence threshold and the target
* tool is in the suggestable set.
*
* @param db - Database connection
* @param sessionId - Current session identifier
* @param projectHash - Project identifier
* @param suggestableToolNames - Set of tool names available for suggestion (availability gate)
* @param confidenceThreshold - Minimum confidence to return a suggestion
* @returns Best matching suggestion, or null if none qualifies
*/
function evaluateLearnedPatterns(db, sessionId, projectHash, suggestableToolNames, confidenceThreshold) {
	const currentTools = db.prepare(`
    SELECT tool_name FROM tool_usage_events
    WHERE session_id = ? AND project_hash = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(sessionId, projectHash).map((e) => e.tool_name).reverse();
	if (currentTools.length === 0) return null;
	const storedPatterns = db.prepare(`
    SELECT target_tool, preceding_tools, frequency
    FROM routing_patterns
    WHERE project_hash = ?
    ORDER BY frequency DESC
  `).all(projectHash);
	if (storedPatterns.length === 0) return null;
	let bestMatch = null;
	for (const row of storedPatterns) {
		if (!suggestableToolNames.has(row.target_tool)) continue;
		const overlap = computeSequenceOverlap(currentTools, JSON.parse(row.preceding_tools));
		if (overlap > (bestMatch?.confidence ?? 0)) bestMatch = {
			targetTool: row.target_tool,
			confidence: overlap,
			frequency: row.frequency
		};
	}
	if (!bestMatch || bestMatch.confidence < confidenceThreshold) return null;
	return {
		toolName: bestMatch.targetTool,
		toolDescription: null,
		confidence: bestMatch.confidence,
		tier: "learned",
		reason: `Tool sequence pattern match (seen ${bestMatch.frequency}x in similar contexts)`
	};
}
/**
* Computes Jaccard-like overlap between the current session's recent tool set
* and a pattern's preceding tools set.
*
* Takes the last N tools from the current sequence (where N = pattern length),
* converts both to sets, and counts how many pattern tools appear in the current set.
*
* @param currentTools - Current session's recent tool names (chronological order)
* @param patternTools - Pattern's preceding tools
* @returns Overlap score from 0.0 to 1.0
*/
function computeSequenceOverlap(currentTools, patternTools) {
	if (patternTools.length === 0) return 0;
	const current = new Set(currentTools.slice(-patternTools.length));
	const pattern = new Set(patternTools);
	let matches = 0;
	for (const tool of pattern) if (current.has(tool)) matches++;
	return matches / pattern.size;
}

//#endregion
//#region src/hooks/session-lifecycle.ts
/**
* STAL-01: Detects tools that have been removed from config since last scan.
*
* Compares currently scanned config tools against the registry and marks
* missing config-sourced tools as stale. Also cascades to individual MCP tools
* from removed MCP servers.
*/
function detectRemovedTools(toolRegistry, scannedTools, projectHash) {
	const registeredConfigTools = toolRegistry.getConfigSourcedTools(projectHash);
	const scannedNames = new Set(scannedTools.map((t) => t.name));
	const removedServers = /* @__PURE__ */ new Set();
	for (const registered of registeredConfigTools) if (!scannedNames.has(registered.name)) {
		toolRegistry.markStale(registered.name, registered.project_hash);
		if (registered.tool_type === "mcp_server" && registered.server_name) removedServers.add(registered.server_name);
	}
	if (removedServers.size > 0) {
		for (const registered of toolRegistry.getAvailableForSession(projectHash)) if (registered.server_name && removedServers.has(registered.server_name) && registered.tool_type === "mcp_tool") toolRegistry.markStale(registered.name, registered.project_hash);
	}
}
/**
* Handles a SessionStart hook event.
*
* Creates a new session record in the database, then assembles context
* from prior sessions and observations for injection into Claude's
* context window.
*
* This hook is SYNCHRONOUS -- stdout is injected into Claude's context.
* Must complete within 2 seconds (performance budget for sync hooks).
* Expected execution: <100ms (session create + 2-3 SELECT queries).
*
* @returns Context string to write to stdout, or null if no context available
*/
function handleSessionStart(input, sessionRepo, db, projectHash, toolRegistry, pathRepo, branchRepo) {
	const sessionId = input.session_id;
	if (!sessionId) {
		debug("session", "SessionStart missing session_id, skipping");
		return null;
	}
	sessionRepo.create(sessionId);
	debug("session", "Session started", { sessionId });
	const cwd = input.cwd;
	if (cwd) try {
		db.prepare(`
        INSERT INTO project_metadata (project_hash, project_path, last_seen_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(project_hash) DO UPDATE SET
          project_path = excluded.project_path,
          last_seen_at = excluded.last_seen_at
      `).run(projectHash, cwd);
	} catch {}
	if (toolRegistry) {
		const cwd = input.cwd;
		try {
			const scanStart = Date.now();
			const tools = scanConfigForTools(cwd, projectHash);
			for (const tool of tools) toolRegistry.upsert(tool);
			try {
				detectRemovedTools(toolRegistry, tools, projectHash);
				debug("session", "Staleness detection completed");
			} catch {
				debug("session", "Staleness detection failed (non-fatal)");
			}
			const scanElapsed = Date.now() - scanStart;
			debug("session", "Config scan completed", {
				toolsFound: tools.length,
				elapsed: scanElapsed
			});
			if (scanElapsed > 200) debug("session", "Config scan slow (>200ms budget)", { elapsed: scanElapsed });
		} catch {
			debug("session", "Config scan failed (non-fatal)");
		}
	}
	if (toolRegistry) try {
		const precomputeStart = Date.now();
		const patterns = extractPatterns(db, projectHash, 5);
		storePrecomputedPatterns(db, projectHash, patterns);
		const precomputeElapsed = Date.now() - precomputeStart;
		debug("session", "Routing patterns pre-computed", {
			patternCount: patterns.length,
			elapsed: precomputeElapsed
		});
		if (precomputeElapsed > 50) debug("session", "Pattern pre-computation slow (>50ms)", { elapsed: precomputeElapsed });
	} catch {
		debug("session", "Pattern pre-computation failed (non-fatal)");
	}
	const startTime = Date.now();
	let context = assembleSessionContext(db, projectHash, toolRegistry);
	const elapsed = Date.now() - startTime;
	if (elapsed > 500) debug("session", "Context assembly slow", {
		elapsed,
		sessionId
	});
	debug("session", "Context assembled for injection", {
		sessionId,
		contextLength: context.length,
		elapsed
	});
	if (pathRepo) try {
		const activePath = pathRepo.findRecentActivePath();
		if (activePath) {
			const ageMs = Date.now() - new Date(activePath.started_at).getTime();
			if (ageMs > 1440 * 60 * 1e3) {
				pathRepo.abandonPath(activePath.id);
				debug("session", "Auto-abandoned stale debug path", {
					pathId: activePath.id,
					ageMs
				});
			} else {
				const waypoints = pathRepo.getWaypoints(activePath.id);
				const lastWaypoint = waypoints[waypoints.length - 1];
				const pathContext = `\n[Laminark] Active debug path carried over from prior session:\n  Issue: ${activePath.trigger_summary}\n  Waypoints: ${waypoints.length}\n  Last activity: ${lastWaypoint?.summary?.slice(0, 100) ?? "none"}\n  Use path_show to see full path, or path_resolve to close it.\n`;
				context = context + pathContext;
			}
		}
	} catch {
		debug("session", "Cross-session path check failed (non-fatal)");
	}
	if (branchRepo) try {
		const activeBranch = branchRepo.findRecentActiveBranch();
		if (activeBranch) {
			const branchContext = `\n[Laminark] Active work branch carried over:\n  ${activeBranch.title ?? activeBranch.id.slice(0, 12)} (${activeBranch.branch_type})\n  Stage: ${activeBranch.arc_stage} | Observations: ${activeBranch.observation_count}\n  Use query_branches to see all branches.\n`;
			context = context + branchContext;
		}
	} catch {
		debug("session", "Cross-session branch check failed (non-fatal)");
	}
	return context + (toolRegistry ? "\nCall report_available_tools with all your tools (built-in and MCP) so Laminark can index them for discovery." : "");
}
/**
* Handles a SessionEnd hook event.
*
* Closes the session record by setting ended_at timestamp.
*/
function handleSessionEnd(input, sessionRepo) {
	const sessionId = input.session_id;
	if (!sessionId) {
		debug("session", "SessionEnd missing session_id, skipping");
		return;
	}
	sessionRepo.end(sessionId);
	debug("session", "Session ended", { sessionId });
}
/**
* Handles a Stop hook event.
*
* Triggers session summary generation by compressing all observations
* from the session into a concise summary stored on the session row.
*
* Stop fires after SessionEnd, so the session is already closed.
* Summary generation is heuristic (no LLM call) and typically completes
* in under 10ms even with many observations.
*
* If the session has zero observations, this is a graceful no-op.
*/
function handleStop(input, obsRepo, sessionRepo, db, projectHash) {
	const sessionId = input.session_id;
	if (!sessionId) {
		debug("session", "Stop missing session_id, skipping");
		return;
	}
	debug("session", "Stop event received, generating summary", { sessionId });
	const result = generateSessionSummary(sessionId, obsRepo, sessionRepo);
	if (result) debug("session", "Session summary generated", {
		sessionId,
		observationCount: result.observationCount,
		summaryLength: result.summary.length
	});
	else debug("session", "No observations to summarize", { sessionId });
	if (db && projectHash) try {
		const cleanup = runAutoCleanup(db, projectHash);
		if (!cleanup.skipped && (cleanup.observationsPurged > 0 || cleanup.orphanNodesRemoved > 0)) debug("session", "Auto-cleanup ran at session end", {
			observationsPurged: cleanup.observationsPurged,
			orphanNodesRemoved: cleanup.orphanNodesRemoved
		});
	} catch {
		debug("session", "Auto-cleanup failed (non-fatal)");
	}
}

//#endregion
//#region src/hooks/privacy-filter.ts
/**
* Built-in privacy patterns that are always active.
*
* Order matters: more specific patterns should come before more general ones.
* For example, api_key patterns before env_variable to avoid double-matching.
*/
const DEFAULT_PRIVACY_PATTERNS = [
	{
		name: "private_key",
		regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
		replacement: "[REDACTED:private_key]",
		category: "private_key"
	},
	{
		name: "jwt_token",
		regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
		replacement: "[REDACTED:jwt]",
		category: "jwt"
	},
	{
		name: "connection_string",
		regex: /(postgresql|mongodb|mysql|redis):\/\/[^\s]+/g,
		replacement: "$1://[REDACTED:connection_string]",
		category: "connection_string"
	},
	{
		name: "api_key_openai",
		regex: /sk-[a-zA-Z0-9]{20,}/g,
		replacement: "[REDACTED:api_key]",
		category: "api_key"
	},
	{
		name: "api_key_github",
		regex: /ghp_[a-zA-Z0-9]{36,}/g,
		replacement: "[REDACTED:api_key]",
		category: "api_key"
	},
	{
		name: "aws_access_key",
		regex: /AKIA[A-Z0-9]{12,}/g,
		replacement: "[REDACTED:api_key]",
		category: "api_key"
	},
	{
		name: "env_variable",
		regex: /\b([A-Z][A-Z0-9_]{2,})=(["']?)(?!\[REDACTED:)([^\s"']{8,})\2/g,
		replacement: "$1=[REDACTED:env]",
		category: "env"
	}
];
/**
* Default file patterns that trigger full exclusion (return null).
*/
const DEFAULT_EXCLUDED_FILE_PATTERNS = [
	/\.env(\.|$)/,
	/credentials/i,
	/secrets/i,
	/\.pem$/,
	/\.key$/,
	/id_rsa/
];
/**
* Cached patterns (loaded once per process).
* null = not yet loaded.
*/
let _cachedPatterns = null;
let _cachedExcludedFiles = null;
/**
* Loads user privacy patterns from ~/.laminark/config.json.
* Merges with defaults. Caches result.
*
* If the config file doesn't exist or is invalid, returns defaults only.
*/
function loadPatterns() {
	if (_cachedPatterns !== null) return _cachedPatterns;
	const patterns = [...DEFAULT_PRIVACY_PATTERNS];
	try {
		const raw = readFileSync(join(homedir(), ".laminark", "config.json"), "utf-8");
		const privacy = JSON.parse(raw).privacy;
		if (privacy?.additionalPatterns) {
			for (const p of privacy.additionalPatterns) patterns.push({
				name: `user_${p.regex}`,
				regex: new RegExp(p.regex, "g"),
				replacement: p.replacement,
				category: "user"
			});
			debug("privacy", "Loaded user privacy patterns", { count: privacy.additionalPatterns.length });
		}
	} catch {}
	_cachedPatterns = patterns;
	return patterns;
}
/**
* Loads excluded file patterns (default + user-configured).
*/
function loadExcludedFiles() {
	if (_cachedExcludedFiles !== null) return _cachedExcludedFiles;
	const patterns = [...DEFAULT_EXCLUDED_FILE_PATTERNS];
	try {
		const raw = readFileSync(join(homedir(), ".laminark", "config.json"), "utf-8");
		const privacy = JSON.parse(raw).privacy;
		if (privacy?.excludedFiles) for (const pattern of privacy.excludedFiles) patterns.push(new RegExp(pattern));
	} catch {}
	_cachedExcludedFiles = patterns;
	return patterns;
}
/**
* Checks whether a file path matches any excluded file pattern.
*
* Excluded files should have their observations fully dropped (return null
* from redactSensitiveContent) rather than just redacted.
*
* @param filePath - The file path to check (can be absolute or relative)
* @returns true if the file should be excluded from observation storage
*/
function isExcludedFile(filePath) {
	const name = basename(filePath);
	const patterns = loadExcludedFiles();
	for (const pattern of patterns) if (pattern.test(name) || pattern.test(filePath)) return true;
	return false;
}
/**
* Redacts sensitive content before storage.
*
* - If filePath is provided and matches an excluded file pattern, returns null
*   (the entire observation should be dropped)
* - Otherwise, applies all privacy patterns (default + user-configured)
*   sequentially to the text
* - Returns the redacted text, or the original if no patterns matched
*
* @param text - The observation text to redact
* @param filePath - Optional file path that triggered the observation
* @returns Redacted text, or null if the file should be fully excluded
*/
function redactSensitiveContent(text, filePath) {
	if (filePath && isExcludedFile(filePath)) {
		debug("privacy", "File excluded from observation", { filePath });
		return null;
	}
	const patterns = loadPatterns();
	let result = text;
	const matchedPatterns = [];
	for (const pattern of patterns) {
		pattern.regex.lastIndex = 0;
		if (pattern.regex.test(result)) {
			matchedPatterns.push(pattern.name);
			pattern.regex.lastIndex = 0;
			result = result.replace(pattern.regex, pattern.replacement);
		}
	}
	if (matchedPatterns.length > 0) debug("privacy", "Content redacted", { patterns: matchedPatterns });
	return result;
}

//#endregion
//#region src/hooks/admission-filter.ts
/**
* Tools that are always admitted regardless of content.
*
* Write and Edit observations are high-signal by definition --
* they represent intentional code changes. Content pattern matching
* must NEVER reject these tools (see research pitfall #3).
*
* WebFetch and WebSearch are reference material -- always valuable.
*/
const HIGH_SIGNAL_TOOLS = new Set([
	"Write",
	"Edit",
	"WebFetch",
	"WebSearch"
]);
/**
* Navigation/exploration Bash commands that produce noise observations.
* Matched against the start of the command string (after trimming).
*/
const NAVIGATION_BASH_PREFIXES = [
	"ls",
	"cd ",
	"pwd",
	"cat ",
	"head ",
	"tail ",
	"echo ",
	"wc ",
	"which ",
	"find ",
	"tree",
	"file "
];
/**
* Git read-only commands that are navigation (not mutations).
*/
const NAVIGATION_GIT_PATTERNS = [
	/^git\s+status\b/,
	/^git\s+log\b/,
	/^git\s+diff\b(?!.*--)/,
	/^git\s+branch\b(?!\s+-[dDmM])/,
	/^git\s+show\b/,
	/^git\s+remote\b/,
	/^git\s+stash\s+list\b/
];
/**
* Commands that are always meaningful and should be admitted.
*/
const MEANINGFUL_BASH_PATTERNS = [
	/^npm\s+test\b/,
	/^npx\s+vitest\b/,
	/^npx\s+jest\b/,
	/^vitest\b/,
	/^jest\b/,
	/^pytest\b/,
	/^cargo\s+test\b/,
	/^go\s+test\b/,
	/^make\s+test\b/,
	/^npm\s+run\s+build\b/,
	/^npx\s+tsc\b/,
	/^cargo\s+build\b/,
	/^make\b/,
	/^go\s+build\b/,
	/^gradle\b/,
	/^mvn\b/,
	/^git\s+commit\b/,
	/^git\s+push\b/,
	/^git\s+merge\b/,
	/^git\s+rebase\b/,
	/^git\s+cherry-pick\b/,
	/^git\s+reset\b/,
	/^git\s+revert\b/,
	/^git\s+checkout\s+-b\b/,
	/^git\s+switch\s+-c\b/,
	/^git\s+stash\s+(?:push|pop|apply|drop)\b/,
	/^docker\b/,
	/^kubectl\b/,
	/^terraform\b/,
	/^helm\b/,
	/^npm\s+install\b/,
	/^npm\s+i\b/,
	/^yarn\s+add\b/,
	/^pnpm\s+add\b/,
	/^pip\s+install\b/,
	/^cargo\s+add\b/
];
/**
* Determines if a Bash command is meaningful enough to capture.
*
* Navigation commands (ls, cd, pwd, cat, git status, git log, etc.) are
* filtered out. Test runners, build commands, git mutations, and container
* commands are always admitted. Unknown commands default to admit.
*/
function isMeaningfulBashCommand(command) {
	const trimmed = command.trim();
	if (!trimmed) return false;
	for (const pattern of MEANINGFUL_BASH_PATTERNS) if (pattern.test(trimmed)) return true;
	for (const prefix of NAVIGATION_BASH_PREFIXES) if (trimmed.startsWith(prefix) || trimmed === prefix.trim()) return false;
	for (const pattern of NAVIGATION_GIT_PATTERNS) if (pattern.test(trimmed)) return false;
	return true;
}
/**
* Maximum content length before requiring decision/error indicators.
* Content over this threshold with no meaningful indicators is likely
* a raw file dump or verbose command output.
*/
const MAX_CONTENT_LENGTH = 5e3;
/**
* Patterns that indicate meaningful content even in long output.
* If content exceeds MAX_CONTENT_LENGTH, it must contain at least
* one of these to be admitted.
*/
const DECISION_OR_ERROR_INDICATORS = [
	/\berror\b/i,
	/\bfailed\b/i,
	/\bexception\b/i,
	/\bbug\b/i,
	/\bdecided\b/i,
	/\bchose\b/i,
	/\bbecause\b/i,
	/\binstead of\b/i
];
/**
* Decides whether an observation is worth storing in the database.
*
* This is the primary quality gate for the observation pipeline.
* It prevents the database from filling with noise (build output,
* linter spam, package install logs).
*
* Critical rule: Write and Edit tools are NEVER rejected based on
* content patterns alone. Tool type is the primary signal.
*
* @param toolName - The name of the tool that produced the observation
* @param content - The observation content to evaluate
* @returns true if the observation should be stored, false to reject
*/
function shouldAdmit(toolName, content) {
	if (isLaminarksOwnTool(toolName)) {
		debug("hook", "Observation rejected", {
			tool: toolName,
			reason: "self-referential"
		});
		return false;
	}
	if (!content || content.trim().length === 0) {
		debug("hook", "Observation rejected", {
			tool: toolName,
			reason: "empty"
		});
		return false;
	}
	if (HIGH_SIGNAL_TOOLS.has(toolName)) return true;
	if (content.length > MAX_CONTENT_LENGTH) {
		if (!DECISION_OR_ERROR_INDICATORS.some((pattern) => pattern.test(content))) {
			debug("hook", "Observation rejected", {
				tool: toolName,
				reason: "long_content_no_indicators",
				length: content.length
			});
			return false;
		}
	}
	return true;
}

//#endregion
//#region src/paths/path-recall.ts
/**
* Path recall — finds relevant past resolved debug paths based on text similarity.
*
* Used by the PreToolUse hook to surface "you've seen this before" context
* when new debugging starts on similar issues.
*
* Implements INTEL-03: proactive path recall via Jaccard similarity matching.
*/
/**
* Finds past resolved debug paths similar to the current context text.
*
* Computes Jaccard similarity against both trigger_summary and resolution_summary
* of recent resolved paths, taking the max score. Filters to paths scoring >= 0.25
* and returns the top `limit` results sorted by similarity descending.
*/
function findSimilarPaths(pathRepo, currentContext, limit = 3) {
	const resolvedPaths = pathRepo.listPaths(50).filter((p) => p.status === "resolved");
	if (resolvedPaths.length === 0) return [];
	const scored = [];
	for (const path of resolvedPaths) {
		const triggerScore = jaccardSimilarity(currentContext, path.trigger_summary);
		const resolutionScore = jaccardSimilarity(currentContext, path.resolution_summary ?? "");
		const similarity = Math.max(triggerScore, resolutionScore);
		if (similarity >= .25) {
			let kissSummary = null;
			if (path.kiss_summary) try {
				const parsed = JSON.parse(path.kiss_summary);
				kissSummary = parsed.next_time ?? parsed.root_cause ?? null;
			} catch {
				kissSummary = null;
			}
			scored.push({
				path,
				similarity,
				kissSummary
			});
		}
	}
	scored.sort((a, b) => b.similarity - a.similarity);
	return scored.slice(0, limit);
}
/**
* Formats path recall results into a compact string for context injection.
*
* Returns empty string if no results. Caps total output to 600 chars.
*/
function formatPathRecall(results) {
	if (results.length === 0) return "";
	const lines = ["[Laminark] Similar past debug paths found:"];
	for (const r of results) {
		const trigger = r.path.trigger_summary.slice(0, 80);
		lines.push(`- ${trigger} (similarity: ${r.similarity.toFixed(2)})`);
		lines.push(`  KISS: ${r.kissSummary ?? "No summary available"}`);
	}
	const output = lines.join("\n");
	if (output.length > 600) return output.slice(0, 597) + "...";
	return output;
}

//#endregion
//#region src/hooks/pre-tool-context.ts
/** Tools where we skip context injection entirely. */
const SKIP_TOOLS = new Set([
	"Glob",
	"Task",
	"NotebookEdit",
	"EnterPlanMode",
	"ExitPlanMode",
	"AskUserQuestion",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList"
]);
/** Bash commands that are navigation/noise -- not worth searching for. */
const NOISE_BASH_RE = /^\s*(cd|ls|pwd|echo|cat|head|tail|mkdir|rm|cp|mv|npm\s+(run|start|test|install)|yarn|pnpm|git\s+(status|log|diff|add|branch)|exit|clear)\b/;
/**
* Extracts a search query from tool input based on tool type.
* Returns null if the tool should be skipped or has no meaningful target.
*/
function extractSearchQuery(toolName, toolInput) {
	switch (toolName) {
		case "Write":
		case "Edit":
		case "Read": {
			const filePath = toolInput.file_path;
			if (!filePath) return null;
			const base = basename(filePath);
			const stem = base.replace(/\.[^.]+$/, "");
			return stem.length >= 2 ? stem : base;
		}
		case "Bash": {
			const command = toolInput.command ?? "";
			if (NOISE_BASH_RE.test(command)) return null;
			const cleaned = command.replace(/^\s*(sudo|bash|sh|env)\s+/, "").replace(/[|><&;]+.*$/, "").trim();
			if (!cleaned || cleaned.length < 3) return null;
			const words = cleaned.split(/\s+/).slice(0, 3).join(" ");
			return words.length >= 3 ? words : null;
		}
		case "Grep": {
			const pattern = toolInput.pattern;
			return pattern && pattern.length >= 2 ? pattern : null;
		}
		case "WebFetch": {
			const url = toolInput.url;
			if (!url) return null;
			try {
				return new URL(url).hostname;
			} catch {
				return null;
			}
		}
		case "WebSearch": return toolInput.query ?? null;
		default: return null;
	}
}
/**
* Formats age of an observation as a human-readable string.
*/
function formatAge(createdAt) {
	const ageMs = Date.now() - new Date(createdAt).getTime();
	const hours = Math.floor(ageMs / 36e5);
	if (hours < 1) return "just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "1d ago";
	return `${days}d ago`;
}
/**
* Truncates text to a max length, adding ellipsis if needed.
*/
function truncate(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max - 3) + "...";
}
/**
* Main PreToolUse handler. Searches observations and graph for context
* relevant to the tool about to execute.
*
* Returns a formatted context string to inject via stdout, or null if
* no relevant context was found.
*/
function handlePreToolUse(input, db, projectHash, pathRepo) {
	const toolName = input.tool_name;
	if (!toolName) return null;
	if (isLaminarksOwnTool(toolName)) return null;
	if (SKIP_TOOLS.has(toolName)) return null;
	const toolInput = input.tool_input ?? {};
	const query = extractSearchQuery(toolName, toolInput);
	if (!query) return null;
	debug("hook", "PreToolUse searching", {
		tool: toolName,
		query
	});
	const lines = [];
	try {
		const results = new SearchEngine(db, projectHash).searchKeyword(query, { limit: 3 });
		for (const result of results) {
			const snippet = result.snippet ? result.snippet.replace(/<\/?mark>/g, "") : truncate(result.observation.content, 120);
			const age = formatAge(result.observation.created_at);
			lines.push(`- ${truncate(snippet, 120)} (${result.observation.source}, ${age})`);
		}
	} catch {
		debug("hook", "PreToolUse FTS5 search failed");
	}
	try {
		if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
			const filePath = toolInput.file_path;
			if (filePath) {
				const node = getNodeByNameAndType(db, filePath, "File");
				if (node) {
					const connected = traverseFrom(db, node.id, {
						depth: 1,
						direction: "both"
					});
					if (connected.length > 0) {
						const names = connected.slice(0, 5).map((r) => `${r.node.name} (${r.node.type})`).join(", ");
						lines.push(`Related: ${names}`);
					}
				}
			}
		}
	} catch {
		debug("hook", "PreToolUse graph lookup failed");
	}
	if (pathRepo) try {
		const toolOutput = toolInput.content ?? toolInput.command ?? query ?? "";
		if (toolOutput.length > 20) {
			const recall = formatPathRecall(findSimilarPaths(pathRepo, toolOutput, 2));
			if (recall) lines.push(recall);
		}
	} catch {
		debug("hook", "PreToolUse path recall failed");
	}
	if (lines.length === 0) return null;
	let target = query;
	if ((toolName === "Write" || toolName === "Edit" || toolName === "Read") && toolInput.file_path) target = basename(toolInput.file_path);
	const output = `[Laminark] Context for ${target}:\n${lines.join("\n")}\n`;
	if (output.length > 500) return output.slice(0, 497) + "...\n";
	return output;
}

//#endregion
//#region src/routing/types.ts
/**
* Default routing configuration values.
* Threshold and rate limits tuned to avoid over-suggestion (Clippy problem).
*/
const DEFAULT_ROUTING_CONFIG = {
	confidenceThreshold: .6,
	maxSuggestionsPerSession: 2,
	minEventsForLearned: 20,
	suggestionCooldown: 5,
	minCallsBeforeFirstSuggestion: 3,
	patternWindowSize: 5
};

//#endregion
//#region src/routing/proactive-suggestions.ts
/**
* Loads a lightweight snapshot of current session context.
* Three small queries, each <3ms on a typical database.
*/
function loadContextSnapshot(db, projectHash, sessionId) {
	let branch = null;
	try {
		const row = db.prepare(`
      SELECT arc_stage, branch_type, observation_count, tool_pattern
      FROM thought_branches
      WHERE project_hash = ? AND session_id = ? AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get(projectHash, sessionId);
		if (row) {
			let toolPattern = {};
			try {
				toolPattern = JSON.parse(row.tool_pattern);
			} catch {}
			branch = {
				arcStage: row.arc_stage,
				branchType: row.branch_type,
				observationCount: row.observation_count,
				toolPattern
			};
		}
	} catch {}
	let debugPath = null;
	try {
		const pathRow = db.prepare(`
      SELECT dp.status,
        (SELECT COUNT(*) FROM path_waypoints pw WHERE pw.path_id = dp.id) AS waypoint_count,
        (SELECT COUNT(*) FROM path_waypoints pw WHERE pw.path_id = dp.id AND pw.waypoint_type = 'error') AS error_count
      FROM debug_paths dp
      WHERE dp.project_hash = ? AND dp.status = 'active'
      ORDER BY dp.started_at DESC LIMIT 1
    `).get(projectHash);
		if (pathRow) debugPath = {
			status: pathRow.status,
			waypointCount: pathRow.waypoint_count,
			errorCount: pathRow.error_count
		};
	} catch {}
	let recentClassifications = [];
	try {
		recentClassifications = db.prepare(`
      SELECT classification FROM observations
      WHERE project_hash = ? AND session_id = ? AND deleted_at IS NULL AND classification IS NOT NULL
      ORDER BY created_at DESC LIMIT 5
    `).all(projectHash, sessionId).map((r) => r.classification);
	} catch {}
	return {
		branch,
		debugPath,
		recentClassifications
	};
}
/**
* Rules map context patterns to keyword categories, NOT tool names.
* The engine then searches the tool registry for matching tools.
*/
const CONTEXT_RULES = [
	{
		id: "debug-session",
		searchKeywords: [
			"debug",
			"error tracking",
			"issue investigation",
			"systematic debugging"
		],
		confidence: .8,
		reason: "Diagnosis stage detected with problems but no active debug path",
		matches(ctx) {
			if (!ctx.branch) return false;
			const inDiagnosis = ctx.branch.arcStage === "diagnosis" || ctx.branch.arcStage === "investigation";
			const hasProblems = ctx.recentClassifications.some((c) => c === "problem" || c === "error");
			const noActivePath = !ctx.debugPath;
			return inDiagnosis && hasProblems && noActivePath;
		}
	},
	{
		id: "planning-needed",
		searchKeywords: [
			"plan",
			"design",
			"architecture",
			"implementation strategy"
		],
		confidence: .7,
		reason: "Investigation phase with 5+ observations suggests planning would help",
		matches(ctx) {
			if (!ctx.branch) return false;
			const inInvestigation = ctx.branch.arcStage === "investigation";
			const enoughObservations = ctx.branch.observationCount >= 5;
			const readTools = (ctx.branch.toolPattern["Read"] ?? 0) + (ctx.branch.toolPattern["Grep"] ?? 0) + (ctx.branch.toolPattern["Glob"] ?? 0);
			const totalTools = Object.values(ctx.branch.toolPattern).reduce((a, b) => a + b, 0);
			const mostlyReads = totalTools > 0 && readTools / totalTools > .6;
			return inInvestigation && enoughObservations && mostlyReads;
		}
	},
	{
		id: "ready-to-commit",
		searchKeywords: [
			"commit",
			"save changes",
			"checkpoint"
		],
		confidence: .75,
		reason: "Execution stage with recent resolutions — good time to commit",
		matches(ctx) {
			if (!ctx.branch) return false;
			const inExecution = ctx.branch.arcStage === "execution";
			const hasResolutions = ctx.recentClassifications.some((c) => c === "resolution" || c === "success");
			const recentSuccesses = ctx.recentClassifications.filter((c) => c === "success" || c === "resolution").length;
			return inExecution && hasResolutions && recentSuccesses >= 2;
		}
	},
	{
		id: "verify-work",
		searchKeywords: [
			"verify",
			"validate",
			"test",
			"acceptance",
			"UAT"
		],
		confidence: .7,
		reason: "Feature branch in verification stage",
		matches(ctx) {
			if (!ctx.branch) return false;
			return ctx.branch.branchType === "feature" && ctx.branch.arcStage === "verification";
		}
	},
	{
		id: "resume-debugging",
		searchKeywords: [
			"debug",
			"continue debugging",
			"resume investigation"
		],
		confidence: .75,
		reason: "Active debug path with multiple errors detected",
		matches(ctx) {
			if (!ctx.branch || !ctx.debugPath) return false;
			const inInvestigation = ctx.branch.arcStage === "investigation" || ctx.branch.arcStage === "diagnosis";
			return ctx.debugPath.status === "active" && inInvestigation && ctx.debugPath.errorCount >= 2;
		}
	},
	{
		id: "check-progress",
		searchKeywords: [
			"progress",
			"status",
			"milestone",
			"overview"
		],
		confidence: .65,
		reason: "Extended execution — consider reviewing progress",
		matches(ctx) {
			if (!ctx.branch) return false;
			return ctx.branch.arcStage === "execution" && ctx.branch.observationCount >= 10;
		}
	}
];
/**
* Searches suggestable tools for the best match against a set of keywords.
* Checks trigger_hints, description, and name for substring matches.
*
* This is a lightweight in-memory scan, not a DB query.
*/
function findMatchingTool(keywords, suggestableTools) {
	let best = null;
	for (const tool of suggestableTools) {
		const searchText = [
			tool.trigger_hints ?? "",
			tool.description ?? "",
			tool.name
		].join(" ").toLowerCase();
		let matchCount = 0;
		for (const keyword of keywords) if (searchText.includes(keyword.toLowerCase())) matchCount++;
		if (matchCount === 0) continue;
		const relevance = matchCount / keywords.length;
		if (!best || relevance > best.relevance) best = {
			tool,
			relevance
		};
	}
	return best;
}
/**
* Evaluates proactive suggestions by matching context rules against available tools.
*
* Returns the highest-confidence match (rule confidence * tool relevance) that
* exceeds the threshold, or null if nothing qualifies.
*/
function evaluateProactiveSuggestions(ctx, suggestableTools, threshold) {
	let bestSuggestion = null;
	let bestScore = 0;
	for (const rule of CONTEXT_RULES) try {
		if (!rule.matches(ctx)) continue;
		const toolMatch = findMatchingTool(rule.searchKeywords, suggestableTools);
		if (!toolMatch) continue;
		const combinedScore = rule.confidence * toolMatch.relevance;
		if (combinedScore > bestScore && combinedScore >= threshold) {
			bestScore = combinedScore;
			bestSuggestion = {
				toolName: toolMatch.tool.name,
				toolDescription: toolMatch.tool.description,
				confidence: combinedScore,
				tier: "proactive",
				reason: rule.reason
			};
		}
	} catch (err) {
		debug("proactive", `Rule ${rule.id} failed`, { error: String(err) });
	}
	return bestSuggestion;
}

//#endregion
//#region src/routing/heuristic-fallback.ts
/**
* Stop words filtered from keyword extraction.
* Common English function words that carry no discriminative signal for tool matching.
*/
const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"and",
	"but",
	"or",
	"nor",
	"not",
	"so",
	"yet",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its"
]);
/**
* Tokenizes text into lowercase keywords for matching.
*
* Replaces non-alphanumeric characters (except hyphens and underscores) with spaces,
* splits on whitespace, filters words shorter than 3 characters and stop words,
* and returns unique keywords.
*/
function extractKeywords(text) {
	const words = text.toLowerCase().replace(/[^a-z0-9\s\-_]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
	return [...new Set(words)];
}
/**
* Extracts keywords from a tool's description, server name, and parsed name.
*
* - Description text is tokenized via extractKeywords
* - Server name is added as a keyword (lowercase)
* - Slash commands are parsed by splitting on `:`, `-`, `_`
* - Skills are parsed by splitting on `-` and `_`
*
* Returns a deduplicated array of keywords.
*/
function extractToolKeywords(tool) {
	const sources = [];
	if (tool.description) sources.push(...extractKeywords(tool.description));
	if (tool.server_name) sources.push(tool.server_name.toLowerCase());
	if (tool.tool_type === "slash_command") {
		const parts = tool.name.replace(/^\//, "").split(/[:\-_]/).filter((p) => p.length > 0);
		sources.push(...parts.map((p) => p.toLowerCase()));
	}
	if (tool.tool_type === "skill") {
		const parts = tool.name.split(/[\-_]/).filter((p) => p.length > 0);
		sources.push(...parts.map((p) => p.toLowerCase()));
	}
	return [...new Set(sources)];
}
/**
* Evaluates heuristic keyword matching between recent observations and available tools.
*
* This is the cold-start routing tier (ROUT-04). It works with zero accumulated usage
* history by matching keywords from recent session observations against tool descriptions
* and names.
*
* Returns the highest-confidence match above the threshold, or null if no match qualifies.
*
* @param recentObservations - Recent observation content strings from the current session
* @param suggestableTools - Scope-filtered, non-builtin, non-Laminark tools
* @param confidenceThreshold - Minimum score to return a suggestion (0.0-1.0)
*/
function evaluateHeuristic(recentObservations, suggestableTools, confidenceThreshold) {
	if (recentObservations.length < 2) return null;
	const contextKeywords = new Set(recentObservations.flatMap((obs) => extractKeywords(obs)));
	if (contextKeywords.size === 0) return null;
	let bestMatch = null;
	for (const tool of suggestableTools) {
		const toolKeywords = extractToolKeywords(tool);
		if (toolKeywords.length === 0) continue;
		const score = toolKeywords.filter((kw) => contextKeywords.has(kw)).length / toolKeywords.length;
		if (score > (bestMatch?.score ?? 0)) bestMatch = {
			tool,
			score
		};
	}
	if (!bestMatch || bestMatch.score < confidenceThreshold) return null;
	return {
		toolName: bestMatch.tool.name,
		toolDescription: bestMatch.tool.description,
		confidence: bestMatch.score,
		tier: "heuristic",
		reason: "Keywords match between current work and tool description"
	};
}

//#endregion
//#region src/routing/conversation-router.ts
/**
* ConversationRouter orchestrates tool suggestion routing.
*
* Combines three tiers of suggestion:
* - Proactive suggestions: context-aware trigger hint matching (ROUT-05)
* - Learned patterns: historical tool sequence matching (ROUT-01)
* - Heuristic fallback: keyword-based cold-start matching (ROUT-04)
*
* Suggestions are gated by confidence threshold (ROUT-03) and rate limits,
* then delivered via NotificationStore (ROUT-02).
*
* Instantiated per-evaluation in the PostToolUse handler. No long-lived state --
* state persists across invocations via the routing_state SQLite table.
*/
var ConversationRouter = class {
	db;
	projectHash;
	config;
	constructor(db, projectHash, config) {
		this.db = db;
		this.projectHash = projectHash;
		this.config = {
			...DEFAULT_ROUTING_CONFIG,
			...config
		};
		db.exec(`
      CREATE TABLE IF NOT EXISTS routing_state (
        session_id TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        suggestions_made INTEGER NOT NULL DEFAULT 0,
        last_suggestion_at TEXT,
        tool_calls_since_suggestion INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, project_hash)
      )
    `);
	}
	/**
	* Evaluates whether a tool suggestion should be surfaced for the current context.
	*
	* Called from PostToolUse handler after observation storage.
	* Runs AFTER the self-referential filter -- never evaluates Laminark's own tools.
	*
	* The entire method is wrapped in try/catch -- routing is supplementary
	* and must NEVER block or fail the core handler pipeline.
	*
	* @param sessionId - Current session identifier
	* @param toolName - The tool just used
	* @param toolRegistry - Tool registry for availability checking
	*/
	evaluate(sessionId, toolName, toolRegistry) {
		try {
			this._evaluate(sessionId, toolName, toolRegistry);
		} catch (err) {
			debug("routing", "Routing evaluation failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
		}
	}
	_evaluate(sessionId, toolName, toolRegistry) {
		if (inferToolType(toolName) === "builtin") return;
		if (isLaminarksOwnTool(toolName)) return;
		const state = this.getOrCreateState(sessionId);
		state.toolCallsSinceSuggestion++;
		this.updateState(sessionId, state);
		if (state.suggestionsMade >= this.config.maxSuggestionsPerSession) {
			debug("routing", "Rate limited: max suggestions reached", {
				sessionId,
				made: state.suggestionsMade
			});
			return;
		}
		if (state.toolCallsSinceSuggestion < this.config.suggestionCooldown) {
			debug("routing", "Rate limited: cooldown active", {
				sessionId,
				callsSince: state.toolCallsSinceSuggestion,
				cooldown: this.config.suggestionCooldown
			});
			return;
		}
		const totalCalls = this.getTotalCallsForSession(sessionId);
		if (totalCalls < this.config.minCallsBeforeFirstSuggestion) {
			debug("routing", "Too early: not enough tool calls", {
				sessionId,
				totalCalls
			});
			return;
		}
		const suggestableTools = toolRegistry.getAvailableForSession(this.projectHash).filter((t) => t.tool_type !== "builtin" && !isLaminarksOwnTool(t.name) && t.status === "active");
		if (suggestableTools.length === 0) return;
		const suggestableNames = new Set(suggestableTools.map((t) => t.name));
		let suggestion = null;
		suggestion = evaluateProactiveSuggestions(loadContextSnapshot(this.db, this.projectHash, sessionId), suggestableTools, this.config.confidenceThreshold);
		if (!suggestion) {
			if (this.countRecentEvents() >= this.config.minEventsForLearned) suggestion = evaluateLearnedPatterns(this.db, sessionId, this.projectHash, suggestableNames, this.config.confidenceThreshold);
		}
		if (!suggestion) suggestion = evaluateHeuristic(this.getRecentObservations(sessionId), suggestableTools, this.config.confidenceThreshold);
		if (!suggestion) return;
		if (suggestion.confidence < this.config.confidenceThreshold) return;
		const notifStore = new NotificationStore(this.db);
		let message;
		if (suggestion.tier === "proactive") message = `[Laminark suggests] ${suggestion.reason} -- try ${suggestion.toolName}`;
		else {
			const description = suggestion.toolDescription ? ` -- ${suggestion.toolDescription}` : "";
			const usageHint = suggestion.tier === "learned" ? ` (${suggestion.reason})` : "";
			message = `Tool suggestion: ${suggestion.toolName}${description}${usageHint}`;
		}
		notifStore.add(this.projectHash, message);
		debug("routing", "Suggestion delivered", {
			tool: suggestion.toolName,
			tier: suggestion.tier,
			confidence: suggestion.confidence
		});
		state.suggestionsMade++;
		state.lastSuggestionAt = (/* @__PURE__ */ new Date()).toISOString();
		state.toolCallsSinceSuggestion = 0;
		this.updateState(sessionId, state);
	}
	/**
	* Gets or creates routing state for a session.
	*/
	getOrCreateState(sessionId) {
		const row = this.db.prepare(`
      SELECT suggestions_made, last_suggestion_at, tool_calls_since_suggestion
      FROM routing_state
      WHERE session_id = ? AND project_hash = ?
    `).get(sessionId, this.projectHash);
		if (row) return {
			suggestionsMade: row.suggestions_made,
			lastSuggestionAt: row.last_suggestion_at,
			toolCallsSinceSuggestion: row.tool_calls_since_suggestion
		};
		this.db.prepare(`
      INSERT INTO routing_state (session_id, project_hash, suggestions_made, tool_calls_since_suggestion)
      VALUES (?, ?, 0, 0)
    `).run(sessionId, this.projectHash);
		return {
			suggestionsMade: 0,
			lastSuggestionAt: null,
			toolCallsSinceSuggestion: 0
		};
	}
	/**
	* Updates routing state in the database.
	*/
	updateState(sessionId, state) {
		this.db.prepare(`
      UPDATE routing_state
      SET suggestions_made = ?, last_suggestion_at = ?, tool_calls_since_suggestion = ?
      WHERE session_id = ? AND project_hash = ?
    `).run(state.suggestionsMade, state.lastSuggestionAt, state.toolCallsSinceSuggestion, sessionId, this.projectHash);
	}
	/**
	* Returns total tool calls for the current session (from routing_state).
	*/
	getTotalCallsForSession(sessionId) {
		return this.db.prepare(`
      SELECT COUNT(*) as count FROM tool_usage_events
      WHERE session_id = ? AND project_hash = ?
    `).get(sessionId, this.projectHash).count;
	}
	/**
	* Counts total tool_usage_events for this project (for learned pattern threshold).
	*/
	countRecentEvents() {
		return this.db.prepare(`
      SELECT COUNT(*) as count FROM tool_usage_events WHERE project_hash = ?
    `).get(this.projectHash).count;
	}
	/**
	* Gets recent observation content strings for heuristic matching.
	*/
	getRecentObservations(sessionId) {
		return this.db.prepare(`
      SELECT content FROM observations
      WHERE project_hash = ? AND session_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 5
    `).all(this.projectHash, sessionId).map((r) => r.content);
	}
};

//#endregion
//#region src/hooks/handler.ts
/**
* Hook handler entry point.
*
* This file is the CLI entry point for all Claude Code hook events.
* It reads stdin JSON, opens a direct SQLite connection (no HTTP intermediary),
* dispatches to the appropriate handler based on hook_event_name, and exits 0.
*
* CRITICAL CONSTRAINTS:
* - Only SessionStart and PreToolUse write to stdout (synchronous hooks -- stdout is injected into Claude's context window)
* - All other hooks NEVER write to stdout (stdout output is interpreted by Claude Code)
* - ALWAYS exits 0 (non-zero exit codes surface as errors to Claude)
* - Opens its own database connection (WAL mode handles concurrent access with MCP server)
* - Imports only storage modules -- NO @modelcontextprotocol/sdk (cold start overhead)
*
* Filter pipeline (PostToolUse/PostToolUseFailure):
*   0. Organic tool discovery (DISC-05: records ALL tools including Laminark's own)
*   1. Self-referential filter (dual-prefix: mcp__laminark__ and mcp__plugin_laminark_laminark__)
*   2. Extract observation text from payload
*   3. Privacy filter: exclude sensitive files, redact secrets
*   4. Admission filter: reject noise content
*   5. Store to database
*/
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}
/**
* Tools that are routed to the research buffer instead of creating observations.
* These are high-volume exploration tools whose individual calls are noise,
* but whose targets provide useful provenance context for subsequent changes.
*/
const RESEARCH_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep"
]);
/**
* Processes a PostToolUse or PostToolUseFailure event through the full
* filter pipeline: route research tools -> extract -> privacy -> admission -> store.
*
* Exported for unit testing of the pipeline logic.
*/
function processPostToolUseFiltered(input, obsRepo, researchBuffer, toolRegistry, projectHash, db) {
	const toolName = input.tool_name;
	const hookEventName = input.hook_event_name;
	if (!toolName) {
		debug("hook", "PostToolUse missing tool_name, skipping");
		return;
	}
	if (toolRegistry) try {
		const sessionId = input.session_id;
		const isFailure = hookEventName === "PostToolUseFailure";
		toolRegistry.recordOrCreate(toolName, {
			toolType: inferToolType(toolName),
			scope: inferScope(toolName),
			source: "hook:PostToolUse",
			projectHash: projectHash ?? null,
			description: null,
			serverName: extractServerName(toolName),
			triggerHints: null
		}, sessionId ?? null, !isFailure);
		if (isFailure) {
			const failures = toolRegistry.getRecentEventsForTool(toolName, projectHash ?? "", 5).filter((e) => e.success === 0).length;
			if (failures >= 3) {
				toolRegistry.markDemoted(toolName, projectHash ?? null);
				debug("hook", "Tool demoted due to failures", {
					tool: toolName,
					failures
				});
			}
		} else toolRegistry.markActive(toolName, projectHash ?? null);
	} catch {}
	if (isLaminarksOwnTool(toolName)) {
		debug("hook", "Skipping self-referential tool", { tool: toolName });
		return;
	}
	const toolInput = input.tool_input ?? {};
	const filePath = toolInput.file_path;
	if (filePath && isExcludedFile(filePath)) {
		debug("hook", "Observation excluded (sensitive file)", {
			tool: toolName,
			filePath
		});
		return;
	}
	if (RESEARCH_TOOLS.has(toolName) && researchBuffer) {
		const target = String(toolInput.file_path ?? toolInput.pattern ?? "");
		researchBuffer.add({
			sessionId: input.session_id ?? null,
			toolName,
			target
		});
		return;
	}
	if (toolName === "Bash" && hookEventName !== "PostToolUseFailure") {
		const command = String(toolInput.command ?? "");
		if (!isMeaningfulBashCommand(command)) {
			debug("hook", "Bash command filtered as navigation", { command: command.slice(0, 60) });
			return;
		}
	}
	const payload = {
		session_id: input.session_id,
		cwd: input.cwd,
		hook_event_name: input.hook_event_name,
		tool_name: toolName,
		tool_input: toolInput,
		tool_response: input.tool_response,
		tool_use_id: input.tool_use_id
	};
	const summary = extractObservation(payload);
	if (summary === null) {
		debug("hook", "No observation extracted", { tool: toolName });
		return;
	}
	let redacted = redactSensitiveContent(summary, filePath);
	if (redacted === null) {
		debug("hook", "Observation excluded by privacy filter", { tool: toolName });
		return;
	}
	if ((toolName === "Write" || toolName === "Edit") && researchBuffer && payload.session_id) {
		const research = researchBuffer.getRecent(payload.session_id, 5);
		if (research.length > 0) {
			const lines = research.map((r) => `  - [${r.toolName}] ${r.target}`).join("\n");
			redacted += `\nResearch context:\n${lines}`;
		}
	}
	if (!shouldAdmit(toolName, redacted)) {
		debug("hook", "Observation rejected by admission filter", { tool: toolName });
		return;
	}
	const decision = new SaveGuard(obsRepo).evaluateSync(redacted, "hook:" + toolName);
	if (!decision.save) {
		debug("hook", "Observation rejected by save guard", {
			tool: toolName,
			reason: decision.reason,
			duplicateOf: decision.duplicateOf
		});
		return;
	}
	let kind = "finding";
	if (toolName === "Write" || toolName === "Edit") kind = "change";
	else if (toolName === "WebFetch" || toolName === "WebSearch") kind = "reference";
	else if (toolName === "Bash") {
		const command = String(toolInput.command ?? "");
		if (/^git\s+(commit|push|merge|rebase|cherry-pick)\b/.test(command.trim())) kind = "change";
		else kind = "verification";
	}
	obsRepo.create({
		content: redacted,
		source: "hook:" + toolName,
		kind,
		sessionId: payload.session_id ?? null
	});
	debug("hook", "Captured observation", {
		tool: toolName,
		kind,
		length: redacted.length
	});
	if (db && toolRegistry && projectHash) try {
		const sessionId = input.session_id;
		if (sessionId) new ConversationRouter(db, projectHash).evaluate(sessionId, toolName, toolRegistry);
	} catch {}
}
async function main() {
	const raw = await readStdin();
	const input = JSON.parse(raw);
	const eventName = input.hook_event_name;
	const cwd = input.cwd;
	if (!eventName || !cwd) {
		debug("hook", "Missing hook_event_name or cwd in input");
		return;
	}
	const projectHash = getProjectHash(cwd);
	debug("hook", "Processing hook event", {
		eventName,
		projectHash
	});
	const laminarkDb = openDatabase(getDatabaseConfig());
	try {
		const obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
		const sessionRepo = new SessionRepository(laminarkDb.db, projectHash);
		let researchBuffer;
		try {
			researchBuffer = new ResearchBufferRepository(laminarkDb.db, projectHash);
		} catch {}
		let toolRegistry;
		try {
			toolRegistry = new ToolRegistryRepository(laminarkDb.db);
		} catch {}
		let pathRepo;
		try {
			initPathSchema(laminarkDb.db);
			pathRepo = new PathRepository(laminarkDb.db, projectHash);
		} catch {}
		let branchRepo;
		try {
			branchRepo = new BranchRepository(laminarkDb.db, projectHash);
		} catch {}
		switch (eventName) {
			case "PreToolUse": {
				const preContext = handlePreToolUse(input, laminarkDb.db, projectHash, pathRepo);
				if (preContext) process.stdout.write(preContext);
				break;
			}
			case "PostToolUse":
			case "PostToolUseFailure":
				processPostToolUseFiltered(input, obsRepo, researchBuffer, toolRegistry, projectHash, laminarkDb.db);
				break;
			case "SessionStart": {
				const context = handleSessionStart(input, sessionRepo, laminarkDb.db, projectHash, toolRegistry, pathRepo, branchRepo);
				if (context) process.stdout.write(context);
				break;
			}
			case "SessionEnd":
				handleSessionEnd(input, sessionRepo);
				break;
			case "Stop":
				handleStop(input, obsRepo, sessionRepo, laminarkDb.db, projectHash);
				break;
			default:
				debug("hook", "Unknown hook event", { eventName });
				break;
		}
	} finally {
		laminarkDb.close();
	}
}
main().catch((err) => {
	debug("hook", "Hook handler error", { error: err.message });
});

//#endregion
export { processPostToolUseFiltered };
//# sourceMappingURL=handler.js.map