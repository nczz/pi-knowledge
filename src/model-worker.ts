import { join } from "node:path";
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
};

type WorkerRequest = EmbedRequest | RerankRequest;

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let rerankerPipeline: RerankerPipeline | null = null;

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

async function loadEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
	if (embeddingPipeline) return embeddingPipeline;
	const { pipeline, env } = await import("@huggingface/transformers");
	configureTransformersEnv(env as TransformersEnv);
	const createPipeline = pipeline as PipelineFactory;
	const loaded = (await createPipeline("feature-extraction", "Xenova/multilingual-e5-small", {
		quantized: true,
		dtype: "fp32",
	})) as FeatureExtractionPipeline;
	embeddingPipeline = loaded;
	return loaded;
}

async function loadRerankerPipeline(): Promise<RerankerPipeline> {
	if (rerankerPipeline) return rerankerPipeline;
	const { pipeline, env } = await import("@huggingface/transformers");
	configureTransformersEnv(env as TransformersEnv);
	const createPipeline = pipeline as PipelineFactory;
	const loaded = (await createPipeline("text-classification", "Xenova/ms-marco-MiniLM-L-4-v2")) as RerankerPipeline;
	rerankerPipeline = loaded;
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
	const pipe = await loadRerankerPipeline();
	const results: Array<{ chunkId: string; score: number }> = [];
	for (const candidate of request.candidates) {
		const output = await pipe({ text: request.query, text_pair: candidate.content });
		const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
		results.push({ chunkId: candidate.chunkId, score });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, request.topK);
}

process.on("message", (request: WorkerRequest) => {
	void (async () => {
		try {
			const result = request.type === "embed" ? await handleEmbed(request) : await handleRerank(request);
			process.send?.({ id: request.id, result });
		} catch (error) {
			process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
		}
	})();
});
