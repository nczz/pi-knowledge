import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ignore from "ignore";
import type { ChunkInsert } from "../storage/sqlite.ts";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".ico",
	".bmp",
	".webp",
	".svg",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".otf",
	".zip",
	".gz",
	".tar",
	".bz2",
	".7z",
	".rar",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".exe",
	".dll",
	".so",
	".dylib",
	".node",
	".db",
	".sqlite",
	".bin",
	".dat",
	".lock",
	".mp3",
	".mp4",
	".wav",
	".avi",
	".mov",
	".webm",
	".wasm",
	".o",
	".a",
	".lib",
]);

const DEFAULT_IGNORE = [
	"node_modules",
	".git",
	"dist",
	"build",
	"bin",
	"obj",
	"out",
	"target",
	"coverage",
	".next",
	".cache",
	".playwright",
	"__pycache__",
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.crt",
	"*.cert",
	"*secret*",
	"*secrets*",
	"*credential*",
	"*credentials*",
	"setting*.json",
	"appsettings*.json",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.lock",
	"package-lock.json",
	".DS_Store",
	"Thumbs.db",
	"*.pyc",
	"*.class",
];

export interface ScannedFile {
	path: string; // absolute path
	relPath: string; // relative to root
	content: string;
	fileType: string;
}

function detectFileType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".mjs": "javascript",
		".py": "python",
		".go": "go",
		".rs": "rust",
		".java": "java",
		".c": "c",
		".cpp": "cpp",
		".h": "c",
		".hpp": "cpp",
		".md": "markdown",
		".mdx": "markdown",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".toml": "toml",
		".html": "html",
		".css": "css",
		".scss": "css",
		".sh": "shell",
		".bash": "shell",
		".zsh": "shell",
		".sql": "sql",
		".graphql": "graphql",
		".txt": "text",
		".csv": "text",
		".log": "text",
	};
	return map[ext] ?? "text";
}

function isBinaryFile(filePath: string): boolean {
	if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;
	try {
		const fd = readFileSync(filePath, { flag: "r" });
		const sample = fd.subarray(0, 512);
		return sample.includes(0x00);
	} catch {
		return true;
	}
}

export function walkDir(dirPath: string): ScannedFile[] {
	const ig = ignore();
	ig.add(DEFAULT_IGNORE);

	const gitignorePath = join(dirPath, ".gitignore");
	if (existsSync(gitignorePath)) {
		ig.add(readFileSync(gitignorePath, "utf-8"));
	}

	const results: ScannedFile[] = [];

	function walk(dir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = relative(dirPath, fullPath).split(sep).join("/");

			if (ig.ignores(relPath)) continue;

			if (entry.isDirectory()) {
				if (ig.ignores(`${relPath}/`)) continue;
				walk(fullPath);
			} else if (entry.isFile()) {
				const stat = statSync(fullPath);
				if (stat.size > MAX_FILE_SIZE) continue;
				if (isBinaryFile(fullPath)) continue;

				try {
					const content = readFileSync(fullPath, "utf-8");
					results.push({ path: fullPath, relPath, content, fileType: detectFileType(fullPath) });
				} catch {
					// skip unreadable files
				}
			}
		}
	}

	walk(dirPath);
	return results;
}

// --- Chunking ---

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

const MARKDOWN_TARGET_TOKENS = 450;
const TEXT_TARGET_TOKENS = 550;

