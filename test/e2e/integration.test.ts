import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { getActiveWatcherCount, startWatcher, stopAllWatchers } from "../../src/watcher/file-watcher.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function makeEngine(prefix: string): Promise<KnowledgeEngine> {
	const engine = new KnowledgeEngine();
	await engine.initialize(makeTempDir(prefix));
	return engine;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
	stopAllWatchers();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("integration coverage", () => {
	it("runs deep rerank search on an inline knowledge base", async () => {
		const engine = await makeEngine("pk-e2e-deep-");
		try {
			await engine.add(
				[
					"AlphaOmegaToken retrieval uses the Pi extension verification path and exact credential lookup.",
					"Billing reports describe invoices, payments, and account reconciliation.",
					"Weather notes describe rain, wind, and temperature forecasts.",
				].join("\n\n"),
				"DeepInline",
			);

			const result = await engine.search("How does AlphaOmegaToken retrieval work?", { mode: "deep", limit: 1 });
			expect(result.results).toHaveLength(1);
			expect(result.results[0].content).toContain("AlphaOmegaToken");
		} finally {
			await engine.dispose();
		}
	});

	it("indexes a real PDF fixture supplied outside the repo", async () => {
		const pdfPath = process.env.PI_KNOWLEDGE_E2E_PDF;
		if (!pdfPath) {
			expect.soft(pdfPath, "Set PI_KNOWLEDGE_E2E_PDF to run PDF extraction dogfood").toBeDefined();
			return;
		}

		const engine = await makeEngine("pk-e2e-pdf-");
		try {
			const { chunkCount, kb } = await engine.add(pdfPath, "PDF Fixture");
			expect(chunkCount).toBeGreaterThan(0);
			expect(kb.file_count).toBe(1);
		} finally {
			await engine.dispose();
		}
	});

	it("indexes a real DOCX fixture supplied outside the repo", async () => {
		const docxPath = process.env.PI_KNOWLEDGE_E2E_DOCX;
		if (!docxPath) {
			expect.soft(docxPath, "Set PI_KNOWLEDGE_E2E_DOCX to run DOCX extraction dogfood").toBeDefined();
			return;
		}

		const engine = await makeEngine("pk-e2e-docx-");
		try {
			const { chunkCount, kb } = await engine.add(docxPath, "DOCX Fixture");
			expect(chunkCount).toBeGreaterThan(0);
			expect(kb.file_count).toBe(1);
		} finally {
			await engine.dispose();
		}
	});

	it("fires watcher updates for filesystem changes", async () => {
		const watchDir = makeTempDir("pk-e2e-watch-");
		let updates = 0;
		startWatcher("watch-test", watchDir, () => {
			updates += 1;
		});

		if (getActiveWatcherCount() === 0) {
			expect.soft(getActiveWatcherCount(), "Recursive fs.watch is not available on this platform").toBeGreaterThan(0);
			return;
		}

		writeFileSync(join(watchDir, "note.txt"), "watcher integration update");
		await wait(6_000);
		expect(updates).toBeGreaterThan(0);
	}, 10_000);
});
