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
// Event ID counter and ring buffer for replay
// ---------------------------------------------------------------------------

let lastEventId = 0;

interface BufferedEvent {
  id: number;
  event: string;
  data: string;
}

const RING_BUFFER_SIZE = 100;
const eventRingBuffer: BufferedEvent[] = [];

/**
 * Adds an event to the ring buffer, evicting the oldest if full.
 */
function pushToRingBuffer(entry: BufferedEvent): void {
  if (eventRingBuffer.length >= RING_BUFFER_SIZE) {
    eventRingBuffer.shift();
  }
  eventRingBuffer.push(entry);
}

/**
 * Returns all events with id > sinceId from the ring buffer.
 */
function getEventsSince(sinceId: number): BufferedEvent[] {
  return eventRingBuffer.filter((e) => e.id > sinceId);
}

// ---------------------------------------------------------------------------
// SSE formatting helpers
// ---------------------------------------------------------------------------

function formatSSE(event: string, data: string, id?: number): string {
  let msg = '';
  if (id !== undefined) {
    msg += `id: ${id}\n`;
  }
  msg += `event: ${event}\ndata: ${data}\n\n`;
  return msg;
}

function sendToClient(client: SSEClient, event: string, data: string, id?: number): boolean {
  try {
    const message = formatSSE(event, data, id);
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
 *
 * Supports Last-Event-ID header for replay of missed events on reconnection.
 */
sseRoutes.get('/sse', (c: Context) => {
  const clientId = String(++clientIdCounter);
  const lastEventIdHeader = c.req.header('Last-Event-ID');
  const replayFromId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

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

      // Replay missed events if client is reconnecting with Last-Event-ID
      if (replayFromId > 0) {
        const missed = getEventsSince(replayFromId);
        for (const entry of missed) {
          sendToClient(client, entry.event, entry.data, entry.id);
        }
        if (missed.length > 0) {
          debug('db', 'SSE replayed missed events', { clientId, count: missed.length, sinceId: replayFromId });
        }
      }
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
export function broadcast(event: string, data: object): void {
  const eventId = ++lastEventId;
  const json = JSON.stringify(data);

  // Store in ring buffer for replay
  pushToRingBuffer({ id: eventId, event, data: json });

  if (clients.size === 0) return;

  const dead: SSEClient[] = [];

  for (const client of clients) {
    const ok = sendToClient(client, event, json, eventId);
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
