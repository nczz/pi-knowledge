import { MAX_SEARCH_RESULTS, MAX_SEARCH_WINDOW } from "./src/search/contracts.ts";
import { formatKnowledgeStatus } from "./src/status.ts";

type KnowledgeEngineInstance = import("./src/engine.ts").KnowledgeEngine;
type StorageRuntime = typeof import("./src/storage/sqlite.ts");
type WatcherRuntime = typeof import("./src/watcher/file-watcher.ts");

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };
type ToolUpdate = (result: ToolResult) => void;
type ToolApproval = "read" | "write" | "exec";
type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	approval?: ToolApproval;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: Schema;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdate | undefined,
		ctx: unknown,
	) => ToolResult | Promise<ToolResult>;
};
type ContextEvent = { messages: Array<{ role: string; content?: unknown }> };
type BeforeAgentStartEvent = { systemPrompt: string };
type ExtensionAPI = {
	on(event: "context", handler: (event: ContextEvent, ctx: unknown) => unknown): void;
	on(
		event: "before_agent_start",
		handler: (event: BeforeAgentStartEvent, ctx: unknown) => unknown | Promise<unknown>,
	): void;
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: unknown) => unknown): void;
	registerTool(tool: ToolDefinition): void;
};

type Schema = Record<string, unknown> & { optional?: true };

const Type = {
	Object(properties: Record<string, Schema>): Schema {
		const required = Object.entries(properties)
			.filter(([, schema]) => !schema.optional)
			.map(([name]) => name);
		const normalized = Object.fromEntries(
			Object.entries(properties).map(([name, schema]) => {
				const { optional: _optional, ...rest } = schema;
				return [name, rest];
			}),
		);
		return { type: "object", properties: normalized, required, additionalProperties: false };
	},
	String(options: Record<string, unknown> = {}): Schema {
		return { type: "string", ...options };
	},
	Number(options: Record<string, unknown> = {}): Schema {
		return { type: "number", ...options };
	},
	Boolean(options: Record<string, unknown> = {}): Schema {
		return { type: "boolean", ...options };
	},
	Literal(value: string): Schema {
		return { const: value };
	},
	Union(items: Schema[]): Schema {
		return { anyOf: items };
	},
	Array(item: Schema): Schema {
		return { type: "array", items: item };
	},
	Optional(schema: Schema): Schema {
		return { ...schema, optional: true };
	},
};

type Runtime = {
	engine: KnowledgeEngineInstance;
	storage: StorageRuntime;
	watcher: WatcherRuntime;
};

const RUNTIME_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const WATCH_ENABLED = process.env.PI_KNOWLEDGE_WATCH === "true";
const AUTO_INJECT = process.env.PI_KNOWLEDGE_AUTO_INJECT === "true";

let runtime: Runtime | undefined;
let runtimePromise: Promise<Runtime> | undefined;
let initializePromise: Promise<Runtime> | undefined;
let initialized = false;
let disposePromise: Promise<void> | undefined;

