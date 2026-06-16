import { buildChunkEmbeddingText } from "../indexer/chunker.ts";
import type { Chunk } from "../storage/sqlite.ts";
import { signalTokens, tokenizeForSearch } from "./query.ts";

export const MIN_HYBRID_SCORE = 0.18;

export const FILE_TYPE_ALIASES: Record<string, string> = {
	csharp: "csharp",
	cs: "csharp",
	cpp: "cpp",
	hpp: "cpp",
	js: "javascript",
	jsx: "javascript",
	md: "markdown",
	mdx: "markdown",
	php: "php",
	py: "python",
	rb: "ruby",
	sh: "shell",
	ts: "typescript",
	tsx: "typescript",
	yml: "yaml",
};

const SOURCE_FILE_TYPES = new Set([
	"c",
	"cpp",
	"csharp",
	"go",
	"java",
	"javascript",
	"php",
	"python",
	"ruby",
	"rust",
	"typescript",
]);

const TEST_PATH_PATTERNS = ["_test.", ".test.", ".spec.", "/test/", "/tests/", "tests/", "__tests__/", "spec/"];

export interface RankingDiagnostics {
	adjusted_score: number;
	base_score: number;
	coverage: number;
	documentation_boost: number;
	is_localization: boolean;
	is_test: boolean;
	localization_penalty: number;
	path_boost: number;
	source_boost: number;
	test_intent: boolean;
	user_guide_intent: boolean;
}

export function normalizeFileTypeFilter(fileType: string | undefined): string | undefined {
	if (!fileType) return undefined;
	const normalized = fileType.trim().toLowerCase();
	return FILE_TYPE_ALIASES[normalized] ?? normalized;
}

export function isTestPath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return TEST_PATH_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function queryAsksForTests(queryTokens: Set<string>): boolean {
	const signals = signalTokens(queryTokens);
	return ["assert", "fixture", "spec", "test", "testing"].some((token) => signals.has(token));
}

function queryAsksForUserGuide(queryTokens: Set<string>): boolean {
	const signals = signalTokens(queryTokens);
	return ["config", "configuration", "install", "onboard", "quickstart", "setup", "start", "usage"].some((token) =>
		signals.has(token),
	);
}

function queryAsksForLocalization(queryTokens: Set<string>): boolean {
	const signals = signalTokens(queryTokens);
	return ["i18n", "lang", "language", "locale", "localization", "translation"].some((token) => signals.has(token));
}

export function isLocalizationPath(filePath: string, fileType: string): boolean {
	if (!["json", "markdown", "text", "toml", "yaml"].includes(fileType)) return false;
	const lower = filePath.toLowerCase();
	return (
		lower.includes("/locale/") ||
		lower.startsWith("locale/") ||
		lower.includes("/locales/") ||
		lower.startsWith("locales/") ||
		lower.includes("/lang/") ||
		lower.startsWith("lang/") ||
		lower.includes("/i18n/") ||
		lower.startsWith("i18n/") ||
		lower.includes("/translations/") ||
		lower.startsWith("translations/")
	);
}

export function queryCoverage(text: string, queryTokens: Set<string>): number {
	const textTokens = signalTokens(tokenizeForSearch(text));
	const signals = signalTokens(queryTokens);
	if (signals.size === 0) return 0;
	let matched = 0;
	for (const token of signals) {
		if (textTokens.has(token)) matched++;
	}
	return matched / signals.size;
}

export function hasAnyLexicalEvidence(text: string, queryTokens: Set<string>): boolean {
	return queryCoverage(text, queryTokens) > 0;
}

export function pathTokenBoost(filePath: string, queryTokens: Set<string>): number {
	const pathTokens = signalTokens(tokenizeForSearch(filePath.replace(/[./_-]/g, " ")));
	const signals = signalTokens(queryTokens);
	let matched = 0;
	for (const token of signals) {
		if (pathTokens.has(token)) matched++;
	}
	if (matched === 0) return 0;
	return Math.min(0.45, 0.18 * matched);
}

