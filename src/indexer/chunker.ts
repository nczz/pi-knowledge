import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	type Dirent,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { lstat as lstatFile, opendir, open as openFile, realpath as realpathFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { authorizeExistingPath, type FilesystemAccessPolicy } from "../filesystem-access.ts";
import type { ChunkInsert, KnowledgeSymbolInsert } from "../storage/sqlite.ts";
import { extractSymbols } from "./symbols.ts";

type ChunkMetadataValue = string | number | boolean | string[] | number[] | boolean[] | null | undefined;
type ChunkMetadata = Record<string, ChunkMetadataValue>;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const DOCUMENT_EXTENSIONS: Record<string, true> = { ".doc": true, ".docx": true, ".pdf": true };

const BINARY_EXTENSIONS: Record<string, true> = {
	".7z": true,
	".a": true,
	".avi": true,
	".bin": true,
	".bmp": true,
	".bz2": true,
	".dat": true,
	".db": true,
	".dll": true,
	".dylib": true,
	".eot": true,
	".exe": true,
	".gif": true,
	".gz": true,
	".ico": true,
	".jpg": true,
	".jpeg": true,
	".lib": true,
	".lock": true,
	".mov": true,
	".mp3": true,
	".mp4": true,
	".node": true,
	".o": true,
	".otf": true,
	".ppt": true,
	".rar": true,
	".so": true,
	".sqlite": true,
	".svg": true,
	".tar": true,
	".ttf": true,
	".wasm": true,
	".wav": true,
	".webm": true,
	".webp": true,
	".woff": true,
	".woff2": true,
	".xls": true,
	".xlsx": true,
	".zip": true,
};

const DEFAULT_SUGGESTED_EXCLUDE = [
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
	".browser",
	".browsers",
	"__pycache__",
	"*.app",
	"*.asar",
	"*.asar.unpacked",
	"*.pak",
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
	"docs/*eval-report*.md",
	"docs/*evaluation-report*.md",
	"docs/*knowledge-base*report*.md",
	"*knowledge-base-evaluation-report*.md",
	"*knowledge*.jsonl",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.lock",
	"package-lock.json",
	"playwright-report",
	"test-results",
	"browser-cache",
	"ms-playwright",
	".DS_Store",
	"Thumbs.db",
	"*.pyc",
	"*.class",
];

export interface ScanOptions {
	includeSuggestedText?: boolean;
	includePaths?: string[];
	excludePaths?: string[];
	accessPolicy?: FilesystemAccessPolicy;
}

export interface ScannedFile {
	path: string; // absolute path
	relPath: string; // relative to root
	content: string;
	fileType: string;
}

export interface ScannableFile {
	path: string; // absolute path
	relPath: string; // relative to root
	fileType: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	device: number;
	inode: number;
	rootPath?: string;
}

export interface SkippedScanEntry {
	path: string;
	reason: "suggested_excluded" | "oversized" | "binary" | "unreadable" | "inaccessible" | "extraction_failed";
	size?: number;
}

export interface ScanResult {
	files: ScannedFile[];
	skipped: {
		total: number;
		by_reason: Record<SkippedScanEntry["reason"], number>;
		samples: SkippedScanEntry[];
	};
}

const MAX_SKIPPED_SAMPLES = 25;

export function createSkippedScanStats(): ScanResult["skipped"] {
	return {
		total: 0,
		by_reason: {
			suggested_excluded: 0,
			oversized: 0,
			binary: 0,
			unreadable: 0,
			inaccessible: 0,
			extraction_failed: 0,
		},
		samples: [],
	};
}

function addSkipped(skipped: ScanResult["skipped"], entry: SkippedScanEntry): void {
	skipped.total++;
	skipped.by_reason[entry.reason]++;
	if (skipped.samples.length < MAX_SKIPPED_SAMPLES) skipped.samples.push(entry);
}

export function addSkippedScanEntry(skipped: ScanResult["skipped"], entry: SkippedScanEntry): void {
	addSkipped(skipped, entry);
}

export function summarizeSkippedScan(skipped: ScanResult["skipped"]): string {
	return (
		Object.entries(skipped.by_reason)
			.filter(([, count]) => count > 0)
			.map(([reason, count]) => `${reason}: ${count}`)
			.join(", ") || "none"
	);
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
		".cc": "cpp",
		".cxx": "cpp",
		".h": "text",
		".hpp": "cpp",
		".hh": "cpp",
		".hxx": "cpp",
		".qml": "qml",
		".md": "markdown",
		".mdx": "markdown",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".toml": "toml",
		".html": "html",
		".css": "css",
		".scss": "css",
		".sh": "bash",
		".bash": "bash",
		".zsh": "shell",
		".sql": "sql",
		".graphql": "graphql",
		".pdf": "pdf",
		".doc": "docx",
		".docx": "docx",
		".txt": "text",
		".csv": "text",
		".log": "text",
	};
	return map[ext] ?? "text";
}

export function isSupportedDocumentFile(filePath: string): boolean {
	return DOCUMENT_EXTENSIONS[extname(filePath).toLowerCase()] === true;
}

function isBinaryFile(filePath: string): boolean {
	if (isSupportedDocumentFile(filePath)) return false;
	if (BINARY_EXTENSIONS[extname(filePath).toLowerCase()] === true) return true;
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const sample = Buffer.alloc(512);
		const bytesRead = readSync(fd, sample, 0, sample.length, 0);
		if (bytesRead === 0) return false;
		return sample.subarray(0, bytesRead).includes(0x00);
	} catch {
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function buildIgnoreMatcher(dirPath: string): ReturnType<typeof ignore> {
	const ig = ignore();
	ig.add(DEFAULT_SUGGESTED_EXCLUDE);

	const gitignorePath = join(dirPath, ".gitignore");
	if (existsSync(gitignorePath)) {
		ig.add(readFileSync(gitignorePath, "utf-8"));
	}

	return ig;
}

function normalizeScanPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeScanPaths(paths: string[] | undefined): string[] {
	return (paths ?? []).map(normalizeScanPath).filter(Boolean);
}

function pathMatches(relPath: string, patterns: string[]): boolean {
	const normalized = normalizeScanPath(relPath);
	return patterns.some((pattern) => normalized === pattern || normalized.startsWith(`${pattern}/`));
}

function directoryCouldContainIncludedPath(relPath: string, includePaths: string[]): boolean {
	const normalized = normalizeScanPath(relPath);
	return includePaths.some((includePath) => includePath.startsWith(`${normalized}/`));
}

export function* iterateScannableFileVisits(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Generator<ScannableFile | undefined> {
	const ig = buildIgnoreMatcher(dirPath);
	const includePaths = normalizeScanPaths(options.includePaths);
	const excludePaths = normalizeScanPaths(options.excludePaths);
	const includeSuggestedText = options.includeSuggestedText === true;

	function* walk(dir: string): Generator<ScannableFile | undefined> {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			addSkipped(skipped, { path: relative(dirPath, dir).split(sep).join("/") || ".", reason: "inaccessible" });
			return;
		}
		for (const entry of entries) {
			yield undefined;
			const fullPath = join(dir, entry.name);
			const relPath = relative(dirPath, fullPath).split(sep).join("/");
			const explicitlyIncluded = pathMatches(relPath, includePaths);

			if (pathMatches(relPath, excludePaths)) {
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}

			if (ig.ignores(relPath) && !includeSuggestedText && !explicitlyIncluded) {
				if (entry.isDirectory() && directoryCouldContainIncludedPath(relPath, includePaths)) {
					yield* walk(fullPath);
					continue;
				}
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}

			if (entry.isDirectory()) {
				if (ig.ignores(`${relPath}/`) && !includeSuggestedText && !explicitlyIncluded) {
					if (directoryCouldContainIncludedPath(relPath, includePaths)) {
						yield* walk(fullPath);
						continue;
					}
					addSkipped(skipped, { path: `${relPath}/`, reason: "suggested_excluded" });
					continue;
				}
				yield* walk(fullPath);
			} else if (entry.isFile()) {
				let info: ReturnType<typeof statSync>;
				try {
					info = statSync(fullPath);
				} catch {
					addSkipped(skipped, { path: relPath, reason: "unreadable" });
					continue;
				}
				if (info.size > MAX_FILE_SIZE) {
					addSkipped(skipped, { path: relPath, reason: "oversized", size: info.size });
					continue;
				}
				if (isBinaryFile(fullPath)) {
					addSkipped(skipped, { path: relPath, reason: "binary", size: info.size });
					continue;
				}

				yield {
					path: fullPath,
					relPath,
					fileType: detectFileType(fullPath),
					size: info.size,
					mtimeMs: info.mtimeMs,
					ctimeMs: info.ctimeMs,
					device: info.dev,
					inode: info.ino,
				};
			}
		}
	}

	yield* walk(dirPath);
}

const MAX_GITIGNORE_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 1_000_000;
const MAX_SCAN_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_SCAN_DEPTH = 128;
const MAX_SCAN_DURATION_MS = 5 * 60_000;

function scanPathIsWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readBoundedScanFile(filePath: string, maxBytes: number): Promise<string | undefined> {
	let direct: Awaited<ReturnType<typeof lstatFile>>;
	try {
		direct = await lstatFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (direct.isSymbolicLink() || !direct.isFile()) {
		throw new Error(`Scan configuration is not a regular non-symlink file: ${filePath}`);
	}
	if (direct.size > maxBytes) throw new Error(`Scan configuration exceeds ${maxBytes} bytes: ${filePath}`);
	const handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== direct.dev || opened.ino !== direct.ino) {
			throw new Error(`Scan configuration changed while opening: ${filePath}`);
		}
		if (opened.size > maxBytes) throw new Error(`Scan configuration exceeds ${maxBytes} bytes: ${filePath}`);
		const buffer = Buffer.alloc(opened.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) throw new Error(`Scan configuration exceeds ${maxBytes} bytes: ${filePath}`);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function buildIgnoreMatcherAsync(dirPath: string): Promise<ReturnType<typeof ignore>> {
	const ig = ignore();
	ig.add(DEFAULT_SUGGESTED_EXCLUDE);
	const gitignore = await readBoundedScanFile(join(dirPath, ".gitignore"), MAX_GITIGNORE_BYTES);
	if (gitignore !== undefined) ig.add(gitignore);
	return ig;
}

async function isBinaryFileAsync(filePath: string, expected: { dev: number; ino: number }): Promise<boolean> {
	if (isSupportedDocumentFile(filePath)) return false;
	if (BINARY_EXTENSIONS[extname(filePath).toLowerCase()] === true) return true;
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) return true;
		const sample = Buffer.alloc(8_000);
		const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
		return bytesRead > 0 && sample.subarray(0, bytesRead).includes(0x00);
	} catch {
		return true;
	} finally {
		await handle?.close();
	}
}

export async function* iterateScannableFileVisitsAsync(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
	signal?: AbortSignal,
): AsyncGenerator<ScannableFile | undefined> {
	const authorizedRoot = authorizeExistingPath(dirPath, options.accessPolicy);
	const initialRootInfo = await lstatFile(authorizedRoot);
	if (initialRootInfo.isSymbolicLink() || !initialRootInfo.isDirectory()) {
		throw new Error(`Scan root is not a regular non-symlink directory: ${authorizedRoot}`);
	}
	const root = await realpathFile(authorizedRoot);
	if (authorizeExistingPath(root, options.accessPolicy) !== root) {
		throw new Error(`Scan root changed while it was being authorized: ${authorizedRoot}`);
	}
	const [canonicalRootInfo, currentRootInfo] = await Promise.all([lstatFile(root), lstatFile(authorizedRoot)]);
	if (
		canonicalRootInfo.isSymbolicLink() ||
		!canonicalRootInfo.isDirectory() ||
		currentRootInfo.isSymbolicLink() ||
		!currentRootInfo.isDirectory() ||
		canonicalRootInfo.dev !== initialRootInfo.dev ||
		canonicalRootInfo.ino !== initialRootInfo.ino ||
		currentRootInfo.dev !== initialRootInfo.dev ||
		currentRootInfo.ino !== initialRootInfo.ino
	) {
		throw new Error(`Scan root changed while it was being resolved: ${authorizedRoot}`);
	}
	const ig = await buildIgnoreMatcherAsync(root);
	const includePaths = normalizeScanPaths(options.includePaths);
	const excludePaths = normalizeScanPaths(options.excludePaths);
	const includeSuggestedText = options.includeSuggestedText === true;
	const deadline = Date.now() + MAX_SCAN_DURATION_MS;
	let visitedEntries = 0;
	let totalBytes = 0;

	const assertScanActive = (): void => {
		if (signal?.aborted) throw new Error("Cancelled");
		if (Date.now() > deadline) throw new Error(`Directory scan exceeded ${MAX_SCAN_DURATION_MS}ms`);
	};

	async function* walk(dir: string, depth: number): AsyncGenerator<ScannableFile | undefined> {
		assertScanActive();
		if (depth > MAX_SCAN_DEPTH) throw new Error(`Directory scan exceeds maximum depth ${MAX_SCAN_DEPTH}`);
		let direct: Awaited<ReturnType<typeof lstatFile>>;
		let canonical: string;
		try {
			direct = await lstatFile(dir);
			canonical = await realpathFile(dir);
		} catch {
			addSkipped(skipped, { path: relative(root, dir).split(sep).join("/") || ".", reason: "inaccessible" });
			return;
		}
		if (
			direct.isSymbolicLink() ||
			!direct.isDirectory() ||
			!scanPathIsWithin(canonical, root) ||
			(depth === 0 && (direct.dev !== initialRootInfo.dev || direct.ino !== initialRootInfo.ino))
		) {
			addSkipped(skipped, { path: relative(root, dir).split(sep).join("/") || ".", reason: "inaccessible" });
			return;
		}
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			directory = await opendir(canonical);
		} catch {
			addSkipped(skipped, { path: relative(root, dir).split(sep).join("/") || ".", reason: "inaccessible" });
			return;
		}
		const assertDirectoryStable = async (): Promise<void> => {
			const current = await lstatFile(canonical);
			const currentCanonical = await realpathFile(canonical);
			if (
				current.isSymbolicLink() ||
				!current.isDirectory() ||
				current.dev !== direct.dev ||
				current.ino !== direct.ino ||
				currentCanonical !== canonical
			) {
				throw new Error(`Directory changed during scan: ${dir}`);
			}
		};
		try {
			await assertDirectoryStable();
		} catch (error) {
			await directory.close();
			throw error;
		}
		for await (const entry of directory) {
			assertScanActive();
			await assertDirectoryStable();
			visitedEntries++;
			if (visitedEntries > MAX_SCAN_ENTRIES) {
				throw new Error(`Directory scan exceeds ${MAX_SCAN_ENTRIES} entries`);
			}
			yield undefined;
			const fullPath = join(canonical, entry.name);
			const relPath = relative(root, fullPath).split(sep).join("/");
			const explicitlyIncluded = pathMatches(relPath, includePaths);
			if (pathMatches(relPath, excludePaths)) {
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}
			let info: Awaited<ReturnType<typeof lstatFile>>;
			try {
				info = await lstatFile(fullPath);
			} catch {
				addSkipped(skipped, { path: relPath, reason: "unreadable" });
				continue;
			}
			if (info.isSymbolicLink()) {
				addSkipped(skipped, { path: relPath, reason: "inaccessible" });
				continue;
			}
			let safePath: string;
			try {
				safePath = await realpathFile(fullPath);
			} catch {
				addSkipped(skipped, { path: relPath, reason: "inaccessible" });
				continue;
			}
			if (!scanPathIsWithin(safePath, root)) {
				addSkipped(skipped, { path: relPath, reason: "inaccessible" });
				continue;
			}
			if (ig.ignores(relPath) && !includeSuggestedText && !explicitlyIncluded) {
				if (info.isDirectory() && directoryCouldContainIncludedPath(relPath, includePaths)) {
					yield* walk(safePath, depth + 1);
					continue;
				}
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}
			if (info.isDirectory()) {
				if (ig.ignores(`${relPath}/`) && !includeSuggestedText && !explicitlyIncluded) {
					if (directoryCouldContainIncludedPath(relPath, includePaths)) {
						yield* walk(safePath, depth + 1);
						continue;
					}
					addSkipped(skipped, { path: `${relPath}/`, reason: "suggested_excluded" });
					continue;
				}
				yield* walk(safePath, depth + 1);
			} else if (info.isFile()) {
				totalBytes += info.size;
				if (totalBytes > MAX_SCAN_TOTAL_BYTES) {
					throw new Error(`Directory scan exceeds ${MAX_SCAN_TOTAL_BYTES} total bytes`);
				}
				if (info.size > MAX_FILE_SIZE) {
					addSkipped(skipped, { path: relPath, reason: "oversized", size: info.size });
					continue;
				}
				if (await isBinaryFileAsync(safePath, info)) {
					addSkipped(skipped, { path: relPath, reason: "binary", size: info.size });
					continue;
				}
				await assertDirectoryStable();
				const [currentFile, currentPath] = await Promise.all([lstatFile(safePath), realpathFile(safePath)]);
				if (
					currentFile.isSymbolicLink() ||
					!currentFile.isFile() ||
					currentFile.dev !== info.dev ||
					currentFile.ino !== info.ino ||
					currentPath !== safePath ||
					!scanPathIsWithin(currentPath, root)
				) {
					addSkipped(skipped, { path: relPath, reason: "inaccessible", size: info.size });
					continue;
				}
				yield {
					path: safePath,
					relPath,
					fileType: detectFileType(safePath),
					size: info.size,
					mtimeMs: info.mtimeMs,
					ctimeMs: info.ctimeMs,
					device: info.dev,
					inode: info.ino,
					rootPath: root,
				};
			}
		}
	}

	yield* walk(root, 0);
}

export function* iterateScannableFiles(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Generator<ScannableFile> {
	for (const file of iterateScannableFileVisits(dirPath, skipped, options)) {
		if (file) yield file;
	}
}

export async function* iterateScannableFilesAsync(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
	signal?: AbortSignal,
): AsyncGenerator<ScannableFile> {
	for await (const file of iterateScannableFileVisitsAsync(dirPath, skipped, options, signal)) {
		if (file) yield file;
	}
}

export function* iterateScannedFiles(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Generator<ScannedFile> {
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		try {
			const content = readFileSync(file.path, "utf-8");
			yield { ...file, content };
		} catch {
			addSkipped(skipped, { path: file.relPath, reason: "unreadable", size: file.size });
		}
	}
}

export async function iterateScannedFilesAsync(
	dirPath: string,
	onFile: (file: ScannedFile) => Promise<void> | void,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Promise<ScanResult["skipped"]> {
	for (const file of iterateScannedFiles(dirPath, skipped, options)) {
		await onFile(file);
	}
	return skipped;
}

export function walkDir(dirPath: string, options: ScanOptions = {}): ScannedFile[] {
	return walkDirDetailed(dirPath, options).files;
}

export function walkDirDetailed(dirPath: string, options: ScanOptions = {}): ScanResult {
	const results: ScannedFile[] = [];
	const skipped = createSkippedScanStats();
	for (const file of iterateScannedFiles(dirPath, skipped, options)) results.push(file);
	return { files: results, skipped };
}

export function isReadableTextFile(filePath: string): boolean {
	return !isBinaryFile(filePath);
}

// --- Chunking ---

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

const MARKDOWN_TARGET_TOKENS = 450;
const TEXT_TARGET_TOKENS = 550;
const MAX_TEXT_CHUNK_CHARS = 6_000;

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

export function chunkIdentityHash(opts: {
	content: string;
	filePath: string;
	fileType: string;
	startLine: number;
	endLine: number;
	metadataJson: string;
}): string {
	return contentHash(
		[opts.filePath, opts.fileType, String(opts.startLine), String(opts.endLine), opts.metadataJson, opts.content].join(
			"\0",
		),
	);
}

function normalizeHeading(heading: string): string {
	return heading.replace(/^#{1,6}\s+/, "").trim();
}

function buildContextPrefix(filePath: string, fileType: string, metadata: ChunkMetadata): string {
	const parts = [`File: ${filePath}`, `Type: ${fileType}`];
	const heading = typeof metadata.heading === "string" ? metadata.heading : "";
	const breadcrumb = typeof metadata.breadcrumb === "string" ? metadata.breadcrumb : "";
	const language = typeof metadata.language === "string" ? metadata.language : "";
	const symbol =
		typeof metadata.symbol === "string"
			? metadata.symbol
			: typeof metadata.function_name === "string"
				? metadata.function_name
				: "";
	const symbolKind = typeof metadata.symbol_kind === "string" ? metadata.symbol_kind : "";
	const parentSymbol = typeof metadata.parent_symbol === "string" ? metadata.parent_symbol : "";
	const signature = typeof metadata.signature === "string" ? metadata.signature : "";
	const scope = Array.isArray(metadata.scope) ? metadata.scope.filter((item) => typeof item === "string") : [];
	if (breadcrumb) parts.push(`Section: ${breadcrumb}`);
	else if (heading) parts.push(`Section: ${normalizeHeading(heading)}`);
	if (language) parts.push(`Language: ${language}`);
	if (scope.length > 0) parts.push(`Scope: ${scope.join(" > ")}`);
	else if (parentSymbol) parts.push(`Parent: ${parentSymbol}`);
	if (symbolKind) parts.push(`Kind: ${symbolKind}`);
	if (symbol) parts.push(`Symbol: ${symbol}`);
	if (signature) parts.push(`Signature: ${signature}`);
	return parts.join("\n");
}

export function buildChunkEmbeddingText(
	chunk: Pick<ChunkInsert, "content" | "file_path" | "file_type" | "metadata_json">,
): string {
	let metadata: ChunkMetadata = {};
	try {
		metadata = JSON.parse(chunk.metadata_json) as ChunkMetadata;
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
	metadata: ChunkMetadata = {},
): Omit<ChunkInsert, "kb_id"> {
	const metadata_json = JSON.stringify(metadata);
	const chunk = {
		content_hash: chunkIdentityHash({ content, filePath, fileType, startLine, endLine, metadataJson: metadata_json }),
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

export function chunkMarkdown(content: string, filePath: string, fileType = "markdown"): Omit<ChunkInsert, "kb_id">[] {
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
			makeChunk(text.trim(), filePath, fileType, start, end, {
				heading: currentHeading,
				breadcrumb: currentBreadcrumb(),
			}),
		);
	}

	function pushOversizedMarkdownParagraph(para: string, start: number): void {
		let offset = 0;
		let sliceStart = start;
		while (offset < para.length) {
			const slice = para.slice(offset, offset + MAX_TEXT_CHUNK_CHARS).trim();
			if (slice.length >= 50) {
				pushMarkdownChunk(slice, sliceStart, sliceStart + slice.split("\n").length);
			}
			sliceStart += slice.split("\n").length;
			offset += MAX_TEXT_CHUNK_CHARS;
		}
	}

	function flush(endLine: number): void {
		const text = sectionLines.join("\n").trim();
		if (text.length < 50) return;

		const fullText = currentHeading ? `${currentHeading}\n\n${text}` : text;
		const paragraphs = fullText.split(/\n\n+/);
		let buffer: string[] = [];
		let bufferStart = startLine;

		for (const para of paragraphs) {
			if (para.length > MAX_TEXT_CHUNK_CHARS) {
				const oversizedText = buffer.length > 0 ? [...buffer, para].join("\n\n") : para;
				const oversizedStart = buffer.length > 0 ? bufferStart : endLine;
				if (buffer.length > 0) {
					buffer = [];
				}
				pushOversizedMarkdownParagraph(oversizedText, oversizedStart);
				bufferStart = endLine;
				continue;
			}
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

	function pushOversizedParagraph(para: string): void {
		let offset = 0;
		while (offset < para.length) {
			const slice = para.slice(offset, offset + MAX_TEXT_CHUNK_CHARS).trim();
			if (slice.length >= 50) {
				chunks.push(makeChunk(slice, filePath, fileType, lineOffset, lineOffset + slice.split("\n").length));
			}
			lineOffset += slice.split("\n").length;
			offset += MAX_TEXT_CHUNK_CHARS;
		}
	}

	for (const para of paragraphs) {
		const paraTokens = estimateTokens(para);
		if (para.length > MAX_TEXT_CHUNK_CHARS) {
			if (buffer.length > 0) {
				flush();
				buffer = [];
				bufferTokens = 0;
			}
			pushOversizedParagraph(para);
			continue;
		}
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

export function isCodeFileType(fileType: string): boolean {
	return ["typescript", "javascript", "python", "go", "rust", "java", "bash", "c", "cpp", "qml"].includes(fileType);
}

export async function analyzeIndexableContent(
	content: string,
	filePath: string,
	fileType = detectFileType(filePath),
): Promise<{
	chunks: Omit<ChunkInsert, "kb_id">[];
	symbols: KnowledgeSymbolInsert[];
}> {
	const detectedFileType = detectFileType(filePath);
	const analysisFileType = isCodeFileType(detectedFileType) ? detectedFileType : fileType;
	if (isCodeFileType(analysisFileType)) {
		try {
			const { analyzeCodeWithAST } = await import("./chunkers/code-ast.ts");
			const analysis = await analyzeCodeWithAST(content, filePath, analysisFileType);
			const chunks = analysis.chunks.length > 0 ? analysis.chunks : await chunkFile(content, filePath);
			const symbols = dedupeSymbols([...analysis.symbols, ...extractSymbols(content, filePath, analysisFileType)]);
			return { chunks, symbols };
		} catch {
			/* fallback below */
		}
	}
	return { chunks: await chunkFile(content, filePath), symbols: extractSymbols(content, filePath, analysisFileType) };
}

function dedupeSymbols(symbols: KnowledgeSymbolInsert[]): KnowledgeSymbolInsert[] {
	const seen = new Set<string>();
	const deduped: KnowledgeSymbolInsert[] = [];
	for (const symbol of symbols) {
		const key = [
			symbol.kind,
			symbol.name,
			symbol.file_path,
			String(symbol.start_line),
			symbol.container_name ?? "",
		].join("\0");
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(symbol);
	}
	return deduped;
}

export async function chunkFile(content: string, filePath: string): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const fileType = detectFileType(filePath);
	let chunks: Omit<ChunkInsert, "kb_id">[] = [];

	if (fileType === "markdown") {
		chunks = chunkMarkdown(content, filePath);
	} else if (isCodeFileType(fileType)) {
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
