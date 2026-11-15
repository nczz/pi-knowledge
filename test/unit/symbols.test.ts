import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { analyzeIndexableContent } from "../../src/indexer/chunker.ts";
import { extractSymbols } from "../../src/indexer/symbols.ts";
import { createKB, insertSymbols, openDatabase, searchSymbols, updateKBStatus } from "../../src/storage/sqlite.ts";

const TEST_DIR = "/tmp/pk-test-symbols";

describe("lightweight symbol index", () => {
	let db: Database.Database;

	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		db = openDatabase(TEST_DIR);
	});

	afterEach(() => {
		db.close();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("extracts code symbols, markdown headings, config keys, and env vars", () => {
		const code = extractSymbols(
			[
				"export function knowledgeSearch() {}",
				"export class KnowledgeEngine {}",
				"const runUpdate = async () => {};",
			].join("\n"),
			"src/engine.ts",
			"typescript",
		);
		const markdown = extractSymbols("# Install\n\n## OMP Support", "README.md", "markdown");
		const json = extractSymbols('{\n  "PI_KNOWLEDGE_DIR": "/tmp"\n}', "package.json", "json");
		const env = extractSymbols("OPENAI_BASE_URL=https://example.test", ".env.example", "text");
		const routes = extractSymbols(
			["const app = express();", 'app.get("/api/orders/:id", handler);', 'router.post("/api/orders", handler);'].join(
				"\n",
			),
			"src/routes.ts",
			"typescript",
		);

		expect(code.map((symbol) => symbol.name)).toContain("knowledgeSearch");
		expect(code.map((symbol) => symbol.name)).toContain("KnowledgeEngine");
		expect(code.map((symbol) => symbol.name)).toContain("runUpdate");
		expect(markdown.map((symbol) => symbol.name)).toEqual(["Install", "OMP Support"]);
		expect(json[0]).toMatchObject({ name: "PI_KNOWLEDGE_DIR", kind: "config_key" });
		expect(env[0]).toMatchObject({ name: "OPENAI_BASE_URL", kind: "env_var" });
		expect(routes.filter((symbol) => symbol.kind === "route").map((symbol) => symbol.name)).toEqual([
			"GET /api/orders/:id",
			"POST /api/orders",
		]);
	});

	it("does not index test-framework calls as function symbols", () => {
		const symbols = extractSymbols(
			[
				'describe("knowledge tools", function() {',
				'  it("registers a tool", function() {',
				'    registerTool({ name: "knowledge_search" });',
				"  });",
				"});",
			].join("\n"),
			"test/unit/tool-contract.test.ts",
			"typescript",
		);

		expect(symbols.filter((symbol) => symbol.kind === "function").map((symbol) => symbol.name)).toEqual([]);
	});

	it("extracts AST-backed method symbols independently from retrieval chunks", async () => {
		const analysis = await analyzeIndexableContent(
			[
				"export class AuthenticationService {",
				"  authenticate(): boolean { return true; }",
				"  refreshToken(): string { return 'token'; }",
				"}",
			].join("\n"),
			"src/auth.ts",
			"typescript",
		);

		const method = analysis.symbols.find((symbol) => symbol.name === "refreshToken");
		expect(analysis.chunks).toHaveLength(1);
		expect(method).toMatchObject({
			kind: "function",
			container_name: "AuthenticationService",
			signature: "refreshToken(): string",
		});
		expect(JSON.parse(method?.metadata_json ?? "{}")).toMatchObject({
			symbol_kind: "method",
			scope: ["AuthenticationService", "refreshToken"],
		});
	});

	it("stores and searches symbols by exact or substring match", () => {
		const kb = createKB(db, { name: "repo", source_type: "text" });
		insertSymbols(db, kb.id, [
			...extractSymbols("export function knowledgeSearch() {}", "src/engine.ts", "typescript"),
			...extractSymbols("export function knowledgeStatus() {}", "src/status.ts", "typescript"),
		]);

		expect(searchSymbols(db, "knowledgeSearch", { exact: true })).toHaveLength(1);
		expect(searchSymbols(db, "knowledge", { exact: false })).toHaveLength(2);
		expect(searchSymbols(db, "knowledgeSearch", { kind: "config_key" })).toHaveLength(0);
	});

	it("exposes symbol lookup through KnowledgeEngine", async () => {
		const engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		const kb = createKB(db, { name: "repo", source_type: "text" });
		insertSymbols(db, kb.id, extractSymbols("# Release Checklist", "README.md", "markdown"));

		const result = engine.symbolSearch("Release Checklist", { exact: true });

		expect(result.results).toHaveLength(1);
		expect(result.total_count).toBe(1);
		expect(result.results[0]).toMatchObject({
			name: "Release Checklist",
			kind: "heading",
			file_path: "README.md",
			kb_name: "repo",
		});
		await engine.dispose({ disposeModels: false });
	});

	it("reports real totals and classifies symbol lookup misses", async () => {
		const engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		const kb = createKB(db, { name: "repo", source_type: "text" });
		insertSymbols(db, kb.id, [
			...extractSymbols("export function alphaSymbol() {}", "src/a.ts", "typescript"),
			...extractSymbols("export function alphabetSymbol() {}", "src/b.ts", "typescript"),
			...extractSymbols("export function alpineSymbol() {}", "src/c.ts", "typescript"),
		]);

		const result = engine.symbolSearch("alp", { limit: 2 });
		const unknownKb = engine.symbolSearch("alp", { kb_id: "missing" });
		const exactMiss = engine.symbolSearch("missingSymbol", { exact: true });
		const filteredMiss = engine.symbolSearch("alphaSymbol", { exact: true, kind: "heading" });
		const emptyPage = engine.symbolSearch("alp", { limit: 2, offset: 3 });

		expect(result.results).toHaveLength(2);
		expect(result.total_count).toBe(3);
		expect(result.has_more).toBe(true);
		expect(unknownKb.miss).toMatchObject({
			reason: "knowledge_base_not_found",
			action: "fix_kb_id",
			requested_kb_id: "missing",
		});
		expect(exactMiss.miss).toMatchObject({
			reason: "exact_name_not_found",
			action: "broaden_symbol_search",
			indexed_symbols: 3,
		});
		expect(filteredMiss.miss).toMatchObject({
			reason: "metadata_filtered",
			action: "relax_filter",
			unfiltered_matches: 1,
		});
		expect(emptyPage.miss).toMatchObject({
			reason: "page_out_of_range",
			action: "reset_offset",
		});
		await engine.dispose({ disposeModels: false });
	});

	it("distinguishes an empty store from an empty symbol index", async () => {
		const engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);

		const emptyStore = engine.symbolSearch("missing");
		createKB(db, { name: "repo", source_type: "text" });
		const emptyIndex = engine.symbolSearch("missing");

		expect(emptyStore.miss?.reason).toBe("no_knowledge_bases");
		expect(emptyIndex.miss).toMatchObject({
			reason: "symbol_index_empty",
			action: "rebuild_symbol_index",
			indexed_symbols: 0,
		});
		await engine.dispose({ disposeModels: false });
	});

	it("does not expose symbols from indexing or error knowledge bases", async () => {
		const ready = createKB(db, { name: "ready", source_type: "text" });
		const indexing = createKB(db, { name: "indexing", source_type: "text" });
		const errored = createKB(db, { name: "errored", source_type: "text" });
		updateKBStatus(db, indexing.id, "indexing");
		updateKBStatus(db, errored.id, "error");
		for (const kb of [ready, indexing, errored]) {
			insertSymbols(db, kb.id, extractSymbols("export function guardedSymbol() {}", `${kb.name}.ts`, "typescript"));
		}

		expect(searchSymbols(db, "guardedSymbol", { exact: true })).toHaveLength(1);
		const engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		expect(engine.symbolSearch("guardedSymbol", { exact: true }).results.map((result) => result.kb_name)).toEqual([
			"ready",
		]);
		await engine.dispose({ disposeModels: false });
	});
});
