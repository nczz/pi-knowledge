import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildChunkEmbeddingText,
	chunkMarkdown,
	chunkText,
	contentHash,
	preTokenizeForFTS,
	walkDir,
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
	it("empty → no chunks", () => expect(chunkText("", "t.txt")).toEqual([]));
});

describe("walkDir", () => {
	const tmp = "/tmp/pk-test-walk";
	it("respects ignores and skips binary", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "src"), { recursive: true });
		mkdirSync(join(tmp, "docs"), { recursive: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, "src/a.ts"), "export const a = 1;");
		writeFileSync(join(tmp, "node_modules/x.js"), "no");
		writeFileSync(join(tmp, "b.png"), Buffer.from([0x89, 0x50, 0x00]));
		writeFileSync(join(tmp, "c.md"), "# C\n\nContent");
		writeFileSync(join(tmp, "docs/knowledge-base-full-evaluation-report.md"), "# Generated evaluation");
		const paths = walkDir(tmp).map((f) => f.relPath);
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("c.md");
		expect(paths).not.toContain("node_modules/x.js");
		expect(paths).not.toContain("b.png");
		expect(paths).not.toContain("docs/knowledge-base-full-evaluation-report.md");
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
