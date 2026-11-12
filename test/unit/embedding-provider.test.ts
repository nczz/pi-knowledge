import { beforeEach, describe, expect, it, vi } from "vitest";

const workerMock = vi.hoisted(() => ({
	embedInModelWorker: vi.fn(async () => [new Float32Array([0.5, 0.5])]),
	measureEmbeddingInputInModelWorker: vi.fn(async (texts: string[]) => ({
		counts: texts.map((text) => text.length),
		maximum: 512,
	})),
}));

vi.mock("../../src/model-worker-client.ts", () => workerMock);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

describe("embedding provider", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		workerMock.embedInModelWorker.mockClear();
		workerMock.measureEmbeddingInputInModelWorker.mockReset();
		workerMock.measureEmbeddingInputInModelWorker.mockImplementation(async (texts: string[]) => ({
			counts: texts.map((text) => text.length),
			maximum: 512,
		}));
	});

	it("uses PI_KNOWLEDGE_EMBEDDING_BASE_URL for OpenAI-compatible embedding APIs", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "http://127.0.0.1:8080/v1");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		const vectors = await embedDocuments(["hello"]);

		expect(Array.from(vectors[0])).toEqual([expect.closeTo(0.4472136, 6), expect.closeTo(0.8944272, 6)]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/embeddings");
		expect(init?.method).toBe("POST");
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("L2-normalizes every API vector before search or persistence", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					data: [{ embedding: [3, 4, 0] }, { embedding: [0, 12, 5] }],
				}),
			),
		);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		const vectors = await embedDocuments(["first", "second"]);

		expect(Array.from(vectors[0])).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6), 0]);
		expect(Array.from(vectors[1])).toEqual([0, expect.closeTo(12 / 13, 6), expect.closeTo(5 / 13, 6)]);
	});

	it("rejects invalid vectors instead of persisting unusable similarity data", async () => {
		const { normalizeEmbeddingVector } = await import("../../src/embedding/provider.ts");

		expect(() => normalizeEmbeddingVector(new Float32Array([0, 0]))).toThrow("zero-magnitude vector");
		expect(() => normalizeEmbeddingVector(new Float32Array([Number.NaN, 1]))).toThrow("non-finite vector value");
	});

	it("rejects malformed or inconsistent API vectors before normalization", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [null, 1] }] }))
			.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [1, 0, 0] }] }));
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["invalid"])).rejects.toThrow("contains a non-finite numeric value");
		await expect(embedDocuments(["first", "second"])).rejects.toThrow("has dimension 3; expected 2");
	});

	it("allows unauthenticated custom OpenAI-compatible embedding APIs", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "http://127.0.0.1:8080/v1");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["hello"]);

		const [, init] = fetchMock.mock.calls[0];
		expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("prefers PI_KNOWLEDGE_EMBEDDING_API_KEY over OPENAI_API_KEY", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "http://127.0.0.1:8080/v1");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_KEY", "embedding-key");
		vi.stubEnv("OPENAI_API_KEY", "openai-key");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["hello"]);

		const [, init] = fetchMock.mock.calls[0];
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer embedding-key");
	});

	it("surfaces API embedding failures by default instead of silently falling back", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("context window exceeded", { status: 400 })),
		);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["hello"])).rejects.toThrow("OpenAI embedding API error: 400 context window exceeded");
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("rejects API embedding input above the configured safety cap without truncating or sending it", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_MAX_CHARS", "32");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["x".repeat(100)])).rejects.toThrow(
			"openai embedding passage input 1 is 109 characters; maximum is 32",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects local embedding input above the tokenizer limit before inference", async () => {
		workerMock.measureEmbeddingInputInModelWorker.mockResolvedValue({ counts: [513], maximum: 512 });

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["oversized"])).rejects.toThrow(
			"local embedding passage input 1 is 513 tokens; maximum is 512",
		);
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("sends raw API embedding input when prefixes are disabled", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "off");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["hello"]);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(String(init?.body)) as { input: string[] };
		expect(body.input).toEqual(["hello"]);
	});

	it("passes the configured prefix strategy to the local model worker", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "off");

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["hello"]);

		expect(workerMock.embedInModelWorker).toHaveBeenCalledWith(["hello"], "passage", "off", undefined);
	});

	it("rejects unsupported embedding decoration strategies", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "disabled");

		const { resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");

		expect(() => resolveEmbeddingConfig()).toThrow(
			"Unsupported embedding decoration strategy: disabled. Use PI_KNOWLEDGE_EMBEDDING_PREFIXES=on|off|e5|none|jina|jina-code|custom.",
		);
	});

	it("sends one prepared multilingual input batch without altering custom instructions", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:跨語言模型");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "custom");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION", "檢索最相關的程式碼：\n");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION", "候選程式碼：\n");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.2, 0.1] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["驗證 OAuth 權杖", "function 讀取設定() {}"]);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(String(init?.body)) as { input: string[] };
		expect(body.input).toEqual(["候選程式碼：\n驗證 OAuth 權杖", "候選程式碼：\nfunction 讀取設定() {}"]);
	});

	it("rejects local fallback for instructions the local E5 model cannot reproduce", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:jinaai/jina-code-embeddings-1.5b");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "jina");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_FALLBACK", "local");

		const { resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");

		expect(() => resolveEmbeddingConfig()).toThrow(
			"PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local is incompatible with embedding decoration jina-code",
		);
	});

	it("keeps a stale API fallback setting harmless when the active provider is local", async () => {
		const { resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");
		const config = resolveEmbeddingConfig({
			PI_KNOWLEDGE_EMBEDDING: "local:multilingual-e5-small",
			PI_KNOWLEDGE_EMBEDDING_API_FALLBACK: "local",
		});

		expect(config.provider).toBe("local");
		expect(config.apiFallbackToLocal).toBe(false);
	});

	it("rejects instructions that leave no room under the API input cap", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:跨語言模型");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "custom");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION", "請找出符合條件的內容：");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION", "候選文件：");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_MAX_CHARS", "8");

		const { resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");

		expect(() => resolveEmbeddingConfig()).toThrow("must leave room for input text");
	});

	it("passes AbortSignal to OpenAI-compatible embedding fetch", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const controller = new AbortController();
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["hello"], controller.signal);

		const [, init] = fetchMock.mock.calls[0];
		expect(init?.signal).toBe(controller.signal);
	});

	it("normalizes aborted API embedding fetches to Cancelled without local fallback", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_FALLBACK", "local");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			}),
		);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["hello"])).rejects.toThrow("Cancelled");
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("does not fall back to local vectors for document indexing batches", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_FALLBACK", "local");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("temporary failure", { status: 503 })),
		);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");

		await expect(embedDocuments(["hello"])).rejects.toThrow("OpenAI embedding API error: 503 temporary failure");
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
	});

	it("falls back to the local worker for query embeddings only when explicitly requested", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_FALLBACK", "local");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("temporary failure", { status: 503 })),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { embedQueryWithConfig } = await import("../../src/embedding/provider.ts");
		const { vector, config } = await embedQueryWithConfig("hello");

		expect(vector).toEqual(new Float32Array([0.5, 0.5]));
		expect(config.provider).toBe("local");
		expect(workerMock.embedInModelWorker).toHaveBeenCalledOnce();
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to local model"));
	});

	it("single-flights concurrent dispose calls while an embedding run is active", async () => {
		const pending = Promise.withResolvers<Array<Float32Array<ArrayBuffer>>>();
		workerMock.embedInModelWorker.mockReturnValueOnce(pending.promise);
		const { dispose, embedDocuments } = await import("../../src/embedding/provider.ts");
		const embedding = embedDocuments(["並行生命週期驗證"]);
		await vi.waitFor(() => expect(workerMock.embedInModelWorker).toHaveBeenCalledOnce());

		const firstDispose = dispose();
		const secondDispose = dispose();
		expect(secondDispose).toBe(firstDispose);
		let disposed = false;
		void firstDispose.then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);

		pending.resolve([new Float32Array([0.5, 0.5])]);
		await embedding;
		await firstDispose;
		expect(disposed).toBe(true);
	});

	it("builds stable embedding signatures without storing API keys", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:text-embedding-3-small");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "https://internal.example/v1");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_MAX_CHARS", "12345");
		vi.stubEnv("OPENAI_API_KEY", "secret-key");

		const { embeddingSignature, resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");
		const signature = embeddingSignature(resolveEmbeddingConfig(), 1536);

		expect(signature).toContain("openai:text-embedding-3-small");
		expect(signature).toContain("dim=1536");
		expect(signature).toContain("apiMax=12345");
		expect(signature).toContain("base-sha256=");
		expect(signature).not.toContain("secret-key");
		expect(signature).toContain("normalize=client-l2-v1");
		expect(signature).not.toContain("prefixes=");
	});

	it("includes disabled prefixes in embedding signatures", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:text-embedding-3-small");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_PREFIXES", "off");
		vi.stubEnv("OPENAI_API_KEY", "secret-key");

		const { embeddingSignature, resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");
		const signature = embeddingSignature(resolveEmbeddingConfig(), 1536);

		expect(signature).toContain("prefixes=off");
		expect(signature).not.toContain("internal.example");
	});
	it("keeps existing local and API E5 signatures byte-compatible", async () => {
		const { embeddingSignature, resolveEmbeddingConfig } = await import("../../src/embedding/provider.ts");
		const enabled = embeddingSignature(resolveEmbeddingConfig({}), 384);
		const disabled = embeddingSignature(resolveEmbeddingConfig({ PI_KNOWLEDGE_EMBEDDING_PREFIXES: "off" }), 384);
		const api = embeddingSignature(
			resolveEmbeddingConfig({ PI_KNOWLEDGE_EMBEDDING: "openai:text-embedding-3-small" }),
			1536,
		);

		expect(enabled).toBe(
			"local:multilingual-e5-small:dim=384:apiMax=none:pooling=mean:normalize=true:q=query:d=passage",
		);
		expect(disabled).toBe(
			"local:multilingual-e5-small:dim=384:apiMax=none:pooling=mean:normalize=true:q=query:d=passage:prefixes=off",
		);
		expect(api).toBe(
			"openai:text-embedding-3-small:base-sha256=d9617135d6fd:dim=1536:apiMax=20000:pooling=mean:normalize=client-l2-v1:q=query:d=passage",
		);
	});

	it("classifies decoration changes separately from provider configuration changes", async () => {
		const { embeddingSignature, inspectEmbeddingCompatibility, resolveEmbeddingConfig } = await import(
			"../../src/embedding/provider.ts"
		);
		const indexedConfig = resolveEmbeddingConfig({
			PI_KNOWLEDGE_EMBEDDING: "openai:跨語言模型",
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
			PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "查詢：",
			PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "文件：",
		});
		const changedInstructions = resolveEmbeddingConfig({
			PI_KNOWLEDGE_EMBEDDING: "openai:跨語言模型",
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
			PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "尋找：",
			PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "候選：",
		});
		const changedModel = resolveEmbeddingConfig({
			PI_KNOWLEDGE_EMBEDDING: "openai:另一個模型",
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
			PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "尋找：",
			PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "候選：",
		});
		const signature = embeddingSignature(indexedConfig, 768);

		expect(signature).toMatch(/:strategy=custom:ih=[0-9a-f]{12}$/);
		expect(signature).not.toContain("查詢：");
		expect(signature).not.toContain("文件：");
		expect(inspectEmbeddingCompatibility(signature, 768, changedInstructions, 768).cause).toBe("decoration");
		expect(inspectEmbeddingCompatibility(signature, 768, changedModel, 768).cause).toBe("configuration");
	});
});
