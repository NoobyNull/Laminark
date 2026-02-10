/**
 * Worker thread entry point for off-main-thread embedding.
 *
 * Receives embed/embed_batch/shutdown messages from the main thread via
 * parentPort, runs the embedding engine, and responds with Float32Array
 * results using zero-copy transfer.
 *
 * Compiled as a separate tsdown entry point to dist/analysis/worker.js.
 */

import { parentPort } from 'node:worker_threads';
import { createEmbeddingEngine } from './embedder.js';

if (!parentPort) {
  throw new Error('worker.ts must be run as a Worker thread');
}

const port = parentPort;

interface EmbedMessage {
  type: 'embed';
  id: string;
  text: string;
}

interface EmbedBatchMessage {
  type: 'embed_batch';
  id: string;
  texts: string[];
}

interface ShutdownMessage {
  type: 'shutdown';
}

type WorkerMessage = EmbedMessage | EmbedBatchMessage | ShutdownMessage;

async function init(): Promise<void> {
  let engineName = 'keyword-only';
  let dimensions = 0;

  try {
    const engine = await createEmbeddingEngine();
    engineName = engine.name();
    dimensions = engine.dimensions();

    port.postMessage({ type: 'ready', engineName, dimensions });

    port.on('message', async (msg: WorkerMessage) => {
      if (msg.type === 'embed') {
        try {
          const embedding = await engine.embed(msg.text);

          if (embedding === null) {
            port.postMessage({ type: 'embed_result', id: msg.id, embedding: null });
          } else {
            // Zero-copy transfer of the underlying ArrayBuffer
            const buf = embedding.buffer as ArrayBuffer;
            port.postMessage(
              { type: 'embed_result', id: msg.id, embedding },
              [buf],
            );
          }
        } catch {
          port.postMessage({ type: 'embed_result', id: msg.id, embedding: null });
        }
      } else if (msg.type === 'embed_batch') {
        try {
          const embeddings = await engine.embedBatch(msg.texts);

          // Collect non-null buffers for zero-copy transfer
          const transferList: ArrayBuffer[] = [];
          for (const emb of embeddings) {
            if (emb !== null) {
              transferList.push(emb.buffer as ArrayBuffer);
            }
          }

          port.postMessage(
            { type: 'embed_batch_result', id: msg.id, embeddings },
            transferList,
          );
        } catch {
          port.postMessage({
            type: 'embed_batch_result',
            id: msg.id,
            embeddings: msg.texts.map(() => null),
          });
        }
      } else if (msg.type === 'shutdown') {
        process.exit(0);
      }
    });
  } catch {
    // Engine creation failed -- still report ready with keyword-only fallback
    port.postMessage({ type: 'ready', engineName, dimensions });

    port.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'embed') {
        port.postMessage({ type: 'embed_result', id: msg.id, embedding: null });
      } else if (msg.type === 'embed_batch') {
        port.postMessage({
          type: 'embed_batch_result',
          id: msg.id,
          embeddings: msg.texts.map(() => null),
        });
      } else if (msg.type === 'shutdown') {
        process.exit(0);
      }
    });
  }
}

init();
