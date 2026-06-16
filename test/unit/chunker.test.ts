import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildChunkEmbeddingText,
	chunkIdentityHash,
	chunkMarkdown,
	chunkText,
	contentHash,
	createSkippedScanStats,
	iterateScannableFiles,
	iterateScannedFiles,
	preTokenizeForFTS,
	summarizeSkippedScan,
	walkDir,
	walkDirDetailed,
} from "../../src/indexer/chunker.ts";

describe("preTokenizeForFTS", () => {
	it("splits camelCase", () => expect(preTokenizeForFTS("getElementById")).toBe("get Element By Id"));
	it("splits ACRONYM", () => expect(preTokenizeForFTS("HTMLElement")).toBe("HTML Element"));
	it("splits numbers", () => expect(preTokenizeForFTS("item1value")).toBe("item 1 value"));
	it("CJK per-char", () => expect(preTokenizeForFTS("認證流程")).toBe("認 證 流 程"));
	it("mixed", () => expect(preTokenizeForFTS("getUser認證")).toBe("get User 認 證"));
	it("empty", () => expect(preTokenizeForFTS("")).toBe(""));
	it("snake_case unchanged", () => expect(preTokenizeForFTS("snake_case")).toBe("snake_case"));
});

describe("contentHash", () => {
	it("consistent", () => expect(contentHash("x")).toBe(contentHash("x")));
	it("64 hex chars", () => expect(contentHash("x")).toHaveLength(64));
	it("different input → different hash", () => expect(contentHash("a")).not.toBe(contentHash("b")));
});

describe("chunkIdentityHash", () => {
	const base = {
		content: "same content",
		fileType: "typescript",
		startLine: 1,
		endLine: 2,
		metadataJson: "{}",
	};

	it("distinguishes duplicate content in different files", () => {
		expect(chunkIdentityHash({ ...base, filePath: "a.ts" })).not.toBe(chunkIdentityHash({ ...base, filePath: "b.ts" }));
	});

	it("distinguishes duplicate content at different locations", () => {
		expect(chunkIdentityHash({ ...base, filePath: "a.ts", startLine: 1, endLine: 2 })).not.toBe(
			chunkIdentityHash({ ...base, filePath: "a.ts", startLine: 10, endLine: 11 }),
		);
	});
});

describe("chunkMarkdown", () => {
	it("splits on headings", () => {
		const md =
			"## S1\n\nContent for section one that is long enough to pass threshold.\n\n## S2\n\nContent for section two that is also long enough to pass.";
		expect(chunkMarkdown(md, "t.md").length).toBe(2);
	});
	it("keeps heading in chunk", () => {
		const md = "## Title\n\nContent that is definitely long enough to pass the minimum char threshold.";
		expect(chunkMarkdown(md, "t.md")[0].content).toContain("## Title");
	});
	it("adds heading breadcrumb and file context to indexed text", () => {
		const md = [
			"# Product",
			"## Billing",
			"### Refunds",
			"RefundPolicyToken content that is definitely long enough to pass the minimum char threshold.",
		].join("\n\n");
		const [chunk] = chunkMarkdown(md, "docs/billing.md");
		expect(chunk.metadata_json).toContain("Product > Billing > Refunds");
		expect(chunk.content_tokenized).toContain("docs/billing.md");
		expect(buildChunkEmbeddingText(chunk)).toContain("Section: Product > Billing > Refunds");
	});
	it("splits large sections into focused contextual chunks", () => {
		const para = "FocusedMarkdownToken paragraph with enough detail about one specific retrieval subject. ".repeat(20);
		const md = `## Big Section\n\n${Array(8).fill(para).join("\n\n")}`;
		const chunks = chunkMarkdown(md, "big.md");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.metadata_json.includes("Big Section"))).toBe(true);
	});
	it("skips short sections", () => {
		const md = "## A\n\nHi\n\n## B\n\nThis section passes the fifty character minimum threshold for valid chunks.";
		const chunks = chunkMarkdown(md, "t.md");
		expect(chunks.length).toBe(1);
		expect(chunks[0].content).toContain("## B");
	});
	it("empty → no chunks", () => expect(chunkMarkdown("", "t.md")).toEqual([]));
});

describe("chunkText", () => {
	it("chunks long content", () => {
		const para =
			"This is a substantial paragraph with enough words to contribute meaningful token count towards the chunk size target. ".repeat(
				5,
			);
		const text = Array(10).fill(para).join("\n\n");
		expect(chunkText(text, "t.txt").length).toBeGreaterThan(1);
	});
	it("does not overlap paragraphs between adjacent text chunks", () => {
		const paragraphs = Array.from({ length: 8 }, (_, i) =>
			`UniqueTextParagraph${i} has enough meaningful detail for contextual retrieval without overlap. `.repeat(8),
		);
		const chunks = chunkText(paragraphs.join("\n\n"), "t.txt");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].content).not.toContain("UniqueTextParagraph7");
		expect(chunks[1].content).not.toContain("UniqueTextParagraph0");
	});
	it("splits oversized single paragraphs into bounded chunks", () => {
		const chunks = chunkText(`LongLineToken ${"x".repeat(20_000)}`, "backup.jsonl");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(chunks[0].content).toContain("LongLineToken");
	});
	it("empty → no chunks", () => expect(chunkText("", "t.txt")).toEqual([]));
});

