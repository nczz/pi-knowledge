import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RERANKER_MODEL,
	DEFAULT_RERANKER_REMOTE_HOST,
	rerankerCacheKey,
	resolveRerankerConfig,
} from "../../src/search/reranker-config.ts";

describe("reranker config", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults to the existing local Hugging Face reranker", () => {
		const config = resolveRerankerConfig({});

		expect(config).toEqual({
			provider: "hf",
			model: DEFAULT_RERANKER_MODEL,
			revision: "main",
			dtype: undefined,
			remoteHost: undefined,
			remotePathTemplate: undefined,
		});
	});

	it("accepts bare Hugging Face model ids", () => {
		const config = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-2-v2" });

		expect(config).toMatchObject({
			provider: "hf",
			model: "Xenova/ms-marco-MiniLM-L-2-v2",
			revision: "main",
		});
	});

	it("enables raw logits only when explicitly requested", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "Xenova/bge-reranker-base",
			PI_KNOWLEDGE_RERANKER_RAW_LOGITS: "true",
		});

		expect(config).toMatchObject({
			provider: "hf",
			model: "Xenova/bge-reranker-base",
			rawLogits: true,
		});
	});

	it("normalizes Hugging Face model URLs and revisions", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "https://huggingface.co/Xenova/ms-marco-MiniLM-L-12-v2/tree/custom-rev",
			PI_KNOWLEDGE_RERANKER_DTYPE: "fp32",
		});

		expect(config).toMatchObject({
			provider: "hf",
			model: "Xenova/ms-marco-MiniLM-L-12-v2",
			revision: "custom-rev",
			dtype: "fp32",
			remoteHost: DEFAULT_RERANKER_REMOTE_HOST,
		});
	});

	it("lets explicit env values override URL-derived source options", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "https://hf-mirror.example/acme/reranker/resolve/url-rev/config.json",
			PI_KNOWLEDGE_RERANKER_REVISION: "env-rev",
			PI_KNOWLEDGE_RERANKER_REMOTE_HOST: "https://models.example/",
			PI_KNOWLEDGE_RERANKER_REMOTE_PATH_TEMPLATE: "mirror/{model}/{revision}/",
		});

		expect(config).toMatchObject({
			provider: "hf",
			model: "acme/reranker",
			revision: "env-rev",
			remoteHost: "https://models.example/",
			remotePathTemplate: "mirror/{model}/{revision}/",
		});
	});

	it("parses API mode with provider defaults and endpoint fallback", () => {
		const config = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "api:jina-reranker-v2-base-multilingual" });

		expect(config).toMatchObject({
			provider: "api",
			model: "jina-reranker-v2-base-multilingual",
			endpoint: "https://api.cohere.com/v2/rerank",
			format: "cohere",
			timeoutMs: 30_000,
			maxDocumentChars: 12_000,
			resultsPath: "results",
			indexField: "index",
			scoreField: "relevance_score",
			scoreDirection: "desc",
		});
	});

	it("parses custom API endpoint and mapping values", () => {
		const config = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "api:rerank-v1",
			PI_KNOWLEDGE_RERANKER_API_BASE_URL: "http://127.0.0.1:8080/v1",
			PI_KNOWLEDGE_RERANKER_API_KEY: "test-key",
			PI_KNOWLEDGE_RERANKER_API_FORMAT: "custom-json",
			PI_KNOWLEDGE_RERANKER_API_TIMEOUT_MS: "5000",
			PI_KNOWLEDGE_RERANKER_MAX_DOC_CHARS: "200",
			PI_KNOWLEDGE_RERANKER_API_RESULTS_PATH: "data.rankings",
			PI_KNOWLEDGE_RERANKER_API_INDEX_FIELD: "document_index",
			PI_KNOWLEDGE_RERANKER_API_SCORE_FIELD: "score",
			PI_KNOWLEDGE_RERANKER_API_SCORE_DIRECTION: "asc",
		});

		expect(config).toMatchObject({
			provider: "api",
			model: "rerank-v1",
			endpoint: "http://127.0.0.1:8080/v1/rerank",
			apiKey: "test-key",
			format: "custom-json",
			timeoutMs: 5000,
			maxDocumentChars: 200,
			resultsPath: "data.rankings",
			indexField: "document_index",
			scoreField: "score",
			scoreDirection: "asc",
		});
	});

	it("rejects non-HTTP API endpoints", () => {
		expect(() =>
			resolveRerankerConfig({
				PI_KNOWLEDGE_RERANKER: "api:rerank-v1",
				PI_KNOWLEDGE_RERANKER_API_ENDPOINT: "file:///tmp/rerank.json",
			}),
		).toThrow("Unsupported reranker API endpoint protocol: file:");
	});

	it("builds stable cache keys from every local model-loading field", () => {
		const first = resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-4-v2" });
		const second = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-4-v2",
			PI_KNOWLEDGE_RERANKER_REVISION: "other",
		});
		const raw = resolveRerankerConfig({
			PI_KNOWLEDGE_RERANKER: "Xenova/ms-marco-MiniLM-L-4-v2",
			PI_KNOWLEDGE_RERANKER_RAW_LOGITS: "true",
		});
		if (first.provider !== "hf" || second.provider !== "hf" || raw.provider !== "hf") {
			throw new Error("Expected hf configs");
		}

		expect(rerankerCacheKey(first)).not.toBe(rerankerCacheKey(second));
		expect(rerankerCacheKey(first)).not.toBe(rerankerCacheKey(raw));
		expect(rerankerCacheKey(first)).toContain(DEFAULT_RERANKER_MODEL);
	});

	it("rejects invalid model ids", () => {
		expect(() => resolveRerankerConfig({ PI_KNOWLEDGE_RERANKER: "hf:not-a-repo" })).toThrow(
			"Invalid reranker model id",
		);
	});
});
