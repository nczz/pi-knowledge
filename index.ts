import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KnowledgeEngine } from "./src/engine.ts";
import { getDefaultKnowledgeDir } from "./src/storage/sqlite.ts";
import { getActiveWatcherCount, startWatcher, stopAllWatchers } from "./src/watcher/file-watcher.ts";

type Schema = Record<string, unknown> & { optional?: true };
type ContextMessage = { role: string; content: string };
type ThemeLike = {
	fg?: (name: string, text: string) => string;
};
type RenderContextLike = {
	lastComponent?: RenderableText;
};
type RenderOptionsLike = {
	expanded?: boolean;
};
type ToolResultLike = {
	content?: Array<{ type: string; text?: string }>;
};

const MAX_RENDER_LINE_WIDTH = 80;
const ESCAPE = "\u001B";

function ansiSequenceLength(line: string, offset: number): number {
	if (line[offset] !== ESCAPE || line[offset + 1] !== "[") return 0;
	for (let i = offset + 2; i < line.length; i++) {
		const codePoint = line.charCodeAt(i);
		if (codePoint >= 0x40 && codePoint <= 0x7e) return i - offset + 1;
	}
	return 0;
}

function charRenderWidth(char: string): number {
	const codePoint = char.codePointAt(0);
	if (codePoint === undefined) return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6)
	) {
		return 2;
	}
	return 1;
}

function truncateRenderLine(line: string): string {
	let visibleWidth = 0;
	let output = "";
	for (let i = 0; i < line.length; ) {
		const ansiLength = ansiSequenceLength(line, i);
		if (ansiLength > 0) {
			output += line.slice(i, i + ansiLength);
			i += ansiLength;
			continue;
		}
		const codePoint = line.codePointAt(i);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		const width = charRenderWidth(char);
		if (visibleWidth + width > MAX_RENDER_LINE_WIDTH - 1) return `${output}…`;
		output += char;
		visibleWidth += width;
		i += char.length;
	}
	return output;
}

/**
 * Minimal duck-type shim for @earendil-works/pi-tui Text component.
 * Allows startup without Pi virtual module while implementing the render host methods this extension needs.
 */
class RenderableText {
	private text: string;

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(): string[] {
		return this.text.split("\n").map(truncateRenderLine);
	}
}

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

function themed(theme: ThemeLike, name: string, text: string): string {
	return theme.fg ? theme.fg(name, text) : text;
}

function renderText(context: RenderContextLike, text: string): RenderableText {
	const component = context.lastComponent ?? new RenderableText();
	component.setText(text);
	return component;
}

