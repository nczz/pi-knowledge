import { join } from "node:path";
import type { KnowledgeProfile } from "./profiles.ts";
import { writeJsonAtomic } from "./secure-files.ts";
import type { KnowledgeBase } from "./storage/sqlite.ts";
import { isObjectRecord } from "./type-guards.ts";

export interface CoverageSnapshotKnowledgeBase {
	name: string;
	source_type: KnowledgeBase["source_type"];
	source_path: string | null;
	exclude_paths: string[];
	file_count: number;
	chunk_count: number;
	updated_at: number;
	status: KnowledgeBase["status"];
}

export interface CoverageSnapshot {
	schema_version: 1;
	generated_at: number;
	profile: string;
	kbs: CoverageSnapshotKnowledgeBase[];
}

export type CoverageSnapshotWriter = (path: string, value: unknown) => void;

export function coverageSnapshotPath(profile: KnowledgeProfile): string {
	return join(profile.storageDir, "coverage.json");
}

function excludePaths(sourceOptions: string | null): string[] {
	if (!sourceOptions) return [];
	try {
		const parsed: unknown = JSON.parse(sourceOptions);
		if (!isObjectRecord(parsed) || !Array.isArray(parsed.exclude_paths)) return [];
		return parsed.exclude_paths.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeExcludePaths(paths: string[]): string[] {
	return paths.map((path) => path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "")).filter(Boolean);
}

export function buildCoverageSnapshot(
	profile: KnowledgeProfile,
	knowledgeBases: readonly KnowledgeBase[],
	generatedAt = Date.now(),
): CoverageSnapshot {
	return {
		schema_version: 1,
		generated_at: generatedAt,
		profile: profile.name,
		kbs: [...knowledgeBases]
			.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
			.map((kb) => ({
				name: kb.name,
				source_type: kb.source_type,
				source_path: kb.source_path,
				exclude_paths: normalizeExcludePaths(excludePaths(kb.source_options)),
				file_count: kb.file_count,
				chunk_count: kb.chunk_count,
				updated_at: kb.indexed_at,
				status: kb.status,
			})),
	};
}

export function writeCoverageSnapshot(
	profile: KnowledgeProfile,
	knowledgeBases: readonly KnowledgeBase[],
	writer: CoverageSnapshotWriter = writeJsonAtomic,
): void {
	writer(coverageSnapshotPath(profile), buildCoverageSnapshot(profile, knowledgeBases));
}

export function boundedCoverageSnapshotError(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: "unknown";
	return `coverage snapshot write failed (${code})`;
}
