import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HfRerankerConfig } from "./search/reranker-config.ts";
import {
	DEFAULT_RERANKER_REMOTE_HOST,
	DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE,
	isHfRerankerConfig,
	rerankerCacheKey,
	resolveRerankerConfig,
} from "./search/reranker-config.ts";
import { type RawLogitModel, type RawLogitTokenizer, rerankWithSingleRawLogit } from "./search/reranker-logits.ts";
import { getDefaultKnowledgeDir } from "./storage/sqlite.ts";

type FeatureExtractionPipeline = (
	input: string,
	options: { pooling: "mean"; normalize: true },
) => Promise<{ data: ArrayLike<number> }>;

type RerankerPipeline = (input: {
	text: string;
	text_pair: string;
}) => Promise<{ score?: number } | Array<{ score?: number }>>;
type PipelineFactory = (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
type TransformersEnv = {
	cacheDir?: string;
	allowRemoteModels?: boolean;
	localModelPath?: string;
	remoteHost?: string;
	remotePathTemplate?: string;
};

type EmbedRequest = {
	id: number;
	type: "embed";
	texts: string[];
	prefix: "query" | "passage";
};

type RerankRequest = {
	id: number;
	type: "rerank";
	query: string;
	candidates: Array<{ chunkId: string; content: string }>;
	topK: number;
	reranker: HfRerankerConfig;
};

type WorkerRequest = EmbedRequest | RerankRequest;
type WorkerResponse = { id: number; result?: unknown; error?: string };

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let rerankerPipeline: { key: string; pipe: RerankerPipeline } | null = null;

function getModelCacheDir(): string {
	return process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR ?? join(getDefaultKnowledgeDir(), "models");
}

function configureTransformersEnv(env: TransformersEnv): void {
	const cacheDir = getModelCacheDir();
	env.cacheDir = cacheDir;
	if (process.env.PI_KNOWLEDGE_OFFLINE === "true") {
		env.allowRemoteModels = false;
		env.localModelPath = cacheDir;
	}
}

function configureEmbeddingTransformersEnv(env: TransformersEnv): void {
	configureTransformersEnv(env);
	env.remoteHost = DEFAULT_RERANKER_REMOTE_HOST;
	env.remotePathTemplate = DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE;
}

async function loadEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
	if (embeddingPipeline) return embeddingPipeline;
	const { pipeline, env } = await import("@huggingface/transformers");
	configureEmbeddingTransformersEnv(env as TransformersEnv);
	const createPipeline = pipeline as PipelineFactory;
	const loaded = (await createPipeline("feature-extraction", "Xenova/multilingual-e5-small", {
		quantized: true,
		dtype: "fp32",
	})) as FeatureExtractionPipeline;
	embeddingPipeline = loaded;
	return loaded;
}

async function loadRerankerPipeline(config: HfRerankerConfig): Promise<RerankerPipeline> {
	const key = rerankerCacheKey(config);
	if (rerankerPipeline?.key === key) return rerankerPipeline.pipe;

	if (config.rawLogits) {
		const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
		const transformersEnv = env as TransformersEnv;
		configureTransformersEnv(transformersEnv);
		transformersEnv.remoteHost = config.remoteHost ?? DEFAULT_RERANKER_REMOTE_HOST;
		transformersEnv.remotePathTemplate = config.remotePathTemplate ?? DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE;
		const loadOpts: Record<string, unknown> = { revision: config.revision };
		if (config.dtype) loadOpts.dtype = config.dtype;
		const tokenizer = (await AutoTokenizer.from_pretrained(config.model, loadOpts)) as RawLogitTokenizer;
		const model = (await AutoModelForSequenceClassification.from_pretrained(config.model, loadOpts)) as RawLogitModel;
		const pipe: RerankerPipeline = (input) => rerankWithSingleRawLogit(input, tokenizer, model, config.model);
		rerankerPipeline = { key, pipe };
		return pipe;
	}

	const { pipeline, env } = await import("@huggingface/transformers");
	const transformersEnv = env as TransformersEnv;
	configureTransformersEnv(transformersEnv);
	transformersEnv.remoteHost = config.remoteHost ?? DEFAULT_RERANKER_REMOTE_HOST;
	transformersEnv.remotePathTemplate = config.remotePathTemplate ?? DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE;
	const createPipeline = pipeline as PipelineFactory;
	const options: Record<string, unknown> = { revision: config.revision };
	if (config.dtype) options.dtype = config.dtype;
	const loaded = (await createPipeline("text-classification", config.model, options)) as RerankerPipeline;
	rerankerPipeline = { key, pipe: loaded };
	return loaded;
}