const engine = new KnowledgeEngine();
const WATCH_ENABLED = process.env.PI_KNOWLEDGE_WATCH === "true";
const AUTO_INJECT = process.env.PI_KNOWLEDGE_AUTO_INJECT === "true";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		await engine.initialize(getDefaultKnowledgeDir());
		if (WATCH_ENABLED) {
			for (const kb of engine.list()) {
				if (kb.source_path && kb.source_type === "directory") {
					startWatcher(kb.id, kb.source_path, (kbId) => {
						engine.update(kbId).catch(() => {});
					});
				}
			}
		}
	});

	pi.on("session_shutdown", async () => {
		stopAllWatchers();
		await engine.dispose({ disposeModels: false });
	});

	// Auto-inject: search KB for relevant context before each LLM call (opt-in)
	if (AUTO_INJECT) {
		pi.on("context", async (event) => {
			const kbs = engine.list();
			if (kbs.length === 0) return;
			// Find last user message
			const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
			if (!lastUser) return;
			const text = "content" in lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
			if (!text || text.length < 5) return;
			try {
				const results = await engine.search(text, { mode: "fast", limit: 3 });
				if (results.results.length === 0) return;
				const context = results.results.map((r) => `[${r.file_path}]: ${r.snippet}`).join("\n\n");
				const messages = event.messages as ContextMessage[];
				messages.unshift({ role: "user", content: `[Knowledge context]\n${context}` });
			} catch {
				/* silent fail */
			}
		});
	}

	pi.on("before_agent_start", (event) => {
		const kbs = engine.list();
		if (kbs.length > 0) {
			const desc = kbs.map((kb) => `"${kb.name}" (${kb.chunk_count} chunks, ${kb.file_count} files)`).join(", ");
			event.systemPromptOptions.promptGuidelines?.push(
				`Available knowledge bases: ${desc}. Use knowledge_search before answering domain questions.`,
			);
		}
	});

	pi.registerTool({
		name: "knowledge_plan",
		label: "Knowledge Plan",
		description:
			"Inspect an indexing source without writing a KB, showing scannable files, suggested exclusions, and technical skips",
		promptSnippet: "Plan a knowledge-base indexing scope before calling knowledge_add",
		promptGuidelines: [
			"Use knowledge_plan before knowledge_add for broad directories, large repositories, or sources that may contain private or low-signal text",
			"Show the user suggested exclusions and technical skips before asking whether to include risky or low-signal text",
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
		execute(_id, params) {
			const { source, include_suggested_text, include_paths, exclude_paths } = params;
			const plan = engine.plan(source, {
				include_suggested_text: include_suggested_text === true,
				include_paths: Array.isArray(include_paths)
					? include_paths.filter((item) => typeof item === "string")
					: undefined,
				exclude_paths: Array.isArray(exclude_paths)
					? exclude_paths.filter((item) => typeof item === "string")
					: undefined,
			});
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
		name: "knowledge_add",
		label: "Knowledge Add",
		description: "Index files, directories, or text into a named knowledge base for semantic search",
		promptSnippet: "Index files/dirs/text into a searchable knowledge base",
		promptGuidelines: [
			"Use knowledge_plan first for broad directories, large repositories, or sources that may contain private or low-signal text",
			"Use knowledge_add when the user asks to index, remember, or learn from files or documentation",
			"Prefer one knowledge_add call for the project root or relevant directory with include_paths/exclude_paths; do not call it once per file",
			"If a knowledge base with the same name already exists, use knowledge_update or ask before replacing it",
			"Index source, documentation, and ordinary configuration files that explain how the project works",
			"Default directory indexing suggests excluding generated, vendor, browser runtime, obvious secret, and low-signal text artifacts; these are not permanent blocks",
			"For ambiguous or risky text such as .env, private keys, certificates, credential-named files, settings.json, appsettings.json, cloud config, editor config, generated reports, lockfiles, or vendor text, explain the tradeoff and ask the user before including it",
			"If the user confirms a suggested-excluded text file or directory should be indexed, call knowledge_add with include_suggested_text or a focused include_paths value so the tool follows the confirmed scope",
			"Non-text, unsupported binary, oversized, unreadable, and inaccessible files remain technical skips even when the user wants broad indexing",
			"Provide a descriptive name for this single knowledge base",
		],
		parameters: Type.Object({
			source: Type.String({ description: "File path, directory path, or inline text to index" }),
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
			const { source, name, include_suggested_text, include_paths, exclude_paths } = params;
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
				startWatcher(kb.id, kb.source_path, (kbId) => {
					engine.update(kbId).catch(() => {});
				});
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
		description: "Search indexed knowledge bases using hybrid semantic + keyword search",
		promptSnippet: "Search knowledge bases (hybrid BM25 + semantic + weighted score fusion)",
		promptGuidelines: [
			"Use knowledge_search to find relevant context before answering domain questions",
			"Default to mode 'hybrid' for most project questions because it combines lexical anchors with semantic recall",
			"Use mode 'fast' for exact symbols, filenames, commands, error codes, API names, config keys, or quoted strings",
			"Use mode 'semantic' for broad conceptual questions when exact terms may differ from the indexed wording",
			"Use mode 'adaptive' when the user needs surrounding implementation context, related nearby sections, or enough context to make a code change",
			"Use mode 'deep' for high-stakes answers, ambiguous top results, or final verification where slower cross-encoder reranking is acceptable",
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
					Type.Literal("deep"),
					Type.Literal("adaptive"),
				]),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
			kb_id: Type.Optional(Type.String({ description: "Limit search to a specific KB by ID or exact name" })),
			offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
			file_type: Type.Optional(Type.String({ description: "Filter by file type (e.g. typescript, markdown, python)" })),
			diversity: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("balanced"), Type.Literal("strong")])),
			diagnostics: Type.Optional(
				Type.Boolean({ description: "Include ranking diagnostics and mode/fallback details in the result" }),
			),
		}),
		renderCall(args, theme: ThemeLike, context: RenderContextLike) {
			const query = typeof args.query === "string" ? args.query : "";
			const mode = typeof args.mode === "string" ? args.mode : "hybrid";
			return renderText(
				context,
				`${themed(theme, "accent", "Search")}: "${query}" ${themed(theme, "muted", `(${mode})`)}`,
			);
		},
		renderResult(result: ToolResultLike, options: RenderOptionsLike, _theme: ThemeLike, context: RenderContextLike) {
			const text = result.content?.find((item) => item.type === "text")?.text ?? "";
			const lines = options.expanded ? text : text.split("\n").slice(0, 5).join("\n");
			return renderText(context, lines);
		},
		async execute(_id, params) {
			const { query, mode, limit, kb_id, offset, file_type, diversity, diagnostics } = params;
			const filters = file_type ? { file_type } : undefined;
			const response = await engine.search(query, { mode, limit, kb_id, offset, filters, diversity });
			if (response.results.length === 0) {
				const details = [
					"No results found.",
					response.mode_used ? `Mode used: ${response.mode_used}` : "",
					response.retry_modes?.length ? `Retried: ${response.retry_modes.join(", ")}` : "",
					response.warnings?.length ? `Warnings: ${response.warnings.join(" | ")}` : "",
					response.suggestions?.length ? `Suggestions: ${response.suggestions.join(" | ")}` : "",
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text: details }] };
			}
			let output = `${response.total_count} results (showing ${response.results.length})`;
			if (response.mode_used) output += ` — mode: ${response.mode_used}`;
			if (response.retry_modes?.length) output += ` — retried: ${response.retry_modes.join(", ")}`;
			output += ":\n\n";
			if (response.warnings?.length) {
				output = `⚠️ ${response.warnings.join("\n⚠️ ")}\n\n${output}`;
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
					return `[${i + 1}] ${r.file_path} (${r.kb_name}, score: ${r.score.toFixed(3)})\n${r.snippet}${diag}`;
				})
				.join("\n\n");
			return { content: [{ type: "text", text: output }] };
		},
	});

	pi.registerTool({
		name: "knowledge_update",
		label: "Knowledge Update",
		description: "Incrementally re-index a knowledge base (only re-embeds changed content)",
		promptSnippet: "Incrementally update a knowledge base (only changed files re-embedded)",
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to update" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { added, removed, unchanged } = await engine.update(
				params.target,
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
		description: "Show knowledge engine status with health diagnostics: staleness, orphans, and coverage",
		parameters: Type.Object({}),
		async execute() {
			const kbs = engine.list();
			const watchCount = getActiveWatcherCount();
			const diagnostics = engine.diagnose();
			const lines = [
				`Storage: ${getDefaultKnowledgeDir()}`,
				`Knowledge bases: ${kbs.length}`,
				`Active watchers: ${watchCount}`,
				"",
			];
			for (const kb of kbs) {
				const age = Math.round((Date.now() - kb.updated_at) / 60000);
				const diag = diagnostics.find((d) => d.kb_id === kb.id);
				lines.push(
					`  "${kb.name}" — ${kb.status} — ${kb.chunk_count} chunks, ${kb.file_count} files — updated ${age}m ago`,
				);
				if (kb.source_path) lines.push(`    source: ${kb.source_path}`);
				if (diag) {
					if (diag.job) {
						const jobAge = Math.round((Date.now() - diag.job.last_progress_at) / 1000);
						const progress = [
							`${diag.job.processed_files} files`,
							`${diag.job.processed_chunks} chunks`,
							diag.job.skipped_total > 0 ? `${diag.job.skipped_total} skipped` : "",
							diag.job.added_chunks > 0 ? `+${diag.job.added_chunks}` : "",
							diag.job.removed_chunks > 0 ? `-${diag.job.removed_chunks}` : "",
							diag.job.unchanged_chunks > 0 ? `=${diag.job.unchanged_chunks}` : "",
						]
							.filter(Boolean)
							.join(", ");
						lines.push(
							`    job: ${diag.job.status}/${diag.job.phase} — ${progress || "no processed items yet"} — last progress ${jobAge}s ago`,
						);
						if (diag.job.message) lines.push(`    last: ${diag.job.message}`);
						if (diag.job.error_message) lines.push(`    error: ${diag.job.error_message}`);
					}
					lines.push(
						`    coverage: ${diag.coverage_percent}% (${diag.indexed_files}/${diag.total_source_files} files)`,
					);
					if (diag.stale_files.length > 0)
						lines.push(`    ⚠️ stale: ${diag.stale_files.length} files modified since last index`);
					if (diag.orphan_files.length > 0)
						lines.push(`    ⚠️ orphans: ${diag.orphan_files.length} chunks reference deleted files`);
					if (diag.stuck_indexing)
						lines.push(
							`    ⚠️ indexing appears stuck for ${Math.round(diag.last_progress_age_ms / 60000)}m; remove and rebuild if no pi process is actively indexing it`,
						);
					if (diag.skipped_files.total > 0)
						lines.push(
							`    skipped: ${diag.skipped_files.total} files (${Object.entries(diag.skipped_files.by_reason)
								.filter(([, count]) => count > 0)
								.map(([reason, count]) => `${reason}: ${count}`)
								.join(", ")})`,
						);
				}
			}
			const totalStale = diagnostics.reduce((n, d) => n + d.stale_files.length, 0);
			const totalOrphans = diagnostics.reduce((n, d) => n + d.orphan_files.length, 0);
			const totalStuck = diagnostics.filter((d) => d.stuck_indexing).length;
			if (totalStale === 0 && totalOrphans === 0 && totalStuck === 0 && kbs.length > 0)
				lines.push("", "Health: ✓ all indexes up to date");
			else if (totalStale > 0 || totalOrphans > 0 || totalStuck > 0)
				lines.push(
					"",
					`Health: ⚠️ ${totalStale} stale, ${totalOrphans} orphans, ${totalStuck} stuck indexing — run knowledge_update or rebuild affected KBs`,
				);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "knowledge_doctor",
		label: "Knowledge Doctor",
		description: "Diagnose knowledge base health, skipped files, stale indexes, stuck jobs, and recommended fixes",
		promptSnippet: "Diagnose knowledge base health and recommended actions",
		parameters: Type.Object({}),
		async execute() {
			const report = engine.doctor();
			const lines = [`Health score: ${report.health_score}/100`, report.summary, ""];
			if (report.issues.length === 0) {
				lines.push("No issues found.");
			} else {
				for (const issue of report.issues) {
					const scope = issue.kb_name ? ` [${issue.kb_name}]` : "";
					lines.push(`- ${issue.severity.toUpperCase()}${scope}: ${issue.message}`);
					lines.push(`  Action: ${issue.action}`);
				}
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "knowledge_show",
		label: "Knowledge Show",
		description: "List all indexed knowledge bases",
		parameters: Type.Object({}),
		async execute() {
			const kbs = engine.list();
			if (kbs.length === 0) return { content: [{ type: "text", text: "No knowledge bases." }] };
			const lines = kbs.map((kb) => `• ${kb.name} — ${kb.chunk_count} chunks, ${kb.file_count} files (${kb.status})`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "knowledge_remove",
		label: "Knowledge Remove",
		description: "Remove a knowledge base by name or ID",
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to remove" }),
		}),
		async execute(_id, params) {
			const ok = engine.remove(params.target);
			return { content: [{ type: "text", text: ok ? "Removed." : "Not found." }] };
		},
	});

	pi.registerTool({
		name: "knowledge_export",
		label: "Knowledge Export",
		description: "Export a knowledge base to a JSONL file (shareable, git-friendly)",
		parameters: Type.Object({
			target: Type.String({ description: "KB name or ID to export" }),
			output: Type.String({ description: "Output file path (.jsonl)" }),
		}),
		async execute(_id, params) {
			const count = await engine.exportKB(params.target, params.output);
			return { content: [{ type: "text", text: `Exported ${count} chunks to ${params.output}` }] };
		},
	});

	pi.registerTool({
		name: "knowledge_import",
		label: "Knowledge Import",
		description: "Import a knowledge base from a JSONL file (re-embeds content)",
		parameters: Type.Object({
			input: Type.String({ description: "Input JSONL file path" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { kb, chunkCount } = await engine.importKB(
				params.input,
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
		description: "Remove all knowledge bases",
		parameters: Type.Object({}),
		async execute() {
			engine.clear();
			return { content: [{ type: "text", text: "All knowledge bases cleared." }] };
		},
	});
}
