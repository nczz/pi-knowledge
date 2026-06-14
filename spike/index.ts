import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "spike_all",
		label: "Spike: Run All Tests",
		description: "Verify native deps work: better-sqlite3, @huggingface/transformers, FTS5",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, onUpdate) {
			const results: string[] = [];

			// 1. SQLite native binding
			onUpdate?.({ content: [{ type: "text", text: "Testing better-sqlite3..." }] });
			try {
				const Database = (await import("better-sqlite3")).default;
				const db = new Database(":memory:");
				db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
				db.prepare("INSERT INTO test (value) VALUES (?)").run("spike-ok");
				const row = db.prepare("SELECT value FROM test").get() as { value: string };
				db.close();
				results.push(`✅ SQLite: ${row.value}`);
			} catch (e) {
				results.push(`❌ SQLite: ${(e as Error).message}`);
			}

			// 2. Embedding pipeline (model download + ONNX inference + tokenizer)
			onUpdate?.({ content: [{ type: "text", text: "Testing embedding (first run downloads ~32MB)..." }] });
			try {
				const { pipeline, env } = await import("@huggingface/transformers");
				env.cacheDir = "/tmp/pi-knowledge-models";
				const ext = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { quantized: true });
				const out = await ext("query: 測試中文嵌入", { pooling: "mean", normalize: true });
				results.push(`✅ Embedding: dims=${JSON.stringify(out.dims)}`);
				await ext.dispose();
			} catch (e) {
				results.push(`❌ Embedding: ${(e as Error).message}`);
			}

			// 3. FTS5 + CJK pre-tokenize
			onUpdate?.({ content: [{ type: "text", text: "Testing FTS5..." }] });
			try {
				const Database = (await import("better-sqlite3")).default;
				const db = new Database(":memory:");
				db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
				db.prepare("INSERT INTO docs (content) VALUES (?)").run("認 證 流 程 設 定");
				db.prepare("INSERT INTO docs (content) VALUES (?)").run("get Element By Id DOM query");
				const zh = db.prepare("SELECT * FROM docs WHERE docs MATCH ?").all("認 AND 流");
				const en = db.prepare("SELECT * FROM docs WHERE docs MATCH ?").all("Element AND query");
				db.close();
				results.push(`✅ FTS5: zh=${zh.length} match, en=${en.length} match`);
			} catch (e) {
				results.push(`❌ FTS5: ${(e as Error).message}`);
			}

			return { content: [{ type: "text", text: results.join("\n") }] };
		},
	});
}
