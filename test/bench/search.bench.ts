import { rmSync } from "node:fs";
import { bench, describe } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";

const TEST_DIR = "/tmp/pk-bench";
const engine = new KnowledgeEngine();

describe("pi-knowledge benchmarks", async () => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	await engine.initialize(TEST_DIR);

	// Pre-index docs for search benchmarks
	await engine.add(`${import.meta.dirname}/../../docs`, "BenchDocs");

	bench("search: mode=fast (BM25 only)", async () => {
		await engine.search("authentication OAuth", { mode: "fast", limit: 5 });
	});

	bench("search: mode=semantic (vector only)", async () => {
		await engine.search("authentication OAuth", { mode: "semantic", limit: 5 });
	});

	bench("search: mode=hybrid (BM25 + vector + RRF)", async () => {
		await engine.search("authentication OAuth", { mode: "hybrid", limit: 5 });
	});

	bench("search: CJK query", async () => {
		await engine.search("認證流程", { mode: "hybrid", limit: 5 });
	});

	bench("engine.list()", () => {
		engine.list();
	});

	bench("engine.diagnose()", () => {
		engine.diagnose();
	});
});
