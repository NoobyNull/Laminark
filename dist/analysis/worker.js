import { t as getConfigDir } from "../config-CtH17VYQ.mjs";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";

//#region src/analysis/engines/local-onnx.ts
/**
* Local ONNX embedding engine using @huggingface/transformers.
*
* Loads BGE Small EN v1.5 (quantized q8) via dynamic import() for
* zero startup cost (DQ-04). Model files are cached in ~/.laminark/models/.
*/
/**
* Embedding engine backed by BGE Small EN v1.5 running locally via ONNX Runtime.
*
* All public methods catch errors internally and return null/false.
*/
var LocalOnnxEngine = class {
	pipe = null;
	ready = false;
	/**
	* Lazily loads the model via dynamic import().
	*
	* - Uses `@huggingface/transformers` loaded at runtime (not bundled)
	* - Caches model files in ~/.laminark/models/
	* - Returns false on any error (missing runtime, download failure, etc.)
	*/
	async initialize() {
		try {
			const { pipeline, env } = await import("@huggingface/transformers");
			env.cacheDir = join(getConfigDir(), "models");
			this.pipe = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
			this.ready = true;
			return true;
		} catch {
			this.ready = false;
			return false;
		}
	}
	/**
	* Embeds a single text string into a 384-dimensional vector.
	*
	* Returns null if:
	* - Engine not initialized
	* - Input is empty/whitespace
	* - Pipeline throws
	*/
	async embed(text) {
		if (!this.ready || !this.pipe) return null;
		if (!text || text.trim().length === 0) return null;
		try {
			const output = await this.pipe(text, {
				pooling: "cls",
				normalize: true
			});
			return Float32Array.from(output.data);
		} catch {
			return null;
		}
	}
	/**
	* Embeds multiple texts, preserving order.
	*
	* Returns null for any text that was empty or failed.
	*/
	async embedBatch(texts) {
		const results = [];
		for (const text of texts) if (!text || text.trim().length === 0) results.push(null);
		else results.push(await this.embed(text));
		return results;
	}
	/** BGE Small EN v1.5 produces 384-dimensional embeddings. */
	dimensions() {
		return 384;
	}
	/** Engine identifier. */
	name() {
		return "bge-small-en-v1.5-q8";
	}
	/** Whether the model loaded successfully. */
	isReady() {
		return this.ready;
	}
};

//#endregion
//#region src/analysis/engines/keyword-only.ts
/**
* Embedding engine that produces no embeddings.
*
* Acts as a silent fallback so that the rest of the system can
* operate in keyword-only mode without special-casing missing engines.
*/
var KeywordOnlyEngine = class {
	/** Always returns null -- no model available. */
	async embed() {
		return null;
	}
	/** Returns array of nulls matching input length. */
	async embedBatch(texts) {
		return texts.map(() => null);
	}
	/** No dimensions -- no model. */
	dimensions() {
		return 0;
	}
	/** Engine identifier. */
	name() {
		return "keyword-only";
	}
	/** Intentionally returns false -- this engine has no model. */
	async initialize() {
		return false;
	}
	/** Always false -- no model loaded. */
	isReady() {
		return false;
	}
};

//#endregion
//#region src/analysis/embedder.ts
/**
* EmbeddingEngine interface and factory.
*
* Defines the pluggable abstraction for text embedding.
* All consumers depend on this interface -- never on concrete engines.
*/
/**
* Creates and initializes an embedding engine.
*
* Attempts LocalOnnxEngine first. If initialization fails (missing model,
* ONNX runtime unavailable, etc.), falls back to KeywordOnlyEngine.
*
* Never throws -- always returns a valid engine.
*/
async function createEmbeddingEngine() {
	const onnxEngine = new LocalOnnxEngine();
	if (await onnxEngine.initialize()) return onnxEngine;
	return new KeywordOnlyEngine();
}

//#endregion
//#region src/analysis/worker.ts
/**
* Worker thread entry point for off-main-thread embedding.
*
* Receives embed/embed_batch/shutdown messages from the main thread via
* parentPort, runs the embedding engine, and responds with Float32Array
* results using zero-copy transfer.
*
* Compiled as a separate tsdown entry point to dist/analysis/worker.js.
*/
if (!parentPort) throw new Error("worker.ts must be run as a Worker thread");
const port = parentPort;
async function init() {
	let engineName = "keyword-only";
	let dimensions = 0;
	try {
		const engine = await createEmbeddingEngine();
		engineName = engine.name();
		dimensions = engine.dimensions();
		port.postMessage({
			type: "ready",
			engineName,
			dimensions
		});
		port.on("message", async (msg) => {
			if (msg.type === "embed") try {
				const embedding = await engine.embed(msg.text);
				if (embedding === null) port.postMessage({
					type: "embed_result",
					id: msg.id,
					embedding: null
				});
				else {
					const buf = embedding.buffer;
					port.postMessage({
						type: "embed_result",
						id: msg.id,
						embedding
					}, [buf]);
				}
			} catch {
				port.postMessage({
					type: "embed_result",
					id: msg.id,
					embedding: null
				});
			}
			else if (msg.type === "embed_batch") try {
				const embeddings = await engine.embedBatch(msg.texts);
				const transferList = [];
				for (const emb of embeddings) if (emb !== null) transferList.push(emb.buffer);
				port.postMessage({
					type: "embed_batch_result",
					id: msg.id,
					embeddings
				}, transferList);
			} catch {
				port.postMessage({
					type: "embed_batch_result",
					id: msg.id,
					embeddings: msg.texts.map(() => null)
				});
			}
			else if (msg.type === "shutdown") process.exit(0);
		});
	} catch {
		port.postMessage({
			type: "ready",
			engineName,
			dimensions
		});
		port.on("message", (msg) => {
			if (msg.type === "embed") port.postMessage({
				type: "embed_result",
				id: msg.id,
				embedding: null
			});
			else if (msg.type === "embed_batch") port.postMessage({
				type: "embed_batch_result",
				id: msg.id,
				embeddings: msg.texts.map(() => null)
			});
			else if (msg.type === "shutdown") process.exit(0);
		});
	}
}
init();

//#endregion
export {  };
//# sourceMappingURL=worker.js.map