import { describe, expect, it } from "vitest";
import type { KnowledgeStatusSnapshot } from "../../src/engine.ts";
import { formatKnowledgeStatus } from "../../src/status.ts";

const UPDATED_AT = 1_700_000_000_000;

const MISMATCH_SNAPSHOT: KnowledgeStatusSnapshot = {
	knowledge_bases: [
		{
			id: "kb-zh",
			name: "繁中專案知識庫",
			description: null,
			source_path: "/tmp/繁中專案",
			source_type: "directory",
			source_options: null,
			created_at: UPDATED_AT,
			updated_at: UPDATED_AT,
			indexed_at: UPDATED_AT,
			chunk_count: 12,
			file_count: 3,
			embedding_model: "multilingual-e5-small",
			embedding_signature: "indexed-signature",
			embedding_dimension: 384,
			vector_file: null,
			status: "ready",
		},
	],
	diagnostics: [
		{
			kb_id: "kb-zh",
			kb_name: "繁中專案知識庫",
			status: "ready",
			status_age_ms: 60_000,
			last_progress_age_ms: 60_000,
			stuck_indexing: false,
			stale_files: [],
			orphan_files: [],
			coverage_percent: 100,
			total_source_files: 3,
			indexed_files: 3,
			skipped_files: {
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
			},
		},
	],
	embeddings: [
		{
			kb_id: "kb-zh",
			kb_name: "繁中專案知識庫",
			indexed_model: "multilingual-e5-small",
			active_model: "openai:jinaai/jina-code-embeddings-1.5b",
			active_decoration: "strategy=jina-code:task=nl2code:ih=123456789abc",
			compatibility: {
				compatible: false,
				cause: "configuration",
				activeSignature: "active-signature",
				recordedSignature: "indexed-signature",
				activeDecoration: "strategy=jina-code:task=nl2code:ih=123456789abc",
				recordedDecoration: "q=query:d=passage",
				activeDimension: 384,
				recordedDimension: 384,
			},
			detail:
				"the indexed provider, model, endpoint, input limit, pooling, or normalization differs from the active configuration",
		},
	],
};

describe("knowledge status formatting", () => {
	it("shows indexed and active embedding settings and never reports healthy during a mismatch", () => {
		const output = formatKnowledgeStatus({
			snapshot: MISMATCH_SNAPSHOT,
			storagePath: "/tmp/知識庫",
			watchCount: 1,
			now: UPDATED_AT + 120_000,
		});

		expect(output).toContain("indexed=multilingual-e5-small");
		expect(output).toContain("active=openai:jinaai/jina-code-embeddings-1.5b");
		expect(output).toContain("decoration=strategy=jina-code:task=nl2code:ih=123456789abc");
		expect(output).toContain("1 embedding issues");
		expect(output).not.toContain("Health: ✓");
	});

	it("counts invalid active embedding configuration as unhealthy", () => {
		const output = formatKnowledgeStatus({
			snapshot: {
				...MISMATCH_SNAPSHOT,
				embeddings: [],
				embedding_error: "PI_KNOWLEDGE_EMBEDDING_PREFIXES=custom requires PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION.",
			},
			storagePath: "/tmp/知識庫",
			watchCount: 0,
			now: UPDATED_AT,
		});

		expect(output).toContain("Embedding configuration: ⚠️");
		expect(output).toContain("active=unavailable");
		expect(output).toContain("1 embedding issues");
		expect(output).not.toContain("Health: ✓");
	});

	it("reports error state without treating absent searchable vectors as an embedding mismatch", () => {
		const knowledgeBase = MISMATCH_SNAPSHOT.knowledge_bases[0];
		const diagnostic = MISMATCH_SNAPSHOT.diagnostics[0];
		if (!knowledgeBase || !diagnostic) throw new Error("缺少狀態測試資料");
		const output = formatKnowledgeStatus({
			snapshot: {
				...MISMATCH_SNAPSHOT,
				knowledge_bases: [{ ...knowledgeBase, status: "error", chunk_count: 0 }],
				diagnostics: [{ ...diagnostic, status: "error" }],
			},
			storagePath: "/tmp/知識庫",
			watchCount: 0,
			now: UPDATED_AT,
		});

		expect(output).toContain("1 errors");
		expect(output).toContain("0 embedding issues");
		expect(output).not.toContain("⚠️ vectors:");
		expect(output).not.toContain("Health: ✓");
	});

	it("does not double-count stuck indexing as active indexing", () => {
		const knowledgeBase = MISMATCH_SNAPSHOT.knowledge_bases[0];
		const diagnostic = MISMATCH_SNAPSHOT.diagnostics[0];
		if (!knowledgeBase || !diagnostic) throw new Error("缺少卡住狀態測試資料");
		const output = formatKnowledgeStatus({
			snapshot: {
				...MISMATCH_SNAPSHOT,
				knowledge_bases: [{ ...knowledgeBase, status: "indexing", chunk_count: 0 }],
				diagnostics: [
					{
						...diagnostic,
						status: "indexing",
						stuck_indexing: true,
						last_progress_age_ms: 900_000,
					},
				],
			},
			storagePath: "/tmp/知識庫",
			watchCount: 0,
			now: UPDATED_AT,
		});

		expect(output).toContain("1 stuck indexing, 0 indexing");
		expect(output).not.toContain("Health: ✓");
	});

	it("reports a failed update while keeping the published generation available", () => {
		const diagnostic = MISMATCH_SNAPSHOT.diagnostics[0];
		if (!diagnostic) throw new Error("缺少更新失敗測試資料");
		const output = formatKnowledgeStatus({
			snapshot: {
				...MISMATCH_SNAPSHOT,
				diagnostics: [
					{
						...diagnostic,
						job: {
							kb_id: "kb-zh",
							operation: "update",
							status: "failed",
							phase: "failed",
							message: "Update failed.",
							started_at: UPDATED_AT,
							updated_at: UPDATED_AT + 1_000,
							last_progress_at: UPDATED_AT + 1_000,
							processed_files: 1,
							processed_chunks: 1,
							total_files: 1,
							skipped_total: 0,
							added_chunks: 1,
							removed_chunks: 0,
							unchanged_chunks: 0,
							error_message: "provider unavailable",
						},
					},
				],
			},
			storagePath: "/tmp/知識庫",
			watchCount: 0,
			now: UPDATED_AT + 2_000,
		});

		expect(output).toContain("failed updates using the previous generation");
		expect(output).not.toContain("Health: ✓");
	});
});
