import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCoverageSnapshot, coverageSnapshotPath, writeCoverageSnapshot } from "../../src/coverage-snapshot.ts";
import type { KnowledgeProfile } from "../../src/profiles.ts";
import type { KnowledgeBase } from "../../src/storage/sqlite.ts";

const tempDirs: string[] = [];

function makeProfile(): KnowledgeProfile {
	const storageDir = mkdtempSync(join(tmpdir(), "pk-coverage-"));
	tempDirs.push(storageDir);
	return {
		name: "default",
		id: "coverage-profile",
		storageDir,
		runtimeDir: join(storageDir, ".runtime"),
		profileRoot: storageDir,
		registryPath: join(storageDir, "profiles.json"),
	};
}

function knowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
	return {
		id: "kb-1",
		name: "Repo",
		description: null,
		source_path: "/work/repo",
		source_type: "directory",
		source_options: JSON.stringify({ exclude_paths: ["dist", "coverage"] }),
		created_at: 100,
		updated_at: 200,
		chunk_count: 12,
		file_count: 3,
		embedding_model: "test",
		embedding_signature: null,
		embedding_dimension: null,
		status: "ready",
		...overrides,
	};
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coverage snapshot", () => {
	it("builds the versioned profile scope without per-file data", () => {
		const profile = makeProfile();
		const snapshot = buildCoverageSnapshot(
			profile,
			[
				knowledgeBase({ id: "z", name: "Zed", source_type: "text", source_path: null, source_options: null }),
				knowledgeBase({ id: "a", name: "Alpha" }),
			],
			1234,
		);

		expect(snapshot).toEqual({
			schema_version: 1,
			generated_at: 1234,
			profile: "default",
			kbs: [
				{
					name: "Alpha",
					source_type: "directory",
					source_path: "/work/repo",
					exclude_paths: ["dist", "coverage"],
					file_count: 3,
					chunk_count: 12,
					updated_at: 200,
					status: "ready",
				},
				{
					name: "Zed",
					source_type: "text",
					source_path: null,
					exclude_paths: [],
					file_count: 3,
					chunk_count: 12,
					updated_at: 200,
					status: "ready",
				},
			],
		});
	});

	it("uses locale-independent ordering and publishes normalized effective excludes", () => {
		const snapshot = buildCoverageSnapshot(
			makeProfile(),
			[
				knowledgeBase({
					id: "unicode",
					name: "ä-docs",
					source_options: JSON.stringify({ exclude_paths: ["/archive/", "build\\cache", "///"] }),
				}),
				knowledgeBase({ id: "ascii", name: "zoo", source_options: null }),
			],
			1234,
		);

		expect(snapshot.kbs.map((kb) => kb.name)).toEqual(["zoo", "ä-docs"]);
		expect(snapshot.kbs[1]?.exclude_paths).toEqual(["archive", "build/cache"]);
	});

	it("atomically rewrites an owner-only file and preserves an empty clear snapshot", () => {
		const profile = makeProfile();
		writeCoverageSnapshot(profile, [knowledgeBase()]);
		const path = coverageSnapshotPath(profile);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);

		chmodSync(path, 0o644);
		writeCoverageSnapshot(profile, []);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { schema_version: number; kbs: unknown[] };
		expect(parsed.schema_version).toBe(1);
		expect(parsed.kbs).toEqual([]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
	});
});
