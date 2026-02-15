import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

//#region src/shared/config.ts
/**
* Cached debug-enabled flag.
* Resolved once per process -- debug mode does not change at runtime.
*/
let _debugCached = null;
/**
* Returns whether debug logging is enabled for this process.
*
* Resolution order:
* 1. `LAMINARK_DEBUG` env var -- `"1"` or `"true"` enables debug mode
* 2. `~/.laminark/config.json` -- `{ "debug": true }` enables debug mode
* 3. Default: disabled
*
* The result is cached after the first call.
*/
function isDebugEnabled() {
	if (_debugCached !== null) return _debugCached;
	const envVal = process.env.LAMINARK_DEBUG;
	if (envVal === "1" || envVal === "true") {
		_debugCached = true;
		return true;
	}
	try {
		const raw = readFileSync(join(getConfigDir(), "config.json"), "utf-8");
		if (JSON.parse(raw).debug === true) {
			_debugCached = true;
			return true;
		}
	} catch {}
	_debugCached = false;
	return false;
}
/**
* Default busy timeout in milliseconds.
* Must be >= 5000ms to prevent SQLITE_BUSY under concurrent load.
* Source: SQLite docs + better-sqlite3 performance recommendations.
*/
const DEFAULT_BUSY_TIMEOUT = 5e3;
/**
* Returns the Laminark data directory.
* Default: ~/.claude/plugins/cache/laminark/data/
* Creates the directory recursively if it does not exist.
*
* Supports LAMINARK_DATA_DIR env var override for testing --
* redirects all data storage to a custom directory without
* affecting the real plugin data.
*/
function getConfigDir() {
	const dir = process.env.LAMINARK_DATA_DIR || join(homedir(), ".claude", "plugins", "cache", "laminark", "data");
	mkdirSync(dir, { recursive: true });
	return dir;
}
/**
* Returns the path to the single Laminark database file.
* Single database at ~/.claude/plugins/cache/laminark/data/data.db for ALL projects.
*/
function getDbPath() {
	return join(getConfigDir(), "data.db");
}
/**
* Creates a deterministic SHA-256 hash of a project directory path.
* Uses realpathSync to canonicalize (resolves symlinks) to prevent
* multiple hashes for the same directory via different paths.
*
* @param projectDir - The project directory path to hash
* @returns First 16 hex characters of the SHA-256 hash
*/
function getProjectHash(projectDir) {
	const canonical = realpathSync(resolve(projectDir));
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
/**
* Returns the default database configuration.
*/
function getDatabaseConfig() {
	return {
		dbPath: getDbPath(),
		busyTimeout: DEFAULT_BUSY_TIMEOUT
	};
}

//#endregion
export { isDebugEnabled as a, getProjectHash as i, getDatabaseConfig as n, getDbPath as r, getConfigDir as t };
//# sourceMappingURL=config-t8LZeB-u.mjs.map