async function handleEmbed(request: EmbedRequest): Promise<number[][]> {
	const pipe = await loadEmbeddingPipeline();
	const vectors: number[][] = [];
	for (const text of request.texts) {
		const output = await pipe(`${request.prefix}: ${text}`, { pooling: "mean", normalize: true });
		vectors.push(Array.from(output.data));
	}
	return vectors;
}

async function handleRerank(request: RerankRequest): Promise<Array<{ chunkId: string; score: number }>> {
	const pipe = await loadRerankerPipeline(request.reranker);
	const results: Array<{ chunkId: string; score: number }> = [];
	for (const candidate of request.candidates) {
		const output = await pipe({ text: request.query, text_pair: candidate.content });
		const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
		results.push({ chunkId: candidate.chunkId, score });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, request.topK);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRerankCandidateArray(value: unknown): value is Array<{ chunkId: string; content: string }> {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				"chunkId" in item &&
				typeof item.chunkId === "string" &&
				"content" in item &&
				typeof item.content === "string",
		)
	);
}

function parseWorkerRequest(message: unknown): WorkerRequest {
	if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number") {
		throw new Error("Invalid worker request id");
	}
	if (!("type" in message)) throw new Error("Invalid worker request type");
	if (message.type === "embed") {
		if (!("texts" in message) || !isStringArray(message.texts)) throw new Error("Invalid embed texts");
		if (!("prefix" in message) || (message.prefix !== "query" && message.prefix !== "passage")) {
			throw new Error("Invalid embed prefix");
		}
		return { id: message.id, type: "embed", texts: message.texts, prefix: message.prefix };
	}
	if (message.type === "rerank") {
		if (!("query" in message) || typeof message.query !== "string") throw new Error("Invalid rerank query");
		if (!("topK" in message) || typeof message.topK !== "number") throw new Error("Invalid rerank topK");
		if (!("candidates" in message) || !isRerankCandidateArray(message.candidates)) {
			throw new Error("Invalid rerank candidates");
		}
		const reranker =
			"reranker" in message && isHfRerankerConfig(message.reranker) ? message.reranker : resolveRerankerConfig();
		if (reranker.provider !== "hf") throw new Error("Reranker API mode is not supported by the model worker");
		return {
			id: message.id,
			type: "rerank",
			query: message.query,
			candidates: message.candidates,
			topK: message.topK,
			reranker,
		};
	}
	throw new Error("Unsupported worker request type");
}

async function handleRequestMessage(message: unknown): Promise<WorkerResponse> {
	let requestId = 0;
	try {
		if (typeof message === "object" && message !== null && "id" in message && typeof message.id === "number") {
			requestId = message.id;
		}
		const request = parseWorkerRequest(message);
		const result = request.type === "embed" ? await handleEmbed(request) : await handleRerank(request);
		return { id: request.id, result };
	} catch (error) {
		return { id: requestId, error: error instanceof Error ? error.message : String(error) };
	}
}

function writeStdioResponse(response: WorkerResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function runIpcMode(): void {
	process.on("message", (message: unknown) => {
		void (async () => {
			const response = await handleRequestMessage(message);
			process.send?.(response);
		})();
	});
}

function redirectConsoleOutputToStderr(): void {
	const writeToStderr = (...args: unknown[]): void => console.error(...args);
	console.log = writeToStderr;
	console.info = writeToStderr;
	console.debug = writeToStderr;
}

function runStdioMode(): void {
	redirectConsoleOutputToStderr();
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("line", (line) => {
		void (async () => {
			try {
				writeStdioResponse(await handleRequestMessage(JSON.parse(line)));
			} catch (error) {
				writeStdioResponse({ id: 0, error: error instanceof Error ? error.message : String(error) });
			}
		})();
	});
}

if (process.argv.includes("--stdio")) {
	runStdioMode();
} else {
	runIpcMode();
}