function scanOptionsFromSourceOptions(raw: string | null | undefined): {
	includeSuggestedText?: boolean;
	includePaths?: string[];
	excludePaths?: string[];
} {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as {
			include_suggested_text?: unknown;
			include_paths?: unknown;
			exclude_paths?: unknown;
		};
		return {
			includeSuggestedText: parsed.include_suggested_text === true,
			includePaths: Array.isArray(parsed.include_paths)
				? parsed.include_paths.filter((item): item is string => typeof item === "string")
				: undefined,
			excludePaths: Array.isArray(parsed.exclude_paths)
				? parsed.exclude_paths.filter((item): item is string => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

function runtimeModule(modulePath: string): string {
	return `${modulePath}${RUNTIME_EXTENSION}`;
}

async function loadRuntime(): Promise<Runtime> {
	if (disposePromise) await disposePromise;
	if (runtime) return runtime;
	runtimePromise ??= Promise.all([
		import(runtimeModule("./src/engine")),
		import(runtimeModule("./src/storage/sqlite")),
		import(runtimeModule("./src/watcher/file-watcher")),
	]).then(([engineModule, storage, watcher]) => {
		runtime = { engine: new engineModule.KnowledgeEngine(), storage, watcher };
		return runtime;
	});
	return runtimePromise;
}

async function ensureInitialized(): Promise<Runtime> {
	if (disposePromise) await disposePromise;
	if (initialized && runtime) return runtime;
	initializePromise ??= (async () => {
		const loaded = await loadRuntime();
		await loaded.engine.initialize(loaded.storage.getDefaultKnowledgeDir());
		initialized = true;
		return loaded;
	})();
	try {
		return await initializePromise;
	} catch (error) {
		initializePromise = undefined;
		throw error;
	}
}

async function disposeRuntime(): Promise<void> {
	if (disposePromise) return disposePromise;
	const pendingInitialize = initializePromise;
	const pendingRuntime = runtimePromise;
	disposePromise = (async () => {
		let loaded = runtime;
		if (!loaded && pendingInitialize) {
			try {
				loaded = await pendingInitialize;
			} catch {
				loaded = runtime;
			}
		}
		if (!loaded && pendingRuntime) {
			try {
				loaded = await pendingRuntime;
			} catch {
				loaded = runtime;
			}
		}
		initialized = false;
		initializePromise = undefined;
		runtime = undefined;
		runtimePromise = undefined;
		if (!loaded) return;
		loaded.watcher.stopAllWatchers();
		await loaded.engine.dispose({ disposeModels: false });
	})();
	try {
		await disposePromise;
	} finally {
		disposePromise = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const { engine, watcher } = await ensureInitialized();
		if (WATCH_ENABLED) {
			for (const kb of engine.list()) {
				if (kb.source_path && kb.source_type === "directory") {
					watcher.startWatcher(
						kb.id,
						kb.source_path,
						(kbId) => {
							engine.update(kbId).catch(() => {});
						},
						scanOptionsFromSourceOptions(kb.source_options),
					);
				}
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await disposeRuntime();
	});

	// Auto-inject: search KB for relevant context before each LLM call (opt-in)
	if (AUTO_INJECT) {
		pi.on("context", async (event) => {
			try {
				const { engine } = await ensureInitialized();
				const kbs = engine.list();
				if (kbs.length === 0) return;
				// Find last user message
				const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
				if (!lastUser) return;
				const text = "content" in lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
				if (!text || text.length < 5) return;
				const results = await engine.search(text, { mode: "fast", limit: 3 });
				if (results.results.length === 0) return;
				const context = results.results.map((r) => `[${r.file_path}]: ${r.snippet}`).join("\n\n");
				return {
					messages: [{ role: "user" as const, content: `[Knowledge context]\n${context}` }, ...event.messages],
				};
			} catch {
				/* silent fail */
			}
		});
	}

	pi.on("before_agent_start", async (event) => {
		const { engine } = await ensureInitialized();
		const kbs = engine.list();
		if (kbs.length === 0) return undefined;
		const desc = kbs.map((kb) => `"${kb.name}" (${kb.chunk_count} chunks, ${kb.file_count} files)`).join(", ");
		const guidance = `Available knowledge bases: ${desc}. Use knowledge_symbol_search for exact symbols/config keys/env vars/routes/headings, then use knowledge_search for broader domain or implementation context.`;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
		};
	});

	pi.registerTool({
		name: "knowledge_plan",
		label: "Knowledge Plan",
		description:
			"Inspect an indexing source without writing a KB, showing scannable counts, suggested exclusions, and technical skips",
		approval: "read",
		promptSnippet: "Plan a knowledge-base indexing scope before calling knowledge_add",
		promptGuidelines: [
			"Use knowledge_plan before knowledge_add for broad directories, large repositories, or sources that may contain private or low-signal text",
			"Show the user suggested exclusions, technical skips, and scannable file counts before asking whether to include risky or low-signal text",
			"After the user confirms scope, call knowledge_add with matching include_suggested_text, include_paths, or exclude_paths",
			"Do not use knowledge_plan as a substitute for knowledge_search; it only plans indexing scope",
		],
		parameters: Type.Object({
			source: Type.String({ description: "File path, directory path, URL, or inline text to inspect before indexing" }),
			include_suggested_text: Type.Optional(
				Type.Boolean({
					description:
						"Preview the scope if suggested-excluded text such as vendor/build/runtime/cache/secret-named text is included",
				}),
			),
			include_paths: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Relative paths under a directory source to include even when they match suggested-exclude patterns",
					}),
				),
			),
			exclude_paths: Type.Optional(
				Type.Array(Type.String({ description: "Relative paths under a directory source to exclude from this plan" })),
			),
		}),
		async execute(_id, params, _signal) {
			const { engine } = await ensureInitialized();
			const { source, include_suggested_text, include_paths, exclude_paths } = params as {
				source: string;
				include_suggested_text?: boolean;
				include_paths?: unknown;
				exclude_paths?: unknown;
			};
			const plan = engine.plan(
				source,
				{
					include_suggested_text: include_suggested_text === true,
					include_paths: Array.isArray(include_paths)
						? include_paths.filter((item) => typeof item === "string")
						: undefined,
					exclude_paths: Array.isArray(exclude_paths)
						? exclude_paths.filter((item) => typeof item === "string")
						: undefined,
				},
				_signal,
			);
			const samples = plan.skipped.samples
				.map((sample) => `- ${sample.reason}: ${sample.path}${sample.size ? ` (${sample.size} bytes)` : ""}`)
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							plan.summary,
							`Source type: ${plan.source_type}`,
							`Skipped summary: ${JSON.stringify(plan.skipped.by_reason)}`,
							samples ? `Skipped samples:\n${samples}` : "Skipped samples: none",
						].join("\n"),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "knowledge_configure",
		label: "Knowledge Configure",
		description: "Configure pi-knowledge runtime settings such as the isolated worker Node executable",
		approval: "write",
		promptSnippet: "Configure local pi-knowledge runtime prerequisites before indexing",
		promptGuidelines: [
			"Use knowledge_configure when knowledge_doctor or knowledge_add reports that local embeddings cannot find a usable Node executable",
			"On Windows, pass the full node.exe path when the user provides one; paths with spaces are accepted",
			"If node_path is omitted, the tool auto-discovers a usable Node 22+ executable and persists it for future sessions",
			"Do not switch users to API embeddings unless they explicitly choose a network embedding provider",
		],
		parameters: Type.Object({
			node_path: Type.Optional(
				Type.String({
					description:
						"Optional full path to a Node 22+ executable for the isolated local model and document extraction worker, such as C:\\Program Files\\nodejs\\node.exe",
				}),
			),
		}),
		async execute(_id, params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { configureModelWorkerNodePath } = await import(runtimeModule("./src/model-worker-client"));
			if (_signal?.aborted) throw new Error("Cancelled");
			const nodePath = typeof params.node_path === "string" && params.node_path.trim() ? params.node_path : undefined;
			const configuredPath = configureModelWorkerNodePath(nodePath);
			return {
				content: [
					{
						type: "text",
						text: `Configured isolated worker Node executable: ${configuredPath}`,
					},
				],
				details: { node_path: configuredPath },
			};
		},
	});

	pi.registerTool({
		name: "knowledge_add",
		label: "Knowledge Add",
		description: "Index files, directories, URLs, PDFs, DOCX, or text into a named knowledge base for semantic search",
		approval: "write",
		promptSnippet: "Index files/dirs/URLs/PDFs/DOCX/text into a searchable knowledge base",
		promptGuidelines: [
			"Use knowledge_plan first for broad directories, large repositories, or sources that may contain private or low-signal text",
			"Use knowledge_add when the user asks to index, remember, or learn from files, URLs, documents, or documentation",
			"Pass http:// or https:// sources directly for URL indexing",
			"Prefer one knowledge_add call for the project root or relevant directory with include_paths/exclude_paths; do not call it once per ordinary source file",
			"If the source looks like a local path, verify it exists before calling knowledge_add; non-existing non-URL path-like sources are rejected instead of treated as inline text",
			"If a knowledge base with the same name already exists, use knowledge_update only to refresh that KB's existing retained source; otherwise ask before removing/replacing it",
			"Index source, documentation, supported document files, and ordinary configuration files that explain how the project works",
			"Default directory indexing suggests excluding generated, vendor, browser runtime, obvious secret, and low-signal text artifacts; these are not permanent blocks",
			"For ambiguous or risky text such as .env, private keys, certificates, credential-named files, settings.json, appsettings.json, cloud config, editor config, generated reports, lockfiles, or vendor text, explain the tradeoff and ask the user before including it",
			"If the user confirms a suggested-excluded text file or directory should be indexed, call knowledge_add with include_suggested_text or a focused include_paths value so the tool follows the confirmed scope",
			"Non-text, unsupported binary, oversized, unreadable, and inaccessible files remain technical skips even when the user wants broad indexing",
			"Provide a descriptive name for this single knowledge base",
		],
		parameters: Type.Object({
			source: Type.String({ description: "File path, directory path, URL, PDF/DOCX path, or inline text to index" }),
			name: Type.String({ description: "Display name for this knowledge base" }),
			include_suggested_text: Type.Optional(
				Type.Boolean({
					description:
						"Include text files that are normally suggested for exclusion, such as vendor/build/runtime/cache/secret-named text, after user confirmation",
				}),
			),
			include_paths: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Relative paths under a directory source to include even when they match suggested-exclude patterns",
					}),
				),
			),
			exclude_paths: Type.Optional(
				Type.Array(Type.String({ description: "Relative paths under a directory source to exclude from this KB" })),
			),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { engine, watcher } = await ensureInitialized();
			const { source, name, include_suggested_text, include_paths, exclude_paths } = params as {
				source: string;
				name: string;
				include_suggested_text?: boolean;
				include_paths?: unknown;
				exclude_paths?: unknown;
			};
			const { kb, chunkCount } = await engine.add(
				source,
				name,
				(msg) => {
					onUpdate?.({ content: [{ type: "text", text: msg }] });
				},
				_signal,
				{
					include_suggested_text: include_suggested_text === true,
					include_paths: Array.isArray(include_paths)
						? include_paths.filter((item) => typeof item === "string")
						: undefined,
					exclude_paths: Array.isArray(exclude_paths)
						? exclude_paths.filter((item) => typeof item === "string")
						: undefined,
				},
			);
			// Start watcher for new directory KB
			if (WATCH_ENABLED && kb.source_path && kb.source_type === "directory") {
				watcher.startWatcher(
					kb.id,
					kb.source_path,
					(kbId) => {
						engine.update(kbId).catch(() => {});
					},
					{
						includeSuggestedText: include_suggested_text === true,
						includePaths: Array.isArray(include_paths)
							? include_paths.filter((item): item is string => typeof item === "string")
							: undefined,
						excludePaths: Array.isArray(exclude_paths)
							? exclude_paths.filter((item): item is string => typeof item === "string")
							: undefined,
					},
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Indexed "${kb.name}": ${chunkCount} chunks from ${kb.file_count} files. KB ID: ${kb.id}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "knowledge_search",
		label: "Knowledge Search",
		description: "Search indexed knowledge bases using lexical BM25, semantic vectors, reranking, and filters",
		approval: "read",
		promptSnippet: "Search knowledge bases (hybrid is lexical-anchored BM25 + semantic fusion)",
		promptGuidelines: [
			"Use knowledge_search to find relevant context before answering domain questions",
			"Default to mode 'hybrid' for most project questions with useful lexical anchors; it fuses BM25 and semantic vectors but still requires keyword evidence",
			"Use mode 'fast' for exact symbols, filenames, commands, error codes, API names, config keys, or quoted strings",
			"Use mode 'semantic' for pure vector search when exact terms may differ from indexed wording; use mode 'semantic_hybrid' when you want vector recall plus BM25/fusion scoring without the hybrid lexical evidence gate",
			"Use mode 'adaptive' when the user needs surrounding implementation context, related nearby sections, or enough context to make a code change",
			"Use mode 'deep' for high-stakes answers, ambiguous top results, or final verification where slower cross-encoder reranking is acceptable",
			"Use profile 'low_token' for slow local models that need fewer, stricter, longer snippets; use profile 'precision' for identifiers/errors and 'recall' or 'long_context' for broad prose/document research",
			"If a search returns no results or obviously weak results, retry once with a different mode before concluding the KB lacks the answer",
			"If top results are repetitive, retry with diversity 'strong' or mode 'adaptive' instead of increasing the limit first",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				Type.Union([
					Type.Literal("auto"),
					Type.Literal("fast"),
					Type.Literal("semantic"),
					Type.Literal("hybrid"),
					Type.Literal("semantic_hybrid"),
					Type.Literal("deep"),
					Type.Literal("adaptive"),
					Type.Literal("code"),
					Type.Literal("config"),
					Type.Literal("docs"),
					Type.Literal("errors"),
					Type.Literal("decision"),
				]),
			),
			profile: Type.Optional(
				Type.Union([
					Type.Literal("auto"),
					Type.Literal("balanced"),
					Type.Literal("low_token"),
					Type.Literal("precision"),
					Type.Literal("recall"),
					Type.Literal("long_context"),
					Type.Literal("code"),
					Type.Literal("docs"),
				]),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max results (default comes from search profile/env)",
					minimum: 1,
					maximum: MAX_SEARCH_RESULTS,
					multipleOf: 1,
				}),
			),
			kb_id: Type.Optional(Type.String({ description: "Limit search to a specific KB by ID or exact name" })),
			offset: Type.Optional(
				Type.Number({
					description: `Pagination offset; offset + limit must not exceed ${MAX_SEARCH_WINDOW}`,
					minimum: 0,
					maximum: MAX_SEARCH_WINDOW - 1,
					multipleOf: 1,
				}),
			),
			file_type: Type.Optional(Type.String({ description: "Filter by file type (e.g. typescript, markdown, python)" })),
			path_pattern: Type.Optional(
				Type.String({ description: "Filter by file path substring (for example src/engine.ts)" }),
			),
			diversity: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("balanced"), Type.Literal("strong")])),
			diagnostics: Type.Optional(
				Type.Boolean({ description: "Include ranking diagnostics and mode/fallback details in the result" }),
			),
		}),
		async execute(_id, params, _signal) {
			const { engine } = await ensureInitialized();
			const { query, mode, profile, limit, kb_id, offset, file_type, path_pattern, diversity, diagnostics } =
				params as {
					query: string;
					mode?:
						| "auto"
						| "fast"
						| "semantic"
						| "hybrid"
						| "semantic_hybrid"
						| "deep"
						| "adaptive"
						| "code"
						| "config"
						| "docs"
						| "errors"
						| "decision";
					profile?: "auto" | "balanced" | "low_token" | "precision" | "recall" | "long_context" | "code" | "docs";
					limit?: number;
					kb_id?: string;
					offset?: number;
					file_type?: string;
					path_pattern?: string;
					diversity?: "off" | "balanced" | "strong";
					diagnostics?: boolean;
				};
			const filters = file_type || path_pattern ? { file_type, path_pattern } : undefined;
			const response = await engine.search(query, { mode, profile, limit, kb_id, offset, filters, diversity }, _signal);
			if (response.results.length === 0) {
				const details = [
					"No results found.",
					response.mode_used ? `Mode used: ${response.mode_used}` : "",
					response.retry_modes?.length ? `Retried: ${response.retry_modes.join(", ")}` : "",
					response.warnings?.length ? `Warnings: ${response.warnings.join(" | ")}` : "",
					diagnostics && response.tuning
						? `Tuning: profile=${response.tuning.requested_profile}->${response.tuning.selected_profile}, limit=${response.tuning.limit}, snippet=${response.tuning.snippet_max_length}, min_hybrid=${response.tuning.min_hybrid_score}, candidates=${response.tuning.diversity_candidates}/${response.tuning.candidate_limit}, retrieval_per_kb=${response.tuning.retrieval_limit_per_kb}, retrieved=${response.tuning.retrieved_candidates}, filtered=${response.tuning.filtered_candidates}, truncated=${response.tuning.candidate_pool_truncated}`
						: "",
					response.suggestions?.length ? `Suggestions: ${response.suggestions.join(" | ")}` : "",
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text: details }], details: diagnostics ? response : undefined };
			}
			let output = `${response.total_count} results (showing ${response.results.length})`;
			if (response.mode_used) output += ` — mode: ${response.mode_used}`;
			if (response.retry_modes?.length) output += ` — retried: ${response.retry_modes.join(", ")}`;
			if (diagnostics && response.tuning) {
				output += ` — profile: ${response.tuning.requested_profile}->${response.tuning.selected_profile}`;
			}
			output += ":\n\n";
			if (response.warnings?.length) {
				output = `Warnings:\n- ${response.warnings.join("\n- ")}\n\n${output}`;
			}
			output += response.results
				.map((r, i) => {
					const diag =
						diagnostics && r.ranking
							? `\nDiagnostics: base=${r.ranking.base_score.toFixed(3)}, adjusted=${r.ranking.adjusted_score.toFixed(
									3,
								)}, coverage=${r.ranking.coverage.toFixed(2)}, path_boost=${r.ranking.path_boost.toFixed(
									2,
								)}, source_boost=${r.ranking.source_boost.toFixed(2)}, test=${r.ranking.is_test}`
							: "";
					const provenance =
						diagnostics && r.provenance
							? `\nProvenance: chunk=${r.provenance.chunk_id}, hash=${r.provenance.chunk_hash.slice(
									0,
									12,
								)}, reason=${r.provenance.match_reason}, indexed_at=${r.provenance.indexed_at}, source_mtime=${
									r.provenance.source_mtime ?? "unknown"
								}, stale=${r.provenance.stale}`
							: "";
					const tuning =
						diagnostics && response.tuning && i === 0
							? `\nTuning: limit=${response.tuning.limit}, snippet=${response.tuning.snippet_max_length}, min_hybrid=${response.tuning.min_hybrid_score}, candidates=${response.tuning.diversity_candidates}/${response.tuning.candidate_limit}, retrieval_per_kb=${response.tuning.retrieval_limit_per_kb}, retrieved=${response.tuning.retrieved_candidates}, filtered=${response.tuning.filtered_candidates}, truncated=${response.tuning.candidate_pool_truncated}`
							: "";
					return `[${i + 1}] ${r.file_path} (${r.kb_name}, score: ${r.score.toFixed(3)})\n${r.snippet}${diag}${provenance}${tuning}`;
				})
				.join("\n\n");
			return { content: [{ type: "text", text: output }], details: diagnostics ? response : undefined };
		},
	});

	pi.registerTool({
		name: "knowledge_symbol_search",
		label: "Knowledge Symbol Search",
		description:
			"Search indexed code symbols, Markdown headings, config keys, and environment variables exactly or by substring",
		approval: "read",
		promptSnippet: "Find exact symbols/config keys/headings before broad semantic search",
		promptGuidelines: [
			"Use knowledge_symbol_search before knowledge_search when looking for a function, class, env var, config key, route, or Markdown heading",
			"Use exact=true when the user provides a precise symbol or key",
			"This is a lightweight declaration-pattern index, not full LSP; for methods, uncommon syntax, or missing symbols, fallback to knowledge_search mode 'fast' or 'adaptive'",
			"After finding a symbol, use knowledge_search mode 'adaptive' with the file path or symbol name when surrounding implementation context is needed",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Symbol, heading, config key, env var, route, or file text to find" }),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("function"),
					Type.Literal("class"),
					Type.Literal("interface"),
					Type.Literal("type"),
					Type.Literal("variable"),
					Type.Literal("heading"),
					Type.Literal("config_key"),
					Type.Literal("env_var"),
					Type.Literal("route"),
				]),
			),
			kb_id: Type.Optional(Type.String({ description: "Limit lookup to a specific KB by ID or exact name" })),
			file_pattern: Type.Optional(Type.String({ description: "Limit lookup to paths containing this text" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
			offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
			exact: Type.Optional(Type.Boolean({ description: "Require exact normalized symbol/key match" })),
		}),
		async execute(_id, params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { engine } = await ensureInitialized();
			if (_signal?.aborted) throw new Error("Cancelled");
			const response = engine.symbolSearch(
				(params as { query: string }).query,
				{
					kind: (params as { kind?: never }).kind,
					kb_id: (params as { kb_id?: string }).kb_id,
					file_pattern: (params as { file_pattern?: string }).file_pattern,
					limit: (params as { limit?: number }).limit,
					offset: (params as { offset?: number }).offset,
					exact: (params as { exact?: boolean }).exact === true,
				},
				_signal,
			);
			if (response.results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No symbols found. This may mean the symbol is absent, symbol metadata is missing/stale, or the lightweight extractor does not cover this syntax. For important lookups, run knowledge_doctor or fallback to knowledge_search mode 'fast'/'adaptive'.",
						},
					],
				};
			}
			const lines = response.results.map((result, index) => {
				const signature = result.signature ? ` — ${result.signature}` : "";
				return `[${index + 1}] ${result.name} (${result.kind}) ${result.file_path}:${result.start_line}-${result.end_line} [${result.kb_name}]${signature}`;
			});
			const suffix = response.has_more ? "\nMore results available; increase offset to continue." : "";
			return {
				content: [
					{
						type: "text",
						text: `${response.total_count} symbol result(s):\n\n${lines.join("\n")}${suffix}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "knowledge_update",
		label: "Knowledge Update",
		description: "Incrementally re-index a source-backed knowledge base with a retained file, directory, or URL source",
		approval: "write",
		promptSnippet: "Refresh an existing source-backed KB",
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to update" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { engine } = await ensureInitialized();
			const { added, removed, unchanged } = await engine.update(
				(params as { target: string }).target,
				(msg) => {
					onUpdate?.({ content: [{ type: "text", text: msg }] });
				},
				_signal,
			);
			return {
				content: [{ type: "text", text: `Updated: +${added} added, -${removed} removed, ${unchanged} unchanged.` }],
			};
		},
	});

	pi.registerTool({
		name: "knowledge_status",
		label: "Knowledge Status",
		description:
			"Show knowledge engine status with embedding compatibility, staleness, orphan, and coverage diagnostics",
		approval: "read",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { engine, storage, watcher } = await ensureInitialized();
			const snapshot = engine.statusSnapshot(_signal);
			return {
				content: [
					{
						type: "text",
						text: formatKnowledgeStatus({
							snapshot,
							storagePath: storage.getDefaultKnowledgeDir(),
							watchCount: watcher.getActiveWatcherCount(),
						}),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "knowledge_doctor",
		label: "Knowledge Doctor",
		description: "Diagnose knowledge base health, skipped files, stale indexes, stuck jobs, and recommended fixes",
		approval: "read",
		promptSnippet: "Diagnose knowledge base health and recommended actions",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { engine } = await ensureInitialized();
			const report = engine.doctor(_signal);
			const lines = [`Health score: ${report.health_score}/100`, report.summary, ""];
			if (report.issues.length === 0) {
				lines.push("No issues found.");
			} else {
				for (const issue of report.issues) {
					const scope = issue.kb_name ? ` [${issue.kb_name}]` : "";
					lines.push(`- ${issue.severity.toUpperCase()}${scope}: ${issue.message}`);
					lines.push(`  Action (${issue.action_code ?? "none"}): ${issue.action}`);
				}
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: report };
		},
	});

	pi.registerTool({
		name: "knowledge_show",
		label: "Knowledge Show",
		description: "List all indexed knowledge bases",
		approval: "read",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { engine } = await ensureInitialized();
			if (_signal?.aborted) throw new Error("Cancelled");
			const kbs = engine.list(_signal);
			if (kbs.length === 0) return { content: [{ type: "text", text: "No knowledge bases." }] };
			const lines = kbs.map((kb) => `• ${kb.name} — ${kb.chunk_count} chunks, ${kb.file_count} files (${kb.status})`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "knowledge_remove",
		label: "Knowledge Remove",
		description: "Remove a knowledge base by name or ID after explicit confirmation",
		approval: "write",
		promptGuidelines: [
			"Destructive: only call after the user explicitly asks to remove knowledge data or confirms a proposed removal",
			"Prefer knowledge_status or knowledge_doctor before removing data for troubleshooting",
			"Use knowledge_export before removal if the user may need a backup",
		],
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to remove" }),
			confirm: Type.Boolean({
				description: "Must be true after explicit user confirmation for this destructive operation",
			}),
		}),
		async execute(_id, params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			const { target, confirm } = params as { target: string; confirm?: boolean };
			if (confirm !== true) throw new Error("Confirmation required: pass confirm=true for destructive removal");
			const { engine } = await ensureInitialized();
			const ok = engine.remove(target);
			return { content: [{ type: "text", text: ok ? "Removed." : "Not found." }] };
		},
	});

	pi.registerTool({
		name: "knowledge_export",
		label: "Knowledge Export",
		description: "Export a knowledge base to a JSONL file (shareable, git-friendly)",
		approval: "write",
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to export" }),
			output: Type.String({ description: "Output file path (.jsonl)" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { engine } = await ensureInitialized();
			const { target, output } = params as { target: string; output: string };
			const count = await engine.exportKB(target, output, _signal, (msg) => {
				onUpdate?.({ content: [{ type: "text", text: msg }] });
			});
			return { content: [{ type: "text", text: `Exported ${count} chunks to ${output}` }] };
		},
	});

	pi.registerTool({
		name: "knowledge_import",
		label: "Knowledge Import",
		description: "Import a knowledge base from a JSONL file (re-embeds content)",
		approval: "write",
		parameters: Type.Object({
			input: Type.String({ description: "Input JSONL file path" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { engine } = await ensureInitialized();
			const { kb, chunkCount } = await engine.importKB(
				(params as { input: string }).input,
				(msg) => {
					onUpdate?.({ content: [{ type: "text", text: msg }] });
				},
				_signal,
			);
			return { content: [{ type: "text", text: `Imported "${kb.name}": ${chunkCount} chunks (re-embedded)` }] };
		},
	});

	pi.registerTool({
		name: "knowledge_clear",
		label: "Knowledge Clear",
		description: "Remove all knowledge bases after explicit confirmation",
		approval: "write",
		promptGuidelines: [
			"Destructive: only call after the user explicitly asks to clear all knowledge data or confirms a proposed clear",
			"Never use knowledge_clear as troubleshooting unless the user explicitly approves",
			"Prefer knowledge_status, knowledge_doctor, or knowledge_export before clearing data",
		],
		parameters: Type.Object({
			confirm: Type.Boolean({
				description: "Must be true after explicit user confirmation for this destructive operation",
			}),
		}),
		async execute(_id, params, _signal) {
			if (_signal?.aborted) throw new Error("Cancelled");
			if ((params as { confirm?: boolean }).confirm !== true) {
				throw new Error("Confirmation required: pass confirm=true for destructive clear");
			}
			const { engine } = await ensureInitialized();
			engine.clear();
			return { content: [{ type: "text", text: "All knowledge bases cleared." }] };
		},
	});
}
