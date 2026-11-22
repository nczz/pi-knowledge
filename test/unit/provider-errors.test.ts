import { describe, expect, it } from "vitest";
import {
	classifyProviderFailure,
	isProviderFailureDetails,
	ProviderError,
	providerFailureDetailsFromStoredFields,
	providerNetworkError,
} from "../../src/provider-errors.ts";

describe("provider failure contract", () => {
	it("classifies only conservative HTTP and transport failures", () => {
		expect(
			classifyProviderFailure({ provider: "embedding", operation: "embed_documents", kind: "http", status: 429 }),
		).toBe("retryable");
		expect(
			classifyProviderFailure({ provider: "embedding", operation: "embed_documents", kind: "http", status: 503 }),
		).toBe("retryable");
		expect(classifyProviderFailure({ provider: "reranker", operation: "rerank", kind: "http", status: 401 })).toBe(
			"non_retryable",
		);
		expect(classifyProviderFailure({ provider: "reranker", operation: "rerank", kind: "timeout" })).toBe("retryable");
		expect(classifyProviderFailure({ provider: "reranker", operation: "rerank", kind: "cancelled" })).toBe("unknown");
	});

	it("retains bounded safe network codes and rejects unsafe serialized fields", () => {
		const cause = Object.assign(new Error("dns failed"), { code: "ENOTFOUND" });
		const error = providerNetworkError(new TypeError("fetch failed", { cause }), "embedding", "embed_query");

		expect(error.providerFailure).toEqual({
			provider: "embedding",
			operation: "embed_query",
			kind: "network",
			code: "ENOTFOUND",
		});
		expect(error).toMatchObject({
			provider: "embedding",
			operation: "embed_query",
			kind: "network",
			code: "ENOTFOUND",
		});
		expect(
			isProviderFailureDetails({
				provider: "embedding",
				operation: "embed_query",
				kind: "network",
				code: "secret value with spaces",
			}),
		).toBe(false);
		expect(
			isProviderFailureDetails({
				provider: "embedding",
				operation: "embed_query",
				kind: "network",
				code: 1e100,
			}),
		).toBe(false);
		expect(
			isProviderFailureDetails({
				provider: "embedding",
				operation: "embed_query",
				kind: "http",
			}),
		).toBe(false);
		expect(
			isProviderFailureDetails({
				provider: "embedding",
				operation: "embed_query",
				kind: "network",
				credential: "must not cross serialization boundaries",
			}),
		).toBe(false);
		expect(
			isProviderFailureDetails({
				provider: "reranker",
				operation: "embed_documents",
				kind: "network",
			}),
		).toBe(false);
		expect(
			() =>
				new ProviderError("invalid", {
					provider: "reranker",
					operation: "rerank",
					kind: "timeout",
					status: 504,
				}),
		).toThrow("Invalid provider failure details");
	});

	it("reconstructs only valid persisted provider facts", () => {
		expect(
			providerFailureDetailsFromStoredFields({
				error_provider: "embedding",
				provider_operation: "embed_documents",
				error_kind: "http",
				error_status: 502,
				error_code: null,
			}),
		).toEqual({ provider: "embedding", operation: "embed_documents", kind: "http", status: 502 });
		expect(
			providerFailureDetailsFromStoredFields({
				error_provider: "embedding",
				provider_operation: "embed_documents",
				error_kind: "http",
				error_status: 999,
				error_code: null,
			}),
		).toBeUndefined();
	});
});
