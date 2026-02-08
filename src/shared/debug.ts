import { isDebugEnabled } from './config.js';

/**
 * Internal cached state for debug mode.
 * Resolved on first call and never changes (debug mode is process-lifetime).
 */
let _enabled: boolean | null = null;

function enabled(): boolean {
  if (_enabled === null) {
    _enabled = isDebugEnabled();
  }
  return _enabled;
}

/**
 * Logs a debug message to stderr when debug mode is active.
 *
 * When debug is disabled (the default), this is a near-zero-cost no-op after the
 * first call -- the cached flag short-circuits immediately.
 *
 * Format: `[ISO_TIMESTAMP] [LAMINARK:category] message {json_data}`
 *
 * @param category - Debug category (e.g., 'db', 'obs', 'search', 'session')
 * @param message - Human-readable log message
 * @param data - Optional structured data to include (keep lightweight -- no large payloads)
 */
export function debug(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled()) {
    return;
  }

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [LAMINARK:${category}] ${message}`;
  if (data !== undefined) {
    line += ` ${JSON.stringify(data)}`;
  }
  process.stderr.write(line + '\n');
}

/**
 * Wraps a synchronous function with timing instrumentation.
 *
 * When debug is disabled, calls `fn()` directly with zero overhead --
 * no timing measurement, no wrapping.
 *
 * @param category - Debug category for the log line
 * @param message - Description of the operation being timed
 * @param fn - Synchronous function to execute and time
 * @returns The return value of `fn()`
 */
export function debugTimed<T>(
  category: string,
  message: string,
  fn: () => T,
): T {
  if (!enabled()) {
    return fn();
  }

  const start = performance.now();
  const result = fn();
  const duration = (performance.now() - start).toFixed(2);
  debug(category, `${message} (${duration}ms)`);
  return result;
}
