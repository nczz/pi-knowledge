import { describe, expect, it } from "vitest";
import { decorateEmbeddingInput, resolveEmbeddingDecoration } from "../../src/embedding/instructions.ts";

describe("embedding input instructions", () => {
	it("resolves the Jina alias to the default nl2code prompts for multilingual input", () => {
		const decoration = resolveEmbeddingDecoration({
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "jina",
		});

		expect(decoration.strategy).toBe("jina-code");
		expect(decoration.task).toBe("nl2code");
		expect(decorateEmbeddingInput("如何更新知識庫？", "query", decoration.instructions)).toBe(
			"Find the most relevant code snippet given the following query:\n如何更新知識庫？",
		);
		expect(decorateEmbeddingInput("呼叫 knowledge_update。", "passage", decoration.instructions)).toBe(
			"Candidate code snippet:\n呼叫 knowledge_update。",
		);
	});

	it.each([
		["code2code", "Find an equivalent code snippet given the following code snippet:\n", "Candidate code snippet:\n"],
		["code2nl", "Find the most relevant comment given the following code snippet:\n", "Candidate comment:\n"],
		[
			"code2completion",
			"Find the most relevant completion given the following start of code snippet:\n",
			"Candidate completion:\n",
		],
		["qa", "Find the most relevant answer given the following question:\n", "Candidate answer:\n"],
	] as const)("uses the published %s prompt pair exactly", (task, query, document) => {
		const decoration = resolveEmbeddingDecoration({
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "jina-code",
			PI_KNOWLEDGE_EMBEDDING_TASK: task,
		});

		expect(decoration.instructions).toEqual({ query, document });
	});

	it("preserves multilingual custom whitespace and permits valid Unicode joiners", () => {
		const queryInstruction = "查詢條件 👩‍💻：\n";
		const documentInstruction = "候選內容：\n\n";
		const decoration = resolveEmbeddingDecoration({
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
			PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: queryInstruction,
			PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: documentInstruction,
		});

		expect(decoration.instructions).toEqual({ query: queryInstruction, document: documentInstruction });
		expect(decorateEmbeddingInput("find OAuthToken", "query", decoration.instructions)).toBe(
			"查詢條件 👩‍💻：\nfind OAuthToken",
		);
	});

	it("requires explicit custom query and document variables without silently reusing another strategy", () => {
		expect(() =>
			resolveEmbeddingDecoration({
				PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
				PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "查詢：",
			}),
		).toThrow("requires PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION");
		const emptyDocument = resolveEmbeddingDecoration({
			PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
			PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "查詢：",
			PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "",
		});
		expect(emptyDocument.instructions.document).toBe("");
		expect(() =>
			resolveEmbeddingDecoration({
				PI_KNOWLEDGE_EMBEDDING_PREFIXES: "e5",
				PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "查詢：",
				PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "文件：",
			}),
		).toThrow("valid only when PI_KNOWLEDGE_EMBEDDING_PREFIXES=custom");
	});

	it("rejects control characters but not multilingual printable text", () => {
		expect(() =>
			resolveEmbeddingDecoration({
				PI_KNOWLEDGE_EMBEDDING_PREFIXES: "custom",
				PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION: "查詢：\u0000",
				PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION: "文件：",
			}),
		).toThrow("unsupported control character");
	});
});
