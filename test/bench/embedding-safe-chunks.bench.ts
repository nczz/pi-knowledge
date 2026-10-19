import { bench, describe } from "vitest";
import type { EmbeddingConfig } from "../../src/embedding/provider.ts";
import { chunkText } from "../../src/indexer/chunker.ts";
import { finalizeChunksForEmbedding } from "../../src/indexer/embedding-safe-chunks.ts";

const apiConfig: EmbeddingConfig = {
	provider: "openai",
	model: "benchmark-model",
	baseUrl: "http://127.0.0.1:8080/v1",
	maxChars: 2_048,
	queryPrefix: "query",
	documentPrefix: "passage",
	prefixes: "on",
	pooling: "mean",
	normalize: true,
};

const localConfig: EmbeddingConfig = {
	...apiConfig,
	provider: "local",
	model: "multilingual-e5-small",
	baseUrl: undefined,
};

const safeChunks = Array.from({ length: 64 }, (_, index) =>
	chunkText(
		`Benchmark document ${index} contains focused retrieval content and remains below the embedding input limit.`,
		`docs/benchmark-${index}.txt`,
	),
).flat();
const oversizedCjkChunk = chunkText(
	`起始${"這是一段用來驗證長文件安全切分效能的繁體中文內容".repeat(200)}尾端`,
	"docs/oversized-cjk.txt",
);

describe("embedding-safe chunk finalization", () => {
	bench("accepts one 64-chunk safe batch", async () => {
		await finalizeChunksForEmbedding(safeChunks, localConfig);
	});

	bench("splits one oversized CJK paragraph", async () => {
		await finalizeChunksForEmbedding(oversizedCjkChunk, apiConfig);
	});
});