export function basenameTokenBoost(filePath: string, queryTokens: Set<string>): number {
	const basename = filePath.split("/").at(-1) ?? filePath;
	const stem = basename.replace(/\.[^.]+$/, "").replace(/_test$|\.test$|\.spec$/i, "");
	const baseTokens = signalTokens(tokenizeForSearch(stem.replace(/[._-]/g, " ")));
	const signals = signalTokens(queryTokens);
	if (baseTokens.size === 0 || signals.size === 0) return 0;
	for (const token of signals) {
		if (baseTokens.has(token)) return 0.32;
	}
	return 0;
}

export function sourceFileBoost(chunk: Pick<Chunk, "file_path" | "file_type">, queryTokens: Set<string>): number {
	if (!SOURCE_FILE_TYPES.has(chunk.file_type)) return 0;
	if (queryAsksForUserGuide(queryTokens)) return Math.min(0.05, pathTokenBoost(chunk.file_path, queryTokens));
	const boost = basenameTokenBoost(chunk.file_path, queryTokens);
	if (boost > 0) return boost;
	const boostFromPath = pathTokenBoost(chunk.file_path, queryTokens);
	return Math.min(0.22, boostFromPath);
}

function documentationBoost(chunk: Pick<Chunk, "file_path" | "file_type">, queryTokens: Set<string>): number {
	if (!queryAsksForUserGuide(queryTokens)) return 0;
	const lower = chunk.file_path.toLowerCase();
	if (chunk.file_type !== "markdown") return 0;
	if (
		lower.includes("install") ||
		lower.includes("readme") ||
		lower.includes("getting-started") ||
		lower.includes("quickstart")
	) {
		return 0.85;
	}
	if (lower.startsWith("docs/")) return 0.35;
	return 0;
}

export function scoreChunkForQuery(baseScore: number, chunk: Chunk, queryTokens: Set<string>): RankingDiagnostics {
	const guideIntent = queryAsksForUserGuide(queryTokens);
	const pathBoost =
		guideIntent && SOURCE_FILE_TYPES.has(chunk.file_type)
			? Math.min(0.08, pathTokenBoost(chunk.file_path, queryTokens))
			: pathTokenBoost(chunk.file_path, queryTokens);
	const sourceBoost = sourceFileBoost(chunk, queryTokens);
	const docBoost = documentationBoost(chunk, queryTokens);
	const testIntent = queryAsksForTests(queryTokens);
	const test = isTestPath(chunk.file_path);
	const localization = isLocalizationPath(chunk.file_path, chunk.file_type);
	const localizationPenalty = localization && !queryAsksForLocalization(queryTokens) ? 0.2 : 1;
	let adjustedScore = baseScore + pathBoost + sourceBoost + docBoost;
	if (test && !testIntent) adjustedScore *= 0.48;
	if (!test && testIntent) adjustedScore *= 0.88;
	adjustedScore *= localizationPenalty;
	return {
		adjusted_score: adjustedScore,
		base_score: baseScore,
		coverage: queryCoverage(buildChunkEmbeddingText(chunk), queryTokens),
		documentation_boost: docBoost,
		is_localization: localization,
		is_test: test,
		localization_penalty: localizationPenalty,
		path_boost: pathBoost,
		source_boost: sourceBoost,
		test_intent: testIntent,
		user_guide_intent: guideIntent,
	};
}

export function hasEnoughLexicalEvidence(chunk: Chunk, queryTokens: Set<string>): boolean {
	const signals = signalTokens(queryTokens);
	if (signals.size <= 1) return true;
	if (sourceFileBoost(chunk, queryTokens) >= 0.22) return true;
	const coverage = queryCoverage(buildChunkEmbeddingText(chunk), queryTokens);
	if (signals.size <= 3) return coverage >= 1 / signals.size;
	return coverage >= 0.34;
}
