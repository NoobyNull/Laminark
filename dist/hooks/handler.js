import { i as getProjectHash, n as getDatabaseConfig } from "../config-CtH17VYQ.mjs";
import { a as rowToObservation, i as ObservationRepository, l as debug, o as openDatabase, r as SessionRepository, t as SaveGuard } from "../save-guard-DjH8DWnb.mjs";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

//#region src/hooks/capture.ts
/**
* Truncates a string to maxLength, appending '...' if truncated.
*/
function truncate$1(text, maxLength) {
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
		case "Write": return `[Write] Created ${tool_input.file_path}\n${truncate$1(String(tool_input.content ?? ""), 200)}`;
		case "Edit": return `[Edit] Modified ${tool_input.file_path}: replaced "${truncate$1(String(tool_input.old_string ?? ""), 80)}" with "${truncate$1(String(tool_input.new_string ?? ""), 80)}"`;
		case "Bash": return `[Bash] $ ${truncate$1(String(tool_input.command ?? ""), 100)}\n${truncate$1(JSON.stringify(tool_response ?? ""), 200)}`;
		case "Read": return `[Read] ${tool_input.file_path}`;
		case "Glob":
		case "Grep": return `[${tool_name}] pattern=${tool_input.pattern ?? ""} in ${tool_input.path ?? "cwd"}`;
		default: return `[${tool_name}] ${truncate$1(JSON.stringify(tool_input), 200)}`;
	}
}

