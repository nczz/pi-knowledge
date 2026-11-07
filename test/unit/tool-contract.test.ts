import { beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../index.ts";

const toolState = vi.hoisted(() => ({
	searchResponse: {
		results: [
			{
				content: "content",
				file_path: "src/engine.ts",
				file_type: "typescript",
				kb_name: "repo",
				score: 0.9,
				snippet: "export function search() {}",
				start_line: 1,
				end_line: 1,
				ranking: {
					base_score: 0.8,
					adjusted_score: 0.9,
					coverage: 1,
					path_boost: 0.2,
					source_boost: 0.1,
					is_test: false,
				},
				provenance: {
					chunk_id: "chunk-1",
					chunk_hash: "abcdef1234567890",
					indexed_at: 123,
					source_mtime: 456,
					stale: false,
					match_reason: "hybrid",
					source_chunk_ids: ["chunk-1"],
				},
			},
		],
		total_count: 1,
		has_more: false,
		mode_used: "hybrid",
		tuning: {
			requested_profile: "auto",
			selected_profile: "balanced",
			limit: 10,
			snippet_max_length: 240,
			min_hybrid_score: 0.18,
			candidate_limit: 120,
			retrieval_limit_per_kb: 120,
			retrieved_candidates: 120,
			filtered_candidates: 80,
			diversity_candidates: 80,
			candidate_pool_truncated: false,
			candidate_min: 50,
			candidate_multiplier: 12,
			adaptive_context_lines: 80,
			adaptive_max_context_chars: 6000,
			adaptive_neighbor_target: 5,
			deep_rerank_candidates: 30,
			deep_rerank_top_k_multiplier: 3,
		},
	},
	searchOptions: undefined as unknown,
	removeTargets: [] as string[],
	clearCalls: 0,
	doctorReport: {
		health_score: 65,
		summary: "1 blocking, 0 warning, 0 info issues.",
		issues: [
			{
				severity: "blocking",
				kb_name: "repo",
				message: "Knowledge base is in error state and is skipped by search.",
				action: "Run knowledge_remove and knowledge_add to rebuild it from the source.",
				action_code: "rebuild_kb",
			},
		],
		diagnostics: [],
		actions: [
			{
				code: "rebuild_kb",
				kb_name: "repo",
				target: "repo",
				description: "Run knowledge_remove and knowledge_add to rebuild it from the source.",
			},
		],
	},
}));

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {}

		plan(_source: string, _options: unknown, signal?: AbortSignal): unknown {
			if (signal?.aborted) throw new Error("Cancelled");
			return {
				source_type: "directory",
				scannable_files: 1,
				scannable_bytes: 12,
				skipped: { total: 0, by_reason: {}, samples: [] },
				summary: "Directory plan: 1 scannable file",
			};
		}

		list(signal?: AbortSignal): [] {
			if (signal?.aborted) throw new Error("Cancelled");
			return [];
		}

		async search(_query: string, options: unknown): Promise<typeof toolState.searchResponse> {
			toolState.searchOptions = options;
			return toolState.searchResponse;
		}

		symbolSearch(_query: string, _options: unknown, signal?: AbortSignal): unknown {
			if (signal?.aborted) throw new Error("Cancelled");
			return { results: [], total_count: 0, has_more: false };
		}

		async update(_target: string, _onProgress: unknown, signal?: AbortSignal): Promise<unknown> {
			if (signal?.aborted) throw new Error("Cancelled");
			return { added: 0, removed: 0, unchanged: 0 };
		}

		remove(target: string): boolean {
			toolState.removeTargets.push(target);
			return true;
		}

		clear(): void {
			toolState.clearCalls++;
		}

		doctor(signal?: AbortSignal): typeof toolState.doctorReport {
			if (signal?.aborted) throw new Error("Cancelled");
			return toolState.doctorReport;
		}

		async exportKB(_target: string, _output: string, signal?: AbortSignal): Promise<number> {
			if (signal?.aborted) throw new Error("Cancelled");
			return 1;
		}

		async dispose(): Promise<void> {}
	},
}));

