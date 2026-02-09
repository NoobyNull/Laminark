/**
 * Main-thread bridge for the embedding worker.
 *
 * AnalysisWorker provides a Promise-based API (embed/embedBatch) that sends
 * messages to the worker thread and resolves when results arrive. All methods
 * degrade gracefully -- returning null on error/timeout rather than throwing.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { debug } from '../shared/debug.js';

/** Timeout for worker startup (model loading). */
const STARTUP_TIMEOUT_MS = 30_000;

/** Timeout for individual embed requests. */
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyMessage {
  type: 'ready';
  engineName: string;
  dimensions: number;
}

interface EmbedResultMessage {
  type: 'embed_result';
  id: string;
  embedding: Float32Array | null;
}

interface EmbedBatchResultMessage {
  type: 'embed_batch_result';
  id: string;
  embeddings: (Float32Array | null)[];
}

type WorkerResponse = ReadyMessage | EmbedResultMessage | EmbedBatchResultMessage;

/**
 * Main-thread API for sending embed requests to the worker thread.
 *
 * Usage:
 * ```ts
 * const worker = new AnalysisWorker();
 * await worker.start();
 * const embedding = await worker.embed("some text");
 * await worker.shutdown();
 * ```
 */
export class AnalysisWorker {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest<unknown>>();
  private nextId = 0;
  private ready = false;
  private engineName = 'unknown';
  private dimensions = 0;
  private workerPath: string;

  constructor(workerPath?: string) {
    if (workerPath) {
      this.workerPath = workerPath;
    } else {
      // Resolve worker.js relative to this file's location in dist/
      const thisDir = dirname(fileURLToPath(import.meta.url));
      this.workerPath = join(thisDir, 'worker.js');
    }
  }

  /**
   * Starts the worker thread and waits for the 'ready' message.
   *
   * Resolves once the worker reports its engine name and dimensions.
   * Times out after 30 seconds if the worker never becomes ready.
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        debug('embed', 'Worker startup timed out');
        this.ready = false;
        reject(new Error('Worker startup timed out'));
      }, STARTUP_TIMEOUT_MS);

      try {
        this.worker = new Worker(this.workerPath);
      } catch (err) {
        clearTimeout(timer);
        debug('embed', 'Failed to create worker', { error: String(err) });
        reject(err);
        return;
      }

      // One-time handler for the ready message
      const onReady = (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.ready = true;
          this.engineName = msg.engineName;
          this.dimensions = msg.dimensions;
          debug('embed', 'Worker ready', { engineName: msg.engineName, dimensions: msg.dimensions });

          // Switch to the permanent message handler
          this.worker!.off('message', onReady);
          this.worker!.on('message', (m: WorkerResponse) => this.handleMessage(m));
          resolve();
        }
      };

      this.worker.on('message', onReady);

      this.worker.on('error', (err) => {
        clearTimeout(timer);
        debug('embed', 'Worker error', { error: String(err) });
        this.resolveAllPending();
        this.ready = false;
      });

      this.worker.on('exit', (code) => {
        debug('embed', 'Worker exited', { code });
        this.resolveAllPending();
        this.ready = false;
        this.worker = null;
      });
    });
  }

  /**
   * Embeds a single text string via the worker thread.
   *
   * Returns null if the worker is not ready, not started, or if the
   * request times out.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.worker || !this.ready) {
      return null;
    }

    const id = String(this.nextId++);

    return new Promise<Float32Array | null>((resolve) => {
      const timer = setTimeout(() => {
        debug('embed', 'Embed request timed out', { id });
        this.pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, timer });
      this.worker!.postMessage({ type: 'embed', id, text });
    });
  }

  /**
   * Embeds multiple texts via the worker thread.
   *
   * Returns an array of nulls if the worker is not ready or times out.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.worker || !this.ready) {
      return texts.map(() => null);
    }

    const id = String(this.nextId++);

    return new Promise<(Float32Array | null)[]>((resolve) => {
      const timer = setTimeout(() => {
        debug('embed', 'Batch embed request timed out', { id });
        this.pending.delete(id);
        resolve(texts.map(() => null));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, timer });
      this.worker!.postMessage({ type: 'embed_batch', id, texts });
    });
  }

  /**
   * Sends a shutdown message and waits for the worker to exit.
   */
  async shutdown(): Promise<void> {
    if (!this.worker) {
      return;
    }

    return new Promise<void>((resolve) => {
      const w = this.worker!;
      w.once('exit', () => {
        this.worker = null;
        this.ready = false;
        this.resolveAllPending();
        resolve();
      });

      w.postMessage({ type: 'shutdown' });

      // Safety timeout -- force terminate if shutdown hangs
      setTimeout(() => {
        if (this.worker) {
          debug('embed', 'Worker shutdown timed out, terminating');
          this.worker.terminate();
        }
      }, 5_000);
    });
  }

  /** Whether the worker is started and ready. */
  isReady(): boolean {
    return this.ready;
  }

  /** The engine name reported by the worker. */
  getEngineName(): string {
    return this.engineName;
  }

  /** The embedding dimensions reported by the worker. */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Dispatches worker responses to the correct pending promise.
   */
  private handleMessage(msg: WorkerResponse): void {
    if (msg.type === 'embed_result' || msg.type === 'embed_batch_result') {
      const id = msg.id;
      const req = this.pending.get(id);

      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(id);

        if (msg.type === 'embed_result') {
          req.resolve(msg.embedding);
        } else {
          req.resolve(msg.embeddings);
        }
      }
    }
  }

  /**
   * Resolves all pending requests with null (graceful degradation).
   *
   * Called on worker error or unexpected exit.
   */
  private resolveAllPending(): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.resolve(null);
      this.pending.delete(id);
    }
  }
}
