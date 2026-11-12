import type { KnowledgeStatusSnapshot } from "./engine.ts";

export interface KnowledgeStatusFormatOptions {
	snapshot: KnowledgeStatusSnapshot;
	storagePath: string;
	watchCount: number;
	now?: number;
}

export function formatKnowledgeStatus(options: KnowledgeStatusFormatOptions): string {
	const { snapshot, storagePath, watchCount } = options;
	const now = options.now ?? Date.now();
	const embeddingByKb = new Map(snapshot.embeddings.map((embedding) => [embedding.kb_id, embedding]));
	const diagnosticsByKb = new Map(snapshot.diagnostics.map((diagnostic) => [diagnostic.kb_id, diagnostic]));
	const lines = [
		`Storage: ${storagePath}`,
		`Knowledge bases: ${snapshot.knowledge_bases.length}`,
		`Active watchers: ${watchCount}`,
	];
	if (snapshot.embedding_error) lines.push(`Embedding configuration: ⚠️ ${snapshot.embedding_error}`);
	lines.push("");

	for (const kb of snapshot.knowledge_bases) {
		const age = Math.round((now - kb.updated_at) / 60_000);
		const diagnostic = diagnosticsByKb.get(kb.id);
		const embedding = embeddingByKb.get(kb.id);
		lines.push(
			`  "${kb.name}" — ${kb.status} — ${kb.chunk_count} chunks, ${kb.file_count} files — updated ${age}m ago`,
		);
		if (kb.source_path) lines.push(`    source: ${kb.source_path}`);
		if (embedding) {
			lines.push(
				`    embedding: indexed=${embedding.indexed_model ?? "unrecorded"} · active=${embedding.active_model} · decoration=${embedding.active_decoration}`,
			);
			const requiresCompatibleVectors = kb.chunk_count > 0 && (kb.status === "ready" || kb.status === "stale");
			if (requiresCompatibleVectors && !embedding.compatibility.compatible) {
				lines.push(`    ⚠️ vectors: ${embedding.detail}`);
			}
		} else {
			lines.push(`    embedding: indexed=${kb.embedding_model ?? "unrecorded"} · active=unavailable`);
		}
		if (!diagnostic) continue;
		if (diagnostic.job) {
			const jobAge = Math.round((now - diagnostic.job.last_progress_at) / 1_000);
			const progress = [
				`${diagnostic.job.processed_files} files`,
				`${diagnostic.job.processed_chunks} chunks`,
				diagnostic.job.skipped_total > 0 ? `${diagnostic.job.skipped_total} skipped` : "",
				diagnostic.job.added_chunks > 0 ? `+${diagnostic.job.added_chunks}` : "",
				diagnostic.job.removed_chunks > 0 ? `-${diagnostic.job.removed_chunks}` : "",
				diagnostic.job.unchanged_chunks > 0 ? `=${diagnostic.job.unchanged_chunks}` : "",
			]
				.filter(Boolean)
				.join(", ");
			lines.push(
				`    job: ${diagnostic.job.status}/${diagnostic.job.phase} — ${progress || "no processed items yet"} — last progress ${jobAge}s ago`,
			);
			if (diagnostic.job.message) lines.push(`    last: ${diagnostic.job.message}`);
			if (diagnostic.job.error_message) lines.push(`    error: ${diagnostic.job.error_message}`);
		}
		lines.push(
			`    coverage: ${diagnostic.coverage_percent}% (${diagnostic.indexed_files}/${diagnostic.total_source_files} files)`,
		);
		if (diagnostic.stale_files.length > 0)
			lines.push(`    ⚠️ stale: ${diagnostic.stale_files.length} files modified since last index`);
		if (diagnostic.orphan_files.length > 0)
			lines.push(`    ⚠️ orphans: ${diagnostic.orphan_files.length} chunks reference deleted files`);
		if (diagnostic.stuck_indexing)
			lines.push(
				`    ⚠️ indexing appears stuck for ${Math.round(diagnostic.last_progress_age_ms / 60_000)}m; remove and rebuild if no pi process is actively indexing it`,
			);
		if (diagnostic.skipped_files.total > 0)
			lines.push(
				`    skipped: ${diagnostic.skipped_files.total} files (${Object.entries(diagnostic.skipped_files.by_reason)
					.filter(([, count]) => count > 0)
					.map(([reason, count]) => `${reason}: ${count}`)
					.join(", ")})`,
			);
	}

	const totalStale = snapshot.diagnostics.reduce((count, diagnostic) => count + diagnostic.stale_files.length, 0);
	const totalOrphans = snapshot.diagnostics.reduce((count, diagnostic) => count + diagnostic.orphan_files.length, 0);
	const totalStuck = snapshot.diagnostics.filter((diagnostic) => diagnostic.stuck_indexing).length;
	const totalIndexing = snapshot.knowledge_bases.filter(
		(kb) => kb.status === "indexing" && !diagnosticsByKb.get(kb.id)?.stuck_indexing,
	).length;
	const totalErrors = snapshot.knowledge_bases.filter((kb) => kb.status === "error").length;
	const totalEmbedding =
		snapshot.knowledge_bases.reduce((count, kb) => {
			if (kb.chunk_count === 0 || (kb.status !== "ready" && kb.status !== "stale")) return count;
			const embedding = embeddingByKb.get(kb.id);
			return count + (embedding && !embedding.compatibility.compatible ? 1 : 0);
		}, 0) + (snapshot.embedding_error ? 1 : 0);
	if (
		totalStale === 0 &&
		totalOrphans === 0 &&
		totalStuck === 0 &&
		totalIndexing === 0 &&
		totalErrors === 0 &&
		totalEmbedding === 0 &&
		snapshot.knowledge_bases.length > 0
	) {
		lines.push("", "Health: ✓ all indexes up to date and embedding-compatible");
	} else if (
		totalStale > 0 ||
		totalOrphans > 0 ||
		totalStuck > 0 ||
		totalIndexing > 0 ||
		totalErrors > 0 ||
		totalEmbedding > 0
	) {
		lines.push(
			"",
			`Health: ⚠️ ${totalStale} stale, ${totalOrphans} orphans, ${totalStuck} stuck indexing, ${totalIndexing} indexing, ${totalErrors} errors, ${totalEmbedding} embedding issues — run knowledge_update, correct embedding configuration, or rebuild affected KBs`,
		);
	}
	return lines.join("\n");
}