//#endregion
//#region src/curation/summarizer.ts
/** Matches file paths like src/foo/bar.ts, ./config.json, /etc/hosts */
const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?=[\s"'`),;:]|$)/g;
/** Keywords indicating a decision or choice was made */
const DECISION_KEYWORDS = [
	"decided",
	"chose",
	"will use",
	"going with",
	"selected",
	"opted for",
	"switching to",
	"prefer"
];
/** Keywords indicating a problem was encountered */
const PROBLEM_KEYWORDS = [
	"error",
	"failed",
	"bug",
	"issue",
	"fix",
	"broken",
	"crash",
	"wrong",
	"missing",
	"undefined"
];
/** Keywords indicating a solution was applied */
const SOLUTION_KEYWORDS = [
	"fixed",
	"resolved",
	"solved",
	"working now",
	"corrected",
	"patched",
	"addressed"
];
/**
* Extracts unique file paths from observation content.
* Filters out common false positives like version numbers (e.g., "v1.0").
*/
function extractFilePaths(observations) {
	const paths = /* @__PURE__ */ new Set();
	const falsePositiveRe = /^[vV]?\d+\.\d/;
	for (const obs of observations) {
		const text = obs.content;
		let match;
		FILE_PATH_RE.lastIndex = 0;
		while ((match = FILE_PATH_RE.exec(text)) !== null) {
			const path = match[1];
			if (path.length > 3 && !falsePositiveRe.test(path)) paths.add(path);
		}
	}
	return Array.from(paths).slice(0, 15);
}
/**
* Extracts observations that contain decision-related keywords.
* Returns the first sentence or first 120 characters of matching content.
*/
function extractDecisions(observations) {
	const decisions = [];
	for (const obs of observations) {
		const lower = obs.content.toLowerCase();
		if (DECISION_KEYWORDS.some((kw) => lower.includes(kw))) {
			const firstSentence = obs.content.split(/[.!?\n]/)[0].trim();
			const snippet = firstSentence.length > 120 ? firstSentence.slice(0, 117) + "..." : firstSentence;
			if (snippet.length > 5) decisions.push(snippet);
		}
	}
	return decisions.slice(0, 8);
}
/**
* Extracts key activities from observations by summarizing tool usage
* and notable actions. Prioritizes: explicit saves > problems/solutions > tool actions.
*/
function extractKeyActivities(observations) {
	const activities = [];
	const seen = /* @__PURE__ */ new Set();
	for (const obs of observations) {
		const lower = obs.content.toLowerCase();
		const isProblem = PROBLEM_KEYWORDS.some((kw) => lower.includes(kw));
		const isSolution = SOLUTION_KEYWORDS.some((kw) => lower.includes(kw));
		let label = null;
		if (isSolution) label = "Resolved";
		else if (isProblem) label = "Issue";
		else if (obs.source.startsWith("mcp:")) label = "Saved";
		else label = "Action";
		const firstLine = obs.content.split("\n")[0].trim();
		const snippet = firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;
		if (snippet.length > 5 && !seen.has(snippet)) {
			seen.add(snippet);
			activities.push(`[${label}] ${snippet}`);
		}
	}
	return activities.slice(0, 10);
}
/**
* Compresses an array of session observations into a structured text summary.
*
* This is a deterministic heuristic summarizer -- no LLM call. It extracts:
* - Key activities (significant actions, max 10)
* - Decisions and insights (keyword-matched, max 8)
* - File paths mentioned (regex-extracted, max 15)
*
* Target output: under 500 tokens (~2000 characters).
* If the raw extraction exceeds this budget, sections are truncated by priority:
* decisions > activities > files.
*/
function compressObservations(observations) {
	if (observations.length === 0) return "";
	const activities = extractKeyActivities(observations);
	const decisions = extractDecisions(observations);
	const filePaths = extractFilePaths(observations);
	const sections = [];
	sections.push("## Session Summary");
	const sorted = [...observations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const startedAt = sorted[0].createdAt;
	const endedAt = sorted[sorted.length - 1].createdAt;
	sections.push(`**Duration:** ${startedAt} to ${endedAt}`);
	sections.push(`**Observations:** ${observations.length}`);
	if (activities.length > 0) {
		sections.push("");
		sections.push("### Key Activities");
		for (const activity of activities) sections.push(`- ${activity}`);
	}
	if (decisions.length > 0) {
		sections.push("");
		sections.push("### Decisions & Insights");
		for (const decision of decisions) sections.push(`- ${decision}`);
	}
	if (filePaths.length > 0) {
		sections.push("");
		sections.push("### Files Touched");
		for (const fp of filePaths) sections.push(`- ${fp}`);
	}
	let result = sections.join("\n");
	if (result.length > 2e3) {
		const trimmedFilePaths = filePaths.slice(0, 5);
		const trimmedActivities = activities.slice(0, 5);
		const trimSections = [];
		trimSections.push("## Session Summary");
		trimSections.push(`**Duration:** ${startedAt} to ${endedAt}`);
		trimSections.push(`**Observations:** ${observations.length}`);
		if (trimmedActivities.length > 0) {
			trimSections.push("");
			trimSections.push("### Key Activities");
			for (const activity of trimmedActivities) trimSections.push(`- ${activity}`);
		}
		if (decisions.length > 0) {
			trimSections.push("");
			trimSections.push("### Decisions & Insights");
			for (const decision of decisions.slice(0, 5)) trimSections.push(`- ${decision}`);
		}
		if (trimmedFilePaths.length > 0) {
			trimSections.push("");
			trimSections.push("### Files Touched");
			for (const fp of trimmedFilePaths) trimSections.push(`- ${fp}`);
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
function truncate(text, maxLen) {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLen) return normalized;
	return normalized.slice(0, maxLen) + "...";
}
/**
* Formats the context using progressive disclosure.
*
* Produces a compact index suitable for Claude's context window:
* - Last session summary (if available)
* - Recent observation index with truncated content and IDs for drill-down
*
* @param lastSession - The most recent completed session (with summary), or null
* @param recentObservations - Recent high-value observations
* @returns Formatted context string
*/
function formatContextIndex(lastSession, recentObservations) {
	if (!lastSession && recentObservations.length === 0) return WELCOME_MESSAGE;
	const lines = ["[Laminark Context - Session Recovery]", ""];
	if (lastSession && lastSession.summary) {
		const timeRange = lastSession.endedAt ? `${lastSession.startedAt} to ${lastSession.endedAt}` : lastSession.startedAt;
		lines.push(`## Last Session (${timeRange})`);
		lines.push(lastSession.summary);
		lines.push("");
	}
	if (recentObservations.length > 0) {
		lines.push("## Recent Memories (use search tool for full details)");
		for (const obs of recentObservations) {
			const shortId = obs.id.slice(0, 8);
			const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
			const relTime = formatRelativeTime(obs.createdAt);
			lines.push(`- [${shortId}] ${content} (source: ${obs.source}, ${relTime})`);
		}
	}
	return lines.join("\n");
}
/**
* Queries recent high-value observations for context injection.
*
* Priority ordering:
* 1. Observations from source "mcp:save_memory" (user explicitly saved)
* 2. Observations from source "slash:remember" (user explicitly saved via slash command)
* 3. Most recent observations regardless of source
*
* Excludes deleted observations. Scoped to projectHash.
*
* @param db - better-sqlite3 database connection
* @param projectHash - Project scope identifier
* @param limit - Maximum observations to return (default 5)
* @returns Array of high-value observations
*/
function getHighValueObservations(db, projectHash, limit = 5) {
	debug("context", "Querying high-value observations", {
		projectHash,
		limit
	});
	const rows = db.prepare(`SELECT * FROM observations
       WHERE project_hash = ? AND deleted_at IS NULL
         AND classification IS NOT NULL AND classification != 'noise'
       ORDER BY
         CASE
           WHEN source = 'mcp:save_memory' THEN 0
           WHEN source = 'slash:remember' THEN 0
           ELSE 1
         END ASC,
         created_at DESC,
         rowid DESC
       LIMIT ?`).all(projectHash, limit);
	debug("context", "High-value observations retrieved", { count: rows.length });
	return rows.map(rowToObservation);
}
/**
* Gets the most recent completed session with a non-null summary.
*
* @param db - better-sqlite3 database connection
* @param projectHash - Project scope identifier
* @returns The last session with a summary, or null
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
* Assembles the complete context string for SessionStart injection.
*
* This is the main entry point for context injection. It queries the database
* for the last completed session summary and recent high-value observations,
* then formats them into a compact progressive disclosure index.
*
* Performance: All queries are synchronous (better-sqlite3). Expected execution
* time is under 100ms (2-3 simple SELECT queries on indexed columns).
*
* Token budget: Total output stays under 2000 tokens (~6000 characters).
* If content exceeds budget, observations are trimmed (session summary preserved).
*
* @param db - better-sqlite3 database connection
* @param projectHash - Project scope identifier
* @returns Formatted context string for injection into Claude's context window
*/
function assembleSessionContext(db, projectHash) {
	debug("context", "Assembling session context", { projectHash });
	const lastSession = getLastCompletedSession(db, projectHash);
	const observations = getHighValueObservations(db, projectHash, 5);
	let context = formatContextIndex(lastSession, observations);
	if (context.length > MAX_CONTEXT_CHARS) {
		debug("context", "Context exceeds budget, trimming observations", {
			length: context.length,
			budget: MAX_CONTEXT_CHARS
		});
		let trimmedObs = observations.slice();
		while (trimmedObs.length > 0 && context.length > MAX_CONTEXT_CHARS) {
			trimmedObs = trimmedObs.slice(0, -1);
			context = formatContextIndex(lastSession, trimmedObs);
		}
	}
	debug("context", "Session context assembled", { length: context.length });
	return context;
}

//#endregion
//#region src/hooks/session-lifecycle.ts
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
function handleSessionStart(input, sessionRepo, db, projectHash) {
	const sessionId = input.session_id;
	if (!sessionId) {
		debug("session", "SessionStart missing session_id, skipping");
		return null;
	}
	sessionRepo.create(sessionId);
	debug("session", "Session started", { sessionId });
	const startTime = Date.now();
	const context = assembleSessionContext(db, projectHash);
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
	return context;
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
function handleStop(input, obsRepo, sessionRepo) {
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
//#region src/hooks/noise-patterns.ts
/**
* Noise pattern definitions by category.
*
* These patterns identify low-signal content that should be rejected
* by the admission filter before database storage.
*/
/**
* Noise pattern categories with detection regexes.
*
* Each category groups patterns for a specific type of noise.
* Patterns are case-insensitive where appropriate.
*/
const NOISE_PATTERNS = {
	BUILD_OUTPUT: [
		/npm WARN/i,
		/npm ERR/i,
		/Successfully compiled/i,
		/webpack compiled/i,
		/error TS\d+/i,
		/Build completed/i,
		/Compiling\b/i,
		/Module not found/i
	],
	PACKAGE_INSTALL: [
		/added \d+ packages?/i,
		/npm install/i,
		/up to date/i,
		/removed \d+ packages?/i,
		/audited \d+ packages?/i
	],
	LINTER_WARNING: [
		/eslint/i,
		/prettier/i,
		/\d+ problems?\s*\(/i,
		/(?:.*\bwarning\b.*[\n]?){3,}/i
	],
	EMPTY_OUTPUT: [/^(OK|Success|Done|undefined|null)?\s*$/is]
};
/**
* Checks whether the given content matches any noise pattern category.
*
* @param content - The text content to check
* @returns Object with `isNoise` flag and optional `category` name
*/
function isNoise(content) {
	for (const pattern of NOISE_PATTERNS.EMPTY_OUTPUT) if (pattern.test(content)) return {
		isNoise: true,
		category: "EMPTY_OUTPUT"
	};
	for (const [category, patterns] of Object.entries(NOISE_PATTERNS)) {
		if (category === "EMPTY_OUTPUT") continue;
		for (const pattern of patterns) if (pattern.test(content)) return {
			isNoise: true,
			category
		};
	}
	return { isNoise: false };
}

//#endregion
//#region src/hooks/admission-filter.ts
/**
* Tools that are always admitted regardless of content.
*
* Write and Edit observations are high-signal by definition --
* they represent intentional code changes. Content pattern matching
* must NEVER reject these tools (see research pitfall #3).
*/
const HIGH_SIGNAL_TOOLS = new Set(["Write", "Edit"]);
/**
* Prefix for Laminark's own MCP tools.
* Self-referential observations are noise -- Laminark should not
* observe its own operations.
*/
const LAMINARK_MCP_PREFIX = "mcp__laminark__";
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
	if (toolName.startsWith(LAMINARK_MCP_PREFIX)) {
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
	const noiseResult = isNoise(content);
	if (noiseResult.isNoise) {
		debug("hook", "Observation rejected", {
			tool: toolName,
			reason: "noise",
			category: noiseResult.category
		});
		return false;
	}
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
//#region src/hooks/handler.ts
/**
* Hook handler entry point.
*
* This file is the CLI entry point for all Claude Code hook events.
* It reads stdin JSON, opens a direct SQLite connection (no HTTP intermediary),
* dispatches to the appropriate handler based on hook_event_name, and exits 0.
*
* CRITICAL CONSTRAINTS:
* - Only SessionStart writes to stdout (synchronous hook -- stdout is injected into Claude's context window)
* - All other hooks NEVER write to stdout (stdout output is interpreted by Claude Code)
* - ALWAYS exits 0 (non-zero exit codes surface as errors to Claude)
* - Opens its own database connection (WAL mode handles concurrent access with MCP server)
* - Imports only storage modules -- NO @modelcontextprotocol/sdk (cold start overhead)
*
* Filter pipeline (PostToolUse/PostToolUseFailure):
*   1. Self-referential filter (mcp__laminark__ prefix)
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
* Processes a PostToolUse or PostToolUseFailure event through the full
* filter pipeline: extract -> privacy -> admission -> store.
*
* Exported for unit testing of the pipeline logic.
*/
function processPostToolUseFiltered(input, obsRepo) {
	const toolName = input.tool_name;
	if (!toolName) {
		debug("hook", "PostToolUse missing tool_name, skipping");
		return;
	}
	if (toolName.startsWith("mcp__laminark__")) {
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
	const redacted = redactSensitiveContent(summary, filePath);
	if (redacted === null) {
		debug("hook", "Observation excluded by privacy filter", { tool: toolName });
		return;
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
	obsRepo.create({
		content: redacted,
		source: "hook:" + toolName,
		sessionId: payload.session_id ?? null
	});
	debug("hook", "Captured observation", {
		tool: toolName,
		length: redacted.length
	});
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
		switch (eventName) {
			case "PostToolUse":
			case "PostToolUseFailure":
				processPostToolUseFiltered(input, obsRepo);
				break;
			case "SessionStart": {
				const context = handleSessionStart(input, sessionRepo, laminarkDb.db, projectHash);
				if (context) process.stdout.write(context);
				break;
			}
			case "SessionEnd":
				handleSessionEnd(input, sessionRepo);
				break;
			case "Stop":
				handleStop(input, obsRepo, sessionRepo);
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