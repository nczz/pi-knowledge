import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ignore from "ignore";
import type { ChunkInsert } from "../storage/sqlite.ts";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".svg",
	".woff", ".woff2", ".ttf", ".eot", ".otf",
	".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt",
	".exe", ".dll", ".so", ".dylib", ".node",
	".db", ".sqlite", ".bin", ".dat", ".lock",
	".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm",
	".wasm", ".o", ".a", ".lib",
]);

const DEFAULT_IGNORE = [
	"node_modules", ".git", "dist", "build", ".next", "__pycache__",
	"*.min.js", "*.min.css", "*.map", "*.lock", "package-lock.json",
	".DS_Store", "Thumbs.db", "*.pyc", "*.class",
];

export interface ScannedFile {
	path: string;       // absolute path
	relPath: string;    // relative to root
	content: string;
	fileType: string;
}

function detectFileType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript", ".tsx": "typescript",
		".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
		".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
		".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
		".md": "markdown", ".mdx": "markdown",
		".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
		".html": "html", ".css": "css", ".scss": "css",
		".sh": "shell", ".bash": "shell", ".zsh": "shell",
		".sql": "sql", ".graphql": "graphql",
		".txt": "text", ".csv": "text", ".log": "text",
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
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); }
		catch { return; }
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = relative(dirPath, fullPath).split(sep).join("/");

			if (ig.ignores(relPath)) continue;

			if (entry.isDirectory()) {
				if (ig.ignores(relPath + "/")) continue;
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

export function chunkMarkdown(content: string, filePath: string): Omit<ChunkInsert, "kb_id">[] {
	const lines = content.split("\n");
	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	let currentHeading = "";
	let sectionLines: string[] = [];
	let startLine = 1;

	function flush(endLine: number): void {
		const text = sectionLines.join("\n").trim();
		if (text.length < 50) return;

		const fullText = currentHeading ? `${currentHeading}\n\n${text}` : text;

		if (estimateTokens(fullText) > 2000) {
			// Split large sections by paragraph
			const paragraphs = fullText.split(/\n\n+/);
			let buf: string[] = [];
			let bufStart = startLine;
			for (const para of paragraphs) {
				buf.push(para);
				if (estimateTokens(buf.join("\n\n")) > 1000) {
					const chunkText = buf.join("\n\n");
					chunks.push({
						content_hash: contentHash(chunkText),
						content: chunkText,
						content_tokenized: preTokenizeForFTS(chunkText),
						file_path: filePath,
						file_type: "markdown",
						start_line: bufStart,
						end_line: endLine,
						metadata_json: JSON.stringify({ heading: currentHeading }),
					});
					buf = [];
					bufStart = endLine;
				}
			}
			if (buf.length > 0) {
				const chunkText = buf.join("\n\n");
				if (chunkText.length >= 50) {
					chunks.push({
						content_hash: contentHash(chunkText),
						content: chunkText,
						content_tokenized: preTokenizeForFTS(chunkText),
						file_path: filePath,
						file_type: "markdown",
						start_line: bufStart,
						end_line: endLine,
						metadata_json: JSON.stringify({ heading: currentHeading }),
					});
				}
			}
		} else {
			chunks.push({
				content_hash: contentHash(fullText),
				content: fullText,
				content_tokenized: preTokenizeForFTS(fullText),
				file_path: filePath,
				file_type: "markdown",
				start_line: startLine,
				end_line: endLine,
				metadata_json: JSON.stringify({ heading: currentHeading }),
			});
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);

		if (headingMatch && sectionLines.length > 0) {
			flush(i);
			sectionLines = [];
			startLine = i + 1;
		}

		if (headingMatch) {
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
		chunks.push({
			content_hash: contentHash(text),
			content: text,
			content_tokenized: preTokenizeForFTS(text),
			file_path: filePath,
			file_type: fileType,
			start_line: lineOffset,
			end_line: lineOffset + text.split("\n").length,
			metadata_json: "{}",
		});
		lineOffset += text.split("\n").length + 1;
	}

	for (const para of paragraphs) {
		const paraTokens = estimateTokens(para);
		if (bufferTokens + paraTokens > 1000 && buffer.length > 0) {
			flush();
			// overlap: keep last paragraph
			buffer = buffer.length > 0 ? [buffer[buffer.length - 1]] : [];
			bufferTokens = buffer.length > 0 ? estimateTokens(buffer[0]) : 0;
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
		} catch { /* fallback below */ }
	}

	if (chunks.length === 0) chunks = chunkText(content, filePath);

	// Fallback: if file has content but no chunks (too short for splitting), keep as single chunk
	if (chunks.length === 0 && content.trim().length > 10) {
		chunks = [{
			content_hash: contentHash(content),
			content: content.trim(),
			content_tokenized: preTokenizeForFTS(content),
			file_path: filePath,
			file_type: fileType,
			start_line: 1,
			end_line: content.split("\n").length,
			metadata_json: "{}",
		}];
	}

	return chunks;
}