export function preTokenizeForFTS(content: string): string {
	return content
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-zA-Z])(\d)/g, "$1 $2")
		.replace(/(\d)([a-zA-Z])/g, "$1 $2")
		.replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, " $1 ")
		.replace(/\s+/g, " ")
		.trim();
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function normalizeHeading(heading: string): string {
	return heading.replace(/^#{1,6}\s+/, "").trim();
}

function buildContextPrefix(
	filePath: string,
	fileType: string,
	metadata: Record<string, string | number | null | undefined>,
): string {
	const parts = [`File: ${filePath}`, `Type: ${fileType}`];
	const heading = typeof metadata.heading === "string" ? metadata.heading : "";
	const breadcrumb = typeof metadata.breadcrumb === "string" ? metadata.breadcrumb : "";
	const symbol = typeof metadata.function_name === "string" ? metadata.function_name : "";
	if (breadcrumb) parts.push(`Section: ${breadcrumb}`);
	else if (heading) parts.push(`Section: ${normalizeHeading(heading)}`);
	if (symbol) parts.push(`Symbol: ${symbol}`);
	return parts.join("\n");
}

export function buildChunkEmbeddingText(
	chunk: Pick<ChunkInsert, "content" | "file_path" | "file_type" | "metadata_json">,
): string {
	let metadata: Record<string, string | number | null | undefined> = {};
	try {
		metadata = JSON.parse(chunk.metadata_json) as Record<string, string | number | null | undefined>;
	} catch {
		metadata = {};
	}
	return `${buildContextPrefix(chunk.file_path, chunk.file_type, metadata)}\n\n${chunk.content}`;
}

function makeChunk(
	content: string,
	filePath: string,
	fileType: string,
	startLine: number,
	endLine: number,
	metadata: Record<string, string | number | null | undefined> = {},
): Omit<ChunkInsert, "kb_id"> {
	const metadata_json = JSON.stringify(metadata);
	const chunk = {
		content_hash: contentHash(content),
		content,
		content_tokenized: "",
		file_path: filePath,
		file_type: fileType,
		start_line: startLine,
		end_line: endLine,
		metadata_json,
	};
	return { ...chunk, content_tokenized: preTokenizeForFTS(buildChunkEmbeddingText(chunk)) };
}

export function chunkMarkdown(content: string, filePath: string): Omit<ChunkInsert, "kb_id">[] {
	const lines = content.split("\n");
	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	const headingStack: string[] = [];
	let sectionLines: string[] = [];
	let startLine = 1;
	let currentHeading = "";

	function currentBreadcrumb(): string {
		return headingStack.map(normalizeHeading).filter(Boolean).join(" > ");
	}

	function pushMarkdownChunk(text: string, start: number, end: number): void {
		if (text.trim().length < 50) return;
		chunks.push(
			makeChunk(text.trim(), filePath, "markdown", start, end, {
				heading: currentHeading,
				breadcrumb: currentBreadcrumb(),
			}),
		);
	}

	function flush(endLine: number): void {
		const text = sectionLines.join("\n").trim();
		if (text.length < 50) return;

		const fullText = currentHeading ? `${currentHeading}\n\n${text}` : text;
		const paragraphs = fullText.split(/\n\n+/);
		let buffer: string[] = [];
		let bufferStart = startLine;

		for (const para of paragraphs) {
			const next = [...buffer, para].join("\n\n");
			if (estimateTokens(next) > MARKDOWN_TARGET_TOKENS && buffer.length > 0) {
				pushMarkdownChunk(buffer.join("\n\n"), bufferStart, endLine);
				buffer = [];
				bufferStart = endLine;
			}
			buffer.push(para);
		}

		if (buffer.length > 0) {
			pushMarkdownChunk(buffer.join("\n\n"), bufferStart, endLine);
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch && sectionLines.length > 0) {
			flush(i);
			sectionLines = [];
			startLine = i + 1;
		}

		if (headingMatch) {
			const level = headingMatch[1].length;
			headingStack.splice(level - 1);
			headingStack[level - 1] = line;
			currentHeading = line;
		} else {
			sectionLines.push(line);
		}
	}

	if (sectionLines.length > 0) {
		flush(lines.length);
	}

	return chunks;
}

export function chunkText(content: string, filePath: string): Omit<ChunkInsert, "kb_id">[] {
	const fileType = detectFileType(filePath);
	const paragraphs = content.split(/\n\n+/);
	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	let buffer: string[] = [];
	let bufferTokens = 0;
	let lineOffset = 1;

	function flush(): void {
		const text = buffer.join("\n\n").trim();
		if (text.length < 50) return;
		chunks.push(makeChunk(text, filePath, fileType, lineOffset, lineOffset + text.split("\n").length));
		lineOffset += text.split("\n").length + 1;
	}

	for (const para of paragraphs) {
		const paraTokens = estimateTokens(para);
		if (bufferTokens + paraTokens > TEXT_TARGET_TOKENS && buffer.length > 0) {
			flush();
			buffer = [];
			bufferTokens = 0;
		}
		buffer.push(para);
		bufferTokens += paraTokens;
	}

	if (buffer.length > 0) flush();
	return chunks;
}

export async function chunkFile(content: string, filePath: string): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const fileType = detectFileType(filePath);
	let chunks: Omit<ChunkInsert, "kb_id">[] = [];

	if (fileType === "markdown") {
		chunks = chunkMarkdown(content, filePath);
	} else if (["typescript", "javascript", "python", "go", "rust", "java"].includes(fileType)) {
		try {
			const { chunkWithAST } = await import("./chunkers/code-ast.ts");
			chunks = await chunkWithAST(content, filePath, fileType);
		} catch {
			/* fallback below */
		}
	}

	if (chunks.length === 0) chunks = chunkText(content, filePath);

	// Fallback: if file has content but no chunks (too short for splitting), keep as single chunk
	if (chunks.length === 0 && content.trim().length > 10) {
		chunks = [makeChunk(content.trim(), filePath, fileType, 1, content.split("\n").length)];
	}

	return chunks;
}
