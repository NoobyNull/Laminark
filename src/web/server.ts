/**
 * Hono web server for the Laminark visualization UI.
 *
 * Serves static assets from the ui/ directory and registers REST API
 * and SSE route groups. Configured with CORS for localhost development
 * and a health check endpoint.
 *
 * @module web/server
 */

import path from 'path';
import fs from 'fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type BetterSqlite3 from 'better-sqlite3';

type AppEnv = {
  Variables: {
    db: BetterSqlite3.Database;
    defaultProject: string;
  };
};

import { debug } from '../shared/debug.js';
import { apiRoutes } from './routes/api.js';
import { sseRoutes } from './routes/sse.js';
import { adminRoutes } from './routes/admin.js';

/**
 * Creates a configured Hono app with middleware, static serving,
 * and route registration.
 *
 * @param db - better-sqlite3 Database instance for API queries
 * @param uiRoot - Absolute path to the ui/ directory for static file serving
 * @returns Configured Hono app
 */
export function createWebServer(db: BetterSqlite3.Database, uiRoot: string, defaultProjectHash?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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

  // Make db and defaultProject available to all route handlers via Hono context
  app.use('*', async (c, next) => {
    c.set('db', db);
    if (defaultProjectHash) {
      c.set('defaultProject', defaultProjectHash);
    }
    await next();
  });

  // Health check endpoint
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
  });

  // Mount API and SSE routes
  app.route('/api', apiRoutes);
  app.route('/api', sseRoutes);
  app.route('/api/admin', adminRoutes);

  // Serve static files from ui/ directory (absolute path so CWD doesn't matter)
  app.use('/*', async (c, next) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const filePath = path.join(uiRoot, reqPath);
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      return c.body(data, 200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      });
    } catch {
      await next();
    }
  });

  // Fallback: serve index.html for SPA routing
  app.get('*', async (c) => {
    const indexPath = path.join(uiRoot, 'index.html');
    try {
      const data = fs.readFileSync(indexPath, 'utf-8');
      return c.html(data);
    } catch {
      return c.text('UI not found', 404);
    }
  });

  return app;
}

/**
 * Maximum number of alternate ports to try when the primary port is in use.
 */
const MAX_PORT_RETRIES = 10;

/**
 * Starts the Hono web server on the specified port.
 *
 * If the port is already in use (EADDRINUSE), tries incrementing ports up to
 * MAX_PORT_RETRIES times. If all ports fail, logs a warning and continues
 * without the web server -- the MCP server is the primary function and must
 * not be killed by a web server port conflict.
 *
 * @param app - Configured Hono app from createWebServer()
 * @param port - Port number (default: 37820)
 * @returns The Node.js HTTP server instance, or null if all ports failed
 */
export function startWebServer(
  app: Hono<AppEnv>,
  port: number = 37820,
): ReturnType<typeof serve> | null {
  debug('db', `Starting web server on port ${port}`);

  function tryListen(attemptPort: number, retries: number): ReturnType<typeof serve> | null {
    const server = serve({
      fetch: app.fetch,
      port: attemptPort,
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        server.close();
        const nextPort = attemptPort + 1;
        debug('db', `Port ${attemptPort} in use, trying ${nextPort}`);
        tryListen(nextPort, retries - 1);
      } else if (err.code === 'EADDRINUSE') {
        server.close();
        debug('db', `Web server disabled: all ports ${port}-${attemptPort} in use`);
      } else {
        debug('db', `Web server error: ${err.message}`);
      }
    });

    server.on('listening', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : attemptPort;
      debug('db', `Web server listening on http://localhost:${actualPort}`);
    });

    return server;
  }

  return tryListen(port, MAX_PORT_RETRIES);
}
