/**
 * Server-Sent Events endpoint for live updates.
 *
 * Maintains a set of connected SSE clients and provides a broadcast
 * function for pushing real-time events to all connected browsers.
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

import { Hono } from 'hono';
import type { Context } from 'hono';
import { debug } from '../../shared/debug.js';

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const clients = new Set<SSEClient>();

let clientIdCounter = 0;

// ---------------------------------------------------------------------------
// SSE formatting helpers
// ---------------------------------------------------------------------------

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function sendToClient(client: SSEClient, event: string, data: string): boolean {
  try {
    const message = formatSSE(event, data);
    client.controller.enqueue(new TextEncoder().encode(message));
    return true;
  } catch {
    // Client disconnected or stream errored
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route group
// ---------------------------------------------------------------------------

export const sseRoutes = new Hono();

/**
 * GET /api/sse
 *
 * Server-Sent Events endpoint. Keeps the connection alive with heartbeats
 * and receives broadcast events for live UI updates.
 */
sseRoutes.get('/sse', (c: Context) => {
  const clientId = String(++clientIdCounter);

  let client: SSEClient;

  const stream = new ReadableStream({
    start(controller) {
      // Create client with heartbeat
      const heartbeatTimer = setInterval(() => {
        const ok = sendToClient(client, 'heartbeat', JSON.stringify({ timestamp: Date.now() }));
        if (!ok) {
          clearInterval(heartbeatTimer);
          clients.delete(client);
          debug('db', 'SSE client heartbeat failed, removed', { clientId });
        }
      }, 30_000);

      client = { id: clientId, controller, heartbeatTimer };
      clients.add(client);

      debug('db', 'SSE client connected', { clientId, total: clients.size });

      // Send initial connected event
      sendToClient(client, 'connected', JSON.stringify({
        timestamp: Date.now(),
        clientId,
      }));
    },
    cancel() {
      // Client disconnected
      if (client) {
        clearInterval(client.heartbeatTimer);
        clients.delete(client);
        debug('db', 'SSE client disconnected', { clientId, total: clients.size });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if proxied
    },
  });
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * Broadcasts an event to all connected SSE clients.
 *
 * Automatically removes disconnected clients that fail to receive
 * the message.
 *
 * @param event - Event name (e.g., 'new_observation', 'topic_shift')
 * @param data - Data object to serialize as JSON
 */
export function broadcast(event: string, data: object): void {
  if (clients.size === 0) return;

  const json = JSON.stringify(data);
  const dead: SSEClient[] = [];

  for (const client of clients) {
    const ok = sendToClient(client, event, json);
    if (!ok) {
      dead.push(client);
    }
  }

  // Clean up dead clients
  for (const client of dead) {
    clearInterval(client.heartbeatTimer);
    clients.delete(client);
  }

  if (dead.length > 0) {
    debug('db', 'SSE broadcast cleaned dead clients', { dead: dead.length, remaining: clients.size });
  }
}

/**
 * Returns the current number of connected SSE clients.
 * Useful for health/stats endpoints.
 */
export function getClientCount(): number {
  return clients.size;
}
