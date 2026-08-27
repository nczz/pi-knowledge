import { describe, expect, it } from "vitest";
import { buildChunkEmbeddingText } from "../../src/indexer/chunker.ts";
import { analyzeCodeWithAST, chunkWithAST, parseCodeStructure } from "../../src/indexer/chunkers/code-ast.ts";

function metadata(chunk: { metadata_json: string }) {
	return JSON.parse(chunk.metadata_json) as Record<string, unknown>;
}

describe("AST code analysis", () => {
	it("uses chunk identity that includes file path and line metadata", async () => {
		const code = "export function same(): number { return 1; }";
		const [first] = await chunkWithAST(code, "src/a.ts", "typescript");
		const [second] = await chunkWithAST(code, "src/b.ts", "typescript");
		const [shifted] = await chunkWithAST(`\n${code}`, "src/a.ts", "typescript");

		expect(first.content).toBe(second.content);
		expect(first.content_hash).not.toBe(second.content_hash);
		expect(first.content).toBe(shifted.content);
		expect(metadata(shifted).start_line).toBe(2);
		expect(first.content_hash).not.toBe(shifted.content_hash);
	});

	it("keeps a small class coherent while retaining method symbols", async () => {
		const code = [
			"export class AuthenticationService {",
			"  authenticate(): boolean { return true; }",
			"  refreshToken(): string { return 'token'; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunkMetadata = metadata(analysis.chunks[0]);

		expect(analysis.chunks).toHaveLength(1);
		expect(chunkMetadata.symbol).toBe("AuthenticationService");
		expect(chunkMetadata.symbol_kind).toBe("class");
		expect(analysis.symbols.map((symbol) => symbol.name)).toEqual([
			"AuthenticationService",
			"authenticate",
			"refreshToken",
		]);
		expect(analysis.symbols.find((symbol) => symbol.name === "refreshToken")?.container_name).toBe(
			"AuthenticationService",
		);
	});

	it("recursively splits oversized classes, packs small siblings, and bounds oversized leaves", async () => {
		const hugeBody = `return "${"x".repeat(7_000)}";`;
		const code = [
			"class LargeService {",
			`  hugeMethod(): string { ${hugeBody} }`,
			"  methodA(): number { return 1; }",
			"  methodB(): number { return 2; }",
			"  methodC(): number { return 3; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/large.ts", "typescript");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol_kind === "class")).toBe(false);
		expect(allMetadata.filter((item) => item.symbol === "hugeMethod")).toHaveLength(2);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.some((item) => item.symbol_kind === "group" && Array.isArray(item.symbols))).toBe(true);
	});

	it("normalizes exported arrows, decorators, and class field methods", async () => {
		const code = [
			"@sealed",
			"export class DecoratedService {",
			"  run = async () => 'ok';",
			"}",
			"export const runUpdate = async () => 1;",
		].join("\n");

		const structure = await parseCodeStructure(code, "typescript");
		const analysis = await analyzeCodeWithAST(code, "src/decorated.ts", "typescript");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const classNode = structure.children.find((node) => node.name === "DecoratedService");

		expect(names).toContain("DecoratedService");
		expect(names).toContain("run");
		expect(names).toContain("runUpdate");
		expect(classNode?.exported).toBe(true);
		expect(classNode?.decorators).toEqual(["@sealed"]);
		expect(analysis.chunks.some((chunk) => metadata(chunk).symbol === "runUpdate")).toBe(true);
	});

	it("adds structural context to embedding text without changing returned content", async () => {
		const code = "class Auth { refreshToken(token: string): string { return token; } }";
		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunk = analysis.chunks[0];
		const embeddingText = buildChunkEmbeddingText(chunk);

		expect(chunk.content).toBe(code);
		expect(embeddingText).toContain("Language: typescript");
		expect(embeddingText).toContain("Scope: Auth");
		expect(embeddingText).toContain("Kind: class");
		expect(embeddingText).toContain("Symbol: Auth");
	});

	it("loads the tree-sitter baseline for every supported AST language", async () => {
		const cases = [
			{
				language: "typescript",
				filePath: "src/service.ts",
				code: "export class Service { run(): number { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "javascript",
				filePath: "src/service.js",
				code: "export class Service { run() { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "python",
				filePath: "service.py",
				code: "class Service:\n    def run(self):\n        return 1\n",
				symbols: ["Service", "run"],
			},
			{
				language: "go",
				filePath: "service.go",
				code: "package service\nfunc Run() int { return 1 }\n",
				symbols: ["Run"],
			},
			{
				language: "rust",
				filePath: "service.rs",
				code: "pub fn run() -> i32 { 1 }\n",
				symbols: ["run"],
			},
			{
				language: "java",
				filePath: "Service.java",
				code: "class Service { int run() { return 1; } }",
				symbols: ["Service", "run"],
			},
		];

		for (const item of cases) {
			const analysis = await analyzeCodeWithAST(item.code, item.filePath, item.language);
			const names = analysis.symbols.map((symbol) => symbol.name);

			expect(analysis.chunks.length, item.language).toBeGreaterThan(0);
			for (const symbol of item.symbols) expect(names, item.language).toContain(symbol);
			expect(metadata(analysis.chunks[0]).language).toBe(item.language);
		}
	});
});
