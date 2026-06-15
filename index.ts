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
	Literal(value: string): Schema {
		return { const: value };
	},
	Union(items: Schema[]): Schema {
		return { anyOf: items };
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
		name: "knowledge_add",
		label: "Knowledge Add",
		description: "Index files, directories, or text into a named knowledge base for semantic search",
		promptSnippet: "Index files/dirs/text into a searchable knowledge base",
		promptGuidelines: [
			"Use knowledge_add when the user asks to index, remember, or learn from files or documentation",
			"Prefer one knowledge_add call for the project root or relevant directory; do not call it once per file",
			"If a knowledge base with the same name already exists, use knowledge_update or ask before replacing it",
			"Do not index secrets or environment-specific config files unless the user explicitly asks for that exact file",
			"Provide a descriptive name for this single knowledge base",
		],
		parameters: Type.Object({
			source: Type.String({ description: "File path, directory path, or inline text to index" }),
			name: Type.String({ description: "Display name for this knowledge base" }),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const { source, name } = params;
			const { kb, chunkCount } = await engine.add(
				source,
				name,
				(msg) => {
					onUpdate?.({ content: [{ type: "text", text: msg }] });
				},
				_signal,
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
		promptSnippet: "Search knowledge bases (hybrid BM25 + semantic + RRF fusion)",
		promptGuidelines: [
			"Use knowledge_search to find relevant context before answering domain questions",
			"Default mode 'hybrid' combines keyword and semantic search for best results",
			"Use mode 'fast' for exact symbol/term lookups, 'semantic' for conceptual queries",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("fast"), Type.Literal("semantic"), Type.Literal("hybrid"), Type.Literal("deep")]),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
			kb_id: Type.Optional(Type.String({ description: "Limit search to a specific KB by ID or exact name" })),
			offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
			file_type: Type.Optional(Type.String({ description: "Filter by file type (e.g. typescript, markdown, python)" })),
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
			const { query, mode, limit, kb_id, offset, file_type } = params;
			const filters = file_type ? { file_type } : undefined;
			const response = await engine.search(query, { mode, limit, kb_id, offset, filters });
			if (response.results.length === 0) {
				return { content: [{ type: "text", text: "No results found." }] };
			}
			let output = `${response.total_count} results (showing ${response.results.length}):\n\n`;
			if (response.warnings?.length) {
				output = `⚠️ ${response.warnings.join("\n⚠️ ")}\n\n${output}`;
			}
			output += response.results
				.map((r, i) => `[${i + 1}] ${r.file_path} (${r.kb_name}, score: ${r.score.toFixed(3)})\n${r.snippet}`)
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
					lines.push(
						`    coverage: ${diag.coverage_percent}% (${diag.indexed_files}/${diag.total_source_files} files)`,
					);
					if (diag.stale_files.length > 0)
						lines.push(`    ⚠️ stale: ${diag.stale_files.length} files modified since last index`);
					if (diag.orphan_files.length > 0)
						lines.push(`    ⚠️ orphans: ${diag.orphan_files.length} chunks reference deleted files`);
				}
			}
			const totalStale = diagnostics.reduce((n, d) => n + d.stale_files.length, 0);
			const totalOrphans = diagnostics.reduce((n, d) => n + d.orphan_files.length, 0);
			if (totalStale === 0 && totalOrphans === 0 && kbs.length > 0) lines.push("", "Health: ✓ all indexes up to date");
			else if (totalStale > 0 || totalOrphans > 0)
				lines.push("", `Health: ⚠️ ${totalStale} stale, ${totalOrphans} orphans — run knowledge_update`);
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
