/**
 * Server-Sent Events endpoint for live updates.
 *
 * Maintains a set of connected SSE clients and provides a broadcast
 * function for pushing real-time events to all connected browsers.
 *
 * @module web/routes/sse
 */

import { Hono } from 'hono';

export const sseRoutes = new Hono();

/**
 * Broadcasts an event to all connected SSE clients.
 *
 * @param event - Event name (e.g., 'new_observation', 'topic_shift')
 * @param data - Data object to serialize as JSON
 */
export function broadcast(_event: string, _data: object): void {
  // Will be implemented in Task 2
}
