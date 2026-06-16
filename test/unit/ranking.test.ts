import { describe, expect, it } from "vitest";
import { buildChunkEmbeddingText, contentHash, preTokenizeForFTS } from "../../src/indexer/chunker.ts";
import { normalizedQueryText, signalTokens, tokenizeForSearch } from "../../src/search/query.ts";
import {
	hasEnoughLexicalEvidence,
	isTestPath,
	normalizeFileTypeFilter,
	queryCoverage,
	scoreChunkForQuery,
} from "../../src/search/ranking.ts";
import type { Chunk } from "../../src/storage/sqlite.ts";

function chunk(overrides: Partial<Chunk>): Chunk {
	const content = overrides.content ?? "Error handling logging implementation details.";
	const base = {
		id: "chunk",
		kb_id: "kb",
		content_hash: contentHash(content),
		content,
		content_tokenized: preTokenizeForFTS(content),
		file_path: "src/errors.go",
		file_type: "go",
		indexed_at: 1,
		metadata_json: "{}",
		start_line: 1,
		end_line: 4,
	};
	return { ...base, ...overrides };
}

describe("query normalization", () => {
	it("normalizes common typos and punctuation", () => {
		expect(normalizedQueryText("ho to setpup the bot?")).toContain("setup");
		expect(normalizedQueryText("ho to setpup the bot?")).not.toContain("setpup");
	});

	it("stems plural signal tokens", () => {
		expect(signalTokens(tokenizeForSearch("tests permissions"))).toEqual(new Set(["test", "permission"]));
	});
});

describe("ranking heuristics", () => {
	it("normalizes file type aliases", () => {
		expect(normalizeFileTypeFilter("md")).toBe("markdown");
		expect(normalizeFileTypeFilter("ts")).toBe("typescript");
	});

	it("detects common test paths across ecosystems", () => {
		expect(isTestPath("bot/errors_test.go")).toBe(true);
		expect(isTestPath("src/foo.spec.ts")).toBe(true);
		expect(isTestPath("__tests__/foo.ts")).toBe(true);
	});

	it("boosts named source modules and penalizes tests without test intent", () => {
		const source = chunk({ file_path: "stt/stt.go", content: "Speech to text provider implementation." });
		const test = chunk({ file_path: "stt/stt_test.go", content: source.content });
		const queryTokens = tokenizeForSearch("STT speech to text provider");

		const sourceScore = scoreChunkForQuery(0.5, source, queryTokens);
		const testScore = scoreChunkForQuery(0.5, test, queryTokens);

		expect(sourceScore.source_boost).toBeGreaterThan(0);
		expect(sourceScore.adjusted_score).toBeGreaterThan(testScore.adjusted_score);
	});

	it("allows test files when the query asks for tests", () => {
		const source = chunk({ file_path: "bot/errors.go" });
		const test = chunk({ file_path: "bot/errors_test.go" });
		const queryTokens = tokenizeForSearch("error handling test");

		const sourceScore = scoreChunkForQuery(0.5, source, queryTokens);
		const testScore = scoreChunkForQuery(0.5, test, queryTokens);

		expect(testScore.test_intent).toBe(true);
		expect(testScore.adjusted_score).toBeGreaterThan(sourceScore.adjusted_score);
	});

	it("boosts guide documents for setup and installation intent", () => {
		const guide = chunk({
			file_path: "INSTALL.md",
			file_type: "markdown",
			content: "Setup and configuration instructions.",
		});
		const component = chunk({
			file_path: "bot/setup_components.go",
			file_type: "go",
			content: "Setup component implementation.",
		});
		const queryTokens = tokenizeForSearch("ho to setpup the bot");

		const guideScore = scoreChunkForQuery(0.5, guide, queryTokens);
		const componentScore = scoreChunkForQuery(0.5, component, queryTokens);

		expect(guideScore.documentation_boost).toBeGreaterThan(0);
		expect(guideScore.adjusted_score).toBeGreaterThan(componentScore.adjusted_score);
	});

	it("penalizes localization files unless the query asks for localization", () => {
		const implementation = chunk({
			file_path: "channel/memory.go",
			file_type: "go",
			content: "Memory context management implementation.",
		});
		const locale = chunk({
			file_path: "locale/lang/en.json",
			file_type: "json",
			content: "Memory context management message labels.",
		});

		const implementationScore = scoreChunkForQuery(0.5, implementation, tokenizeForSearch("memory context management"));
		const localeScore = scoreChunkForQuery(0.7, locale, tokenizeForSearch("memory context management"));
		const localeIntentScore = scoreChunkForQuery(0.7, locale, tokenizeForSearch("memory context translation message"));

		expect(localeScore.is_localization).toBe(true);
		expect(localeScore.localization_penalty).toBeLessThan(1);
		expect(implementationScore.adjusted_score).toBeGreaterThan(localeScore.adjusted_score);
		expect(localeIntentScore.localization_penalty).toBe(1);
	});

	it("requires enough lexical evidence unless source intent is strong", () => {
		const accidental = chunk({
			content: "Review examples mention unknown edge cases.",
			file_path: "docs/review.md",
			file_type: "markdown",
		});
		const namedSource = chunk({
			content: "Speech provider implementation.",
			file_path: "stt/stt.go",
			file_type: "go",
		});

		expect(hasEnoughLexicalEvidence(accidental, tokenizeForSearch("blablabla xyz unknown nonsense"))).toBe(false);
		expect(hasEnoughLexicalEvidence(namedSource, tokenizeForSearch("STT speech to text provider"))).toBe(true);
	});

	it("computes coverage from contextual chunk text", () => {
		const item = chunk({ file_path: "docs/billing-refunds.md", file_type: "markdown" });
		const coverage = queryCoverage(buildChunkEmbeddingText(item), tokenizeForSearch("billing refunds"));
		expect(coverage).toBe(1);
	});
});
