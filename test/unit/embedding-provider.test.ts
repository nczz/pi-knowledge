import { beforeEach, describe, expect, it, vi } from "vitest";

const workerMock = vi.hoisted(() => ({
	embedInModelWorker: vi.fn(async () => [new Float32Array([0.5, 0.5])]),
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

		expect(vectors[0]).toEqual(new Float32Array([0.1, 0.2]));
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/embeddings");
		expect(init?.method).toBe("POST");
		expect(workerMock.embedInModelWorker).not.toHaveBeenCalled();
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

	it("bounds API embedding input length with a configurable safety cap", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_MAX_CHARS", "32");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		await embedDocuments(["x".repeat(100)]);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(String(init?.body)) as { input: string[] };
		expect(body.input[0]).toHaveLength(32);
		expect(body.input[0]).toBe("passage: xxxxxxxxxxxxxxxxxxxxxxx");
	});

	it("falls back to the local worker only when explicitly requested", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:custom-embedding-model");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_API_FALLBACK", "local");
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("temporary failure", { status: 503 })),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { embedDocuments } = await import("../../src/embedding/provider.ts");
		const vectors = await embedDocuments(["hello"]);

		expect(vectors[0]).toEqual(new Float32Array([0.5, 0.5]));
		expect(workerMock.embedInModelWorker).toHaveBeenCalledOnce();
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to local model"));
	});
});