vi.mock("../../src/storage/sqlite.ts", () => ({
	getDefaultKnowledgeDir(): string {
		return "/tmp/pi-knowledge-tool-contract";
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount(): number {
		return 0;
	},
	startWatcher(): void {},
	stopAllWatchers(): void {},
}));

describe("public tool contracts", () => {
	beforeEach(() => {
		vi.resetModules();
		toolState.searchOptions = undefined;
		toolState.removeTargets = [];
		toolState.clearCalls = 0;
	});

	it("declares host approval tiers for every public tool", async () => {
		const tools = await registeredTools();
		const approvalTiers = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.approval]));

		expect(approvalTiers).toEqual({
			knowledge_add: "write",
			knowledge_clear: "write",
			knowledge_configure: "write",
			knowledge_doctor: "read",
			knowledge_export: "write",
			knowledge_import: "write",
			knowledge_plan: "read",
			knowledge_remove: "write",
			knowledge_search: "read",
			knowledge_show: "read",
			knowledge_status: "read",
			knowledge_symbol_search: "read",
			knowledge_update: "write",
		});
	});

	it("exposes structured doctor actions", async () => {
		const tools = await registeredTools();
		const result = await tools.knowledge_doctor.execute?.("doctor", {}, undefined, undefined, undefined);

		expect(result?.details).toEqual(toolState.doctorReport);
		expect(result?.content[0].text).toContain("Action (rebuild_kb):");
	});

	it("exposes search diagnostics details and freshness fields", async () => {
		const tools = await registeredTools();
		const result = await tools.knowledge_search.execute?.(
			"search",
			{ query: "search", diagnostics: true },
			undefined,
			undefined,
			undefined,
		);

		expect(result?.details).toEqual(toolState.searchResponse);
		expect(result?.content[0].text).toContain("indexed_at=123");
		expect(result?.content[0].text).toContain("source_mtime=456");
		expect(result?.content[0].text).toContain("profile: auto->balanced");
		expect(result?.content[0].text).toContain("Tuning: limit=10");
	});

	it("passes path_pattern from the search tool into engine filters", async () => {
		const tools = await registeredTools();

		await tools.knowledge_search.execute?.(
			"search",
			{ query: "search", path_pattern: "src/engine.ts", file_type: "typescript", profile: "low_token" },
			undefined,
			undefined,
			undefined,
		);

		expect(toolState.searchOptions).toMatchObject({
			profile: "low_token",
			filters: { file_type: "typescript", path_pattern: "src/engine.ts" },
		});
	});

	it("requires explicit confirmation before destructive remove and clear wrapper calls", async () => {
		const tools = await registeredTools();

		await expect(
			tools.knowledge_remove.execute?.("remove", { target: "repo" }, undefined, undefined, undefined),
		).rejects.toThrow(/confirm=true/i);
		await expect(tools.knowledge_clear.execute?.("clear", {}, undefined, undefined, undefined)).rejects.toThrow(
			/confirm=true/i,
		);
		expect(toolState.removeTargets).toEqual([]);
		expect(toolState.clearCalls).toBe(0);

		await expect(
			tools.knowledge_remove.execute?.("remove", { target: "repo", confirm: true }, undefined, undefined, undefined),
		).resolves.toMatchObject({ content: [{ text: "Removed." }] });
		await expect(
			tools.knowledge_clear.execute?.("clear", { confirm: true }, undefined, undefined, undefined),
		).resolves.toMatchObject({ content: [{ text: "All knowledge bases cleared." }] });
		expect(toolState.removeTargets).toEqual(["repo"]);
		expect(toolState.clearCalls).toBe(1);
	});

	it("guides empty symbol lookups toward fallback search and doctor checks", async () => {
		const tools = await registeredTools();

		const result = await tools.knowledge_symbol_search.execute?.(
			"symbols",
			{ query: "missingSymbol", exact: true },
			undefined,
			undefined,
			undefined,
		);

		expect(result?.content[0].text).toMatch(/knowledge_search/i);
		expect(result?.content[0].text).toMatch(/knowledge_doctor/i);
	});

	it("propagates cancellation to directory planning and update execution", async () => {
		const tools = await registeredTools();
		const controller = new AbortController();
		controller.abort();

		await expect(
			tools.knowledge_plan.execute?.("plan", { source: "/repo" }, controller.signal, undefined, undefined),
		).rejects.toThrow("Cancelled");
		await expect(
			tools.knowledge_update.execute?.("update", { target: "repo" }, controller.signal, undefined, undefined),
		).rejects.toThrow("Cancelled");
	});

	it("rejects symbol lookup and show tools when their signal is already aborted", async () => {
		const tools = await registeredTools();
		const controller = new AbortController();
		controller.abort();

		await expect(
			tools.knowledge_symbol_search.execute?.(
				"symbols",
				{ query: "knowledgeSearch" },
				controller.signal,
				undefined,
				undefined,
			),
		).rejects.toThrow("Cancelled");
		await expect(tools.knowledge_show.execute?.("show", {}, controller.signal, undefined, undefined)).rejects.toThrow(
			"Cancelled",
		);
	});
});

type RegisteredTool = Parameters<Parameters<typeof extension>[0]["registerTool"]>[0];

async function registeredTools(): Promise<Record<string, RegisteredTool>> {
	const tools: Record<string, RegisteredTool> = {};
	const pi = {
		on(): void {},
		registerTool(tool: RegisteredTool): void {
			tools[tool.name] = tool;
		},
	} as Parameters<typeof extension>[0];
	extension(pi);
	return tools;
}
