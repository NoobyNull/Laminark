/**
 * Hono web server for the Laminark visualization UI.
 *
 * Serves static assets from the ui/ directory and registers REST API
 * and SSE route groups. Configured with CORS for localhost development
 * and a health check endpoint.
 *
 * @module web/server
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import { apiRoutes } from './routes/api.js';
import { sseRoutes } from './routes/sse.js';

/**
 * Creates a configured Hono app with middleware, static serving,
 * and route registration.
 *
 * @param db - better-sqlite3 Database instance for API queries
 * @returns Configured Hono app
 */
export function createWebServer(db: BetterSqlite3.Database): Hono {
  const app = new Hono();

  // CORS middleware for localhost development
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return '*';
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          return origin;
        }
        return null as unknown as string;
      },
    }),
  );

  // Make db available to all route handlers via Hono context
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  // Health check endpoint
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
  });

  // Mount API and SSE routes
  app.route('/api', apiRoutes);
  app.route('/api', sseRoutes);

  // Serve static files from ui/ directory
  app.use(
    '/*',
    serveStatic({
      root: './ui/',
    }),
  );

  // Fallback: serve index.html for SPA routing
  app.get('*', serveStatic({ root: './ui/', path: 'index.html' }));

  return app;
}

/**
 * Starts the Hono web server on the specified port.
 *
 * @param app - Configured Hono app from createWebServer()
 * @param port - Port number (default: 37820)
 * @returns The Node.js HTTP server instance
 */
export function startWebServer(
  app: Hono,
  port: number = 37820,
): ReturnType<typeof serve> {
  debug('db', `Starting web server on port ${port}`);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  debug('db', `Web server listening on http://localhost:${port}`);

  return server;
}
