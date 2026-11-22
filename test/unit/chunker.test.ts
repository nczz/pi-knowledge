import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildChunkEmbeddingText,
	chunkFile,
	chunkIdentityHash,
	chunkMarkdown,
	chunkText,
	contentHash,
	createSkippedScanStats,
	iterateScannableFiles,
	iterateScannableFilesAsync,
	iterateScannableFileVisitsAsync,
	iterateScannedFiles,
	preTokenizeForFTS,
	resolveDirectoryScanTimeoutMs,
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
	it("splits oversized single paragraphs into bounded chunks", () => {
		const chunks = chunkMarkdown(`## Big Section\n\nLongMarkdownToken ${"x".repeat(20_000)}`, "big.md");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(chunks[0].content).toContain("## Big Section");
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

	it("can include suggested-excluded text after explicit confirmation", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, ".env"), "CONFIRMED_ENV_TEXT=1");
		writeFileSync(join(tmp, "node_modules", "x.js"), "export const ConfirmedVendorText = true;");
		writeFileSync(join(tmp, "image.png"), Buffer.from([0x89, 0x50, 0x00]));

		const scan = walkDirDetailed(tmp, { includeSuggestedText: true });
		const paths = scan.files.map((file) => file.relPath);

		expect(paths).toContain(".env");
		expect(paths).toContain("node_modules/x.js");
		expect(paths).not.toContain("image.png");
		expect(scan.skipped.by_reason.binary).toBe(1);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("can include a focused suggested-excluded path without including the whole suggested tree", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "node_modules", "chosen"), { recursive: true });
		mkdirSync(join(tmp, "node_modules", "other"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "chosen", "index.js"), "export const ChosenVendorText = true;");
		writeFileSync(join(tmp, "node_modules", "other", "index.js"), "export const OtherVendorText = true;");

		const scan = walkDirDetailed(tmp, { includePaths: ["node_modules/chosen/index.js"] });
		const paths = scan.files.map((file) => file.relPath);

		expect(paths).toContain("node_modules/chosen/index.js");
		expect(paths).not.toContain("node_modules/other/index.js");
		expect(scan.skipped.by_reason.suggested_excluded).toBeGreaterThan(0);
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
		expect(scan.skipped.by_reason.suggested_excluded).toBeGreaterThan(0);
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

describe("directory scan timeout", () => {
	it("defaults to no wall-clock limit and validates explicit configuration", () => {
		expect(resolveDirectoryScanTimeoutMs({})).toBe(0);
		expect(resolveDirectoryScanTimeoutMs({ PI_KNOWLEDGE_SCAN_TIMEOUT_MS: "0" })).toBe(0);
		expect(resolveDirectoryScanTimeoutMs({ PI_KNOWLEDGE_SCAN_TIMEOUT_MS: "900000" })).toBe(900_000);
		for (const value of ["-1", "1.5", "unbounded", "9007199254740992"]) {
			expect(() => resolveDirectoryScanTimeoutMs({ PI_KNOWLEDGE_SCAN_TIMEOUT_MS: value })).toThrow(
				"PI_KNOWLEDGE_SCAN_TIMEOUT_MS",
			);
		}
	});

	it("enforces an opt-in timeout while zero remains unbounded", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-async-timeout-"));
		writeFileSync(join(root, "a.ts"), "export const A = true;");
		writeFileSync(join(root, "b.ts"), "export const B = true;");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const timed = iterateScannableFileVisitsAsync(root, createSkippedScanStats(), { timeoutMs: 100 });
			await timed.next();
			await timed.next();
			vi.setSystemTime(1_101);
			await expect(timed.next()).rejects.toThrow(
				"configured 100ms wall-clock limit after visiting 1 entries and yielding 1 files",
			);

			vi.setSystemTime(2_000);
			const unbounded = iterateScannableFileVisitsAsync(root, createSkippedScanStats(), { timeoutMs: 0 });
			await unbounded.next();
			await unbounded.next();
			vi.setSystemTime(60 * 60_000);
			while (!(await unbounded.next()).done) {
				// Consume the remaining visits after advancing beyond the former five-minute limit.
			}
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("async bounded directory scanning", () => {
	it.skipIf(process.platform === "win32")("does not follow symbolic links outside the source root", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-async-scan-"));
		const outside = mkdtempSync(join(tmpdir(), "pk-async-outside-"));
		writeFileSync(join(outside, "outside.ts"), "export const OutsideScanToken = true;");
		symlinkSync(outside, join(root, "linked"));
		try {
			const files: string[] = [];
			for await (const file of iterateScannableFilesAsync(root)) files.push(file.relPath);
			expect(files).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects an oversized gitignore before loading it into memory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-async-scan-"));
		writeFileSync(join(root, ".gitignore"), "x".repeat(1024 * 1024 + 1));
		try {
			const collect = async (): Promise<void> => {
				for await (const _file of iterateScannableFilesAsync(root)) {
					/* consume */
				}
			};
			await expect(collect()).rejects.toThrow("Scan configuration exceeds");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects known binary extensions before opening their text-like payload", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-async-scan-"));
		writeFileSync(join(root, "archive.zip"), "text payload without NUL bytes");
		try {
			const skipped = createSkippedScanStats();
			const files: string[] = [];
			for await (const file of iterateScannableFilesAsync(root, skipped)) files.push(file.relPath);
			expect(files).toEqual([]);
			expect(skipped.by_reason.binary).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
