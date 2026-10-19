import { describe, expect, it } from "vitest";
import type { EmbeddingConfig } from "../../src/embedding/provider.ts";
import { buildChunkEmbeddingText, chunkText } from "../../src/indexer/chunker.ts";
import { finalizeChunksForEmbedding } from "../../src/indexer/embedding-safe-chunks.ts";

function apiConfig(maxChars: number): EmbeddingConfig {
	return {
		provider: "openai",
		model: "test-embedding-model",
		baseUrl: "http://127.0.0.1:8080/v1",
		maxChars,
		queryPrefix: "query",
		documentPrefix: "passage",
		prefixes: "on",
		pooling: "mean",
		normalize: true,
	};
}

describe("embedding-safe chunk finalization", () => {
	it("splits a long CJK paragraph without losing tail content", async () => {
		const original = `開頭識別詞${"這是一段需要完整建立向量索引的繁體中文內容".repeat(100)}尾端檢索詞`;
		const initial = chunkText(original, "docs/long-zh.txt");
		expect(initial).toHaveLength(1);

		const finalized = await finalizeChunksForEmbedding(initial, apiConfig(280));

		expect(finalized.length).toBeGreaterThan(1);
		expect(finalized.map((chunk) => chunk.content).join("")).toBe(original);
		expect(finalized.at(-1)?.content).toContain("尾端檢索詞");
		expect(finalized.every((chunk) => `passage: ${buildChunkEmbeddingText(chunk)}`.length <= 280)).toBe(true);
		expect(
			finalized.every((chunk, index) => {
				const metadata = JSON.parse(chunk.metadata_json) as { chunk_part?: number; chunk_part_count?: number };
				return metadata.chunk_part === index + 1 && metadata.chunk_part_count === finalized.length;
			}),
		).toBe(true);
	});

	it("keeps chunks and hashes unchanged when the complete embedding input is already safe", async () => {
		const [chunk] = chunkText(
			"A focused paragraph with enough meaningful content to remain one stable embedding chunk.",
			"docs/safe.txt",
		);
		const [finalized] = await finalizeChunksForEmbedding([chunk], apiConfig(1_000));

		expect(finalized).toEqual(chunk);
	});

	it("never splits a Unicode surrogate pair", async () => {
		const original = `Prefix${"😀".repeat(200)}Tail`;
		const initial = chunkText(original, "emoji.txt");

		const finalized = await finalizeChunksForEmbedding(initial, apiConfig(180));

		expect(finalized.map((chunk) => chunk.content).join("")).toBe(original);
		expect(finalized.every((chunk) => !chunk.content.includes("�"))).toBe(true);
	});

	it("fails when fixed context alone leaves no safely splittable content", async () => {
		const [chunk] = chunkText(
			"Meaningful content that is long enough to create a chunk for validation.",
			`${"x".repeat(200)}.txt`,
		);

		await expect(finalizeChunksForEmbedding([chunk], apiConfig(64))).rejects.toThrow(
			/embedding context .* exceeds 64 characters and cannot be split safely/i,
		);
	});
});
