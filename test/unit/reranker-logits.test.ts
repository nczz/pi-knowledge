import { describe, expect, it, vi } from "vitest";
import { rerankWithSingleRawLogit, scoreSingleRawLogit } from "../../src/search/reranker-logits.ts";

describe("raw-logit reranker scoring", () => {
	it("returns the only logit as the rerank score", () => {
		expect(scoreSingleRawLogit({ data: Float32Array.from([7.25]) }, "Xenova/bge-reranker-base")).toBeCloseTo(7.25);
	});

	it("rejects multi-logit classifiers instead of guessing a score label", () => {
		expect(() => scoreSingleRawLogit({ data: Float32Array.from([-3, 4]) }, "example/two-label-reranker")).toThrow(
			"Raw-logit reranker expected a single-logit sequence classifier for example/two-label-reranker, got 2 logits",
		);
	});

	it("rejects non-finite scores", () => {
		expect(() => scoreSingleRawLogit({ data: [Number.NaN] }, "example/reranker")).toThrow(
			"Raw-logit reranker returned a non-finite score for example/reranker",
		);
	});

	it("tokenizes query/document pairs before returning the raw model score", async () => {
		const tokenizer = vi.fn(() => ({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] }));
		const model = vi.fn(async () => ({ logits: { data: Float32Array.from([9.5]) } }));

		await expect(
			rerankWithSingleRawLogit({ text: "query", text_pair: "document" }, tokenizer, model, "Xenova/bge-reranker-base"),
		).resolves.toEqual([{ score: 9.5 }]);
		expect(tokenizer).toHaveBeenCalledWith("query", {
			text_pair: "document",
			padding: true,
			truncation: true,
		});
		expect(model).toHaveBeenCalledWith({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] });
	});
});
