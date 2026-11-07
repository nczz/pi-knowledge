import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSearchTuning, resolveSearchWindow, summarizeSearchTuning } from "../../src/search/tuning.ts";

describe("search tuning", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	it("selects a low-token profile without overriding explicit search limits", () => {
		const tuning = resolveSearchTuning({
			query: "why does the Windows OMP model worker need child.send fallback",
			mode: "hybrid",
			profile: "low_token",
			kbSourceTypes: ["directory"],
		});
		const summary = summarizeSearchTuning(tuning, 8, Math.max(tuning.candidateMin, 8 * tuning.candidateMultiplier));

		expect(tuning.selectedProfile).toBe("low_token");
		expect(tuning.defaultLimit).toBe(5);
		expect(tuning.snippetMaxLength).toBe(768);
		expect(tuning.minHybridScore).toBe(0.4);
		expect(summary.limit).toBe(8);
		expect(summary.candidate_limit).toBe(64);
	});

	it("validates bounded integer pagination before retrieval", () => {
		expect(resolveSearchWindow(undefined, undefined, 10)).toEqual({ limit: 10, offset: 0 });
		expect(resolveSearchWindow(50, 750, 10)).toEqual({ limit: 50, offset: 750 });
		expect(() => resolveSearchWindow(0, 0, 10)).toThrow("integer from 1 to 50");
		expect(() => resolveSearchWindow(51, 0, 10)).toThrow("integer from 1 to 50");
		expect(() => resolveSearchWindow(2.5, 0, 10)).toThrow("integer from 1 to 50");
		expect(() => resolveSearchWindow(10, -1, 10)).toThrow("non-negative integer");
		expect(() => resolveSearchWindow(10, 1.5, 10)).toThrow("non-negative integer");
		expect(() => resolveSearchWindow(50, 751, 10)).toThrow("offset + limit must not exceed 800");
	});

	it("auto-selects precision for exact identifiers and long context for conceptual document searches", () => {
		const exact = resolveSearchTuning({
			query: "PI_KNOWLEDGE_NODE_PATH",
			mode: "hybrid",
			kbSourceTypes: ["directory"],
		});
		const docs = resolveSearchTuning({
			query: "explain the architecture and design tradeoffs behind model worker shutdown",
			mode: "hybrid",
			kbSourceTypes: ["url"],
		});
		const ordinary = resolveSearchTuning({
			query: "authentication",
			mode: "hybrid",
			kbSourceTypes: ["directory"],
		});

		expect(exact.requestedProfile).toBe("auto");
		expect(exact.selectedProfile).toBe("precision");
		expect(ordinary.selectedProfile).toBe("balanced");
		expect(docs.selectedProfile).toBe("long_context");
		expect(docs.snippetMaxLength).toBeGreaterThan(exact.snippetMaxLength);
	});

	it("clamps environment overrides to bounded safe ranges", () => {
		vi.stubEnv("PI_KNOWLEDGE_SEARCH_PROFILE", "recall");
		vi.stubEnv("PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT", "999");
		vi.stubEnv("PI_KNOWLEDGE_SNIPPET_MAX_LENGTH", "4");
		vi.stubEnv("PI_KNOWLEDGE_MIN_HYBRID_SCORE", "2");
		vi.stubEnv("PI_KNOWLEDGE_SEARCH_CANDIDATE_MIN", "0");
		vi.stubEnv("PI_KNOWLEDGE_SEARCH_CANDIDATE_MULTIPLIER", "99");
		vi.stubEnv("PI_KNOWLEDGE_ADAPTIVE_MAX_CHARS", "1000000");

		const tuning = resolveSearchTuning({ query: "overview", mode: "hybrid", kbSourceTypes: ["text"] });

		expect(tuning.requestedProfile).toBe("recall");
		expect(tuning.selectedProfile).toBe("recall");
		expect(tuning.defaultLimit).toBe(50);
		expect(tuning.snippetMaxLength).toBe(80);
		expect(tuning.minHybridScore).toBe(1);
		expect(tuning.candidateMin).toBe(10);
		expect(tuning.candidateMultiplier).toBe(30);
		expect(tuning.adaptiveMaxContextChars).toBe(50_000);
	});
});
