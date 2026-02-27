/**
 * Update-available notification for Laminark.
 *
 * Checks the npm registry for a newer version and queues a notification
 * if one is found. All errors are silently caught — this is fire-and-forget.
 *
 * @module mcp/version-check
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { debug } from '../shared/debug.js';
import type { NotificationStore } from '../storage/notifications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the installed version from plugin.json (canonical source for plugin version). */
export function getInstalledVersion(): string {
  try {
    const pluginJson = JSON.parse(
      readFileSync(join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    return pluginJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Simple semver comparison: returns true if `a` is strictly less than `b`. */
function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

/**
 * Fire-and-forget update check. Queries the npm registry and queues a
 * notification via the store if a newer version is available.
 */
export async function checkForUpdate(
  store: NotificationStore,
  projectHash: string,
): Promise<void> {
  try {
    const installed = getInstalledVersion();
    if (installed === 'unknown') {
      debug('mcp', 'Version check skipped: could not read installed version');
      return;
    }

    const res = await fetch('https://registry.npmjs.org/laminark/latest', {
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      debug('mcp', `Version check: registry returned ${res.status}`);
      return;
    }

    const data = (await res.json()) as { version?: string };
    const latest = data.version;

    if (!latest) {
      debug('mcp', 'Version check: no version field in registry response');
      return;
    }

    if (isOlder(installed, latest)) {
      debug('mcp', `Update available: ${installed} -> ${latest}`);
      store.add(
        projectHash,
        `Update available: v${installed} → v${latest}. Run: npx laminark@latest update`,
      );
    } else {
      debug('mcp', `Version check: up to date (${installed})`);
    }
  } catch (err) {
    debug('mcp', 'Version check failed', { error: (err as Error).message });
  }
}