describe("walkDir", () => {
	const tmp = "/tmp/pk-test-walk";
	it("respects ignores and skips binary", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "src"), { recursive: true });
		mkdirSync(join(tmp, "docs"), { recursive: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		mkdirSync(join(tmp, "packages", "playwright-core", "src", "server", "chromium"), { recursive: true });
		mkdirSync(join(tmp, "browsers", "Chromium.app", "Contents", "Resources", "en.lproj"), { recursive: true });
		writeFileSync(join(tmp, "src/a.ts"), "export const a = 1;");
		writeFileSync(
			join(tmp, "packages", "playwright-core", "src", "server", "chromium", "crBrowser.ts"),
			"export class BrowserSource {}",
		);
		writeFileSync(join(tmp, "node_modules/x.js"), "no");
		writeFileSync(join(tmp, "b.png"), Buffer.from([0x89, 0x50, 0x00]));
		writeFileSync(join(tmp, "c.md"), "# C\n\nContent");
		writeFileSync(join(tmp, "docs/knowledge-base-full-evaluation-report.md"), "# Generated evaluation");
		writeFileSync(join(tmp, "knowledge-backup.jsonl"), JSON.stringify({ exported: true }));
		writeFileSync(join(tmp, "browsers", "Chromium.app", "Contents", "Resources", "en.lproj", "locale.pak"), "no");
		const paths = walkDir(tmp).map((f) => f.relPath);
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("c.md");
		expect(paths).toContain("packages/playwright-core/src/server/chromium/crBrowser.ts");
		expect(paths).not.toContain("node_modules/x.js");
		expect(paths).not.toContain("b.png");
		expect(paths).not.toContain("docs/knowledge-base-full-evaluation-report.md");
		expect(paths).not.toContain("knowledge-backup.jsonl");
		expect(paths).not.toContain("browsers/Chromium.app/Contents/Resources/en.lproj/locale.pak");
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports skipped file reasons and samples", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, "src.ts"), "export const token = 'ScanToken';");
		writeFileSync(join(tmp, "node_modules", "ignored.js"), "ignored");
		writeFileSync(join(tmp, "image.png"), Buffer.from([0x89, 0x50, 0x00]));

		const scan = walkDirDetailed(tmp);

		expect(scan.files.map((file) => file.relPath)).toContain("src.ts");
		expect(scan.skipped.total).toBeGreaterThanOrEqual(2);
		expect(scan.skipped.by_reason.ignored).toBeGreaterThan(0);
		expect(scan.skipped.by_reason.binary).toBeGreaterThan(0);
		expect(scan.skipped.samples.some((sample) => sample.path.includes("node_modules"))).toBe(true);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("streams files while accumulating bounded skipped stats", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "src"), { recursive: true });
		for (let i = 0; i < 30; i++) writeFileSync(join(tmp, "src", `file-${i}.ts`), `export const value${i} = ${i};`);
		for (let i = 0; i < 40; i++) writeFileSync(join(tmp, `image-${i}.png`), Buffer.from([0x89, 0x50, 0x00]));
		const skipped = createSkippedScanStats();
		const paths: string[] = [];

		for (const file of iterateScannedFiles(tmp, skipped)) {
			if (paths.length < 5) paths.push(file.relPath);
		}

		expect(paths).toHaveLength(5);
		expect(skipped.samples.length).toBeLessThanOrEqual(25);
		expect(summarizeSkippedScan(skipped)).toContain("binary");
		rmSync(tmp, { recursive: true, force: true });
	});

	it("can scan file metadata without loading file content", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "large.ts"), `export const LargeMetadataToken = "${"x".repeat(1000)}";`);
		const skipped = createSkippedScanStats();

		const [file] = [...iterateScannableFiles(tmp, skipped)];

		expect(file.relPath).toBe("src/large.ts");
		expect(file.fileType).toBe("typescript");
		expect(file.size).toBeGreaterThan(1000);
		expect("content" in file).toBe(false);
		rmSync(tmp, { recursive: true, force: true });
	});
});

import { chunkFile } from "../../src/indexer/chunker.ts";

describe("chunkFile (async)", () => {
	it("dispatches .md to markdown chunker", async () => {
		const chunks = await chunkFile(
			"## Test\n\nContent that is long enough to pass the minimum character threshold.",
			"test.md",
		);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].file_type).toBe("markdown");
	});
	it("dispatches .ts to AST chunker", async () => {
		const code = 'export function hello(): string { return "hi"; }';
		const chunks = await chunkFile(code, "test.ts");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].metadata_json).toContain("hello");
	});
	it("falls back to text for unknown types", async () => {
		const text = Array(15).fill("A paragraph with enough meaningful content for testing purposes here.").join("\n\n");
		const chunks = await chunkFile(text, "data.csv");
		expect(chunks.length).toBeGreaterThan(0);
	});
});
