import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/provider-errors.ts";
import { rerankViaApi } from "../../src/search/reranker-api.ts";
import type { ApiRerankerConfig } from "../../src/search/reranker-config.ts";

const baseConfig: ApiRerankerConfig = {
	provider: "api",
	model: "rerank-v1",
	endpoint: "http://127.0.0.1:8080/v1/rerank",
	apiKey: "test-key",
	format: "cohere",
	timeoutMs: 30_000,
	maxDocumentChars: 16,
	resultsPath: "results",
	indexField: "index",
	scoreField: "relevance_score",
	scoreDirection: "desc",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

describe("API reranker", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("sends Cohere/Jina-compatible rerank requests and maps result indexes back to chunk ids", async () => {
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({
				results: [
					{ index: 1, relevance_score: 0.98 },
					{ index: 0, relevance_score: 0.12 },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "first document content" },
				{ chunkId: "chunk-b", content: "second document content" },
			],
			1,
			baseConfig,
		);

		expect(results).toEqual([{ chunkId: "chunk-b", score: 0.98 }]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/rerank");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer test-key" });
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "rerank-v1",
			query: "query",
			documents: ["first document c", "second document "],
			top_n: 1,
			return_documents: false,
		});
	});

	it("sends TEI rerank requests and maps root array scores", async () => {
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse([
				{ index: 0, score: 0.12 },
				{ index: 1, score: 0.98 },
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "first document content" },
				{ chunkId: "chunk-b", content: "second document content" },
			],
			1,
			{
				...baseConfig,
				apiKey: undefined,
				format: "tei",
				resultsPath: "",
				scoreField: "score",
			},
		);

		expect(results).toEqual([{ chunkId: "chunk-b", score: 0.98 }]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/rerank");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "query",
			texts: ["first document c", "second document "],
		});
	});

	it("supports custom JSON result paths and ascending scores", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					data: {
						rankings: [
							{ document_index: 0, score: 0.2 },
							{ document_index: 1, score: 0.1 },
						],
					},
				}),
			),
		);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "alpha" },
				{ chunkId: "chunk-b", content: "beta" },
			],
			2,
			{
				...baseConfig,
				format: "custom-json",
				resultsPath: "data.rankings",
				indexField: "document_index",
				scoreField: "score",
				scoreDirection: "asc",
			},
		);

		expect(results).toEqual([
			{ chunkId: "chunk-b", score: 0.1 },
			{ chunkId: "chunk-a", score: 0.2 },
		]);
	});

	it("preserves structured HTTP failures without changing the reranker error message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("bad key", { status: 401 })),
		);

		const error = await rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig).catch(
			(candidate: unknown) => candidate,
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			message: "Reranker API error: 401 bad key",
			provider: "reranker",
			operation: "rerank",
			kind: "http",
			status: 401,
			providerFailure: {
				provider: "reranker",
				operation: "rerank",
				kind: "http",
				status: 401,
			},
		});
	});

	it("retains safe network codes from reranker fetch failures", async () => {
		const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", { cause });
			}),
		);

		const error = await rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig).catch(
			(candidate: unknown) => candidate,
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			message: "fetch failed",
			provider: "reranker",
			operation: "rerank",
			kind: "network",
			code: "ECONNRESET",
			providerFailure: {
				provider: "reranker",
				operation: "rerank",
				kind: "network",
				code: "ECONNRESET",
			},
		});
	});

	it("preserves caller cancellation separately from reranker timeouts", async () => {
		const controller = new AbortController();
		const abort = new DOMException("The operation was aborted.", "AbortError");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				controller.abort();
				throw abort;
			}),
		);

		const error = await rerankViaApi(
			"query",
			[{ chunkId: "chunk", content: "doc" }],
			1,
			baseConfig,
			controller.signal,
		).catch((candidate: unknown) => candidate);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			message: "Cancelled",
			cause: abort,
			providerFailure: {
				provider: "reranker",
				operation: "rerank",
				kind: "cancelled",
			},
		});
	});

	it("classifies the reranker-owned deadline as a timeout rather than cancellation", async () => {
		vi.useFakeTimers();
		try {
			const abort = new DOMException("The operation was aborted.", "AbortError");
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async (_input: URL | string, init?: RequestInit) =>
						await new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => reject(abort), { once: true });
						}),
				),
			);
			const pending = rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, {
				...baseConfig,
				timeoutMs: 50,
			}).catch((candidate: unknown) => candidate);

			await vi.advanceTimersByTimeAsync(50);
			const error = await pending;

			expect(error).toBeInstanceOf(ProviderError);
			expect(error).toMatchObject({
				message: "Reranker API timed out after 50ms",
				cause: abort,
				providerFailure: {
					provider: "reranker",
					operation: "rerank",
					kind: "timeout",
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects malformed result indexes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ results: [{ index: 3, relevance_score: 0.9 }] })),
		);

		await expect(rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig)).rejects.toThrow(
			"Invalid reranker API response: result index is out of range",
		);
	});
});
