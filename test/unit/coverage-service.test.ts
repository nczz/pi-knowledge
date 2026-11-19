import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	knowledgeBases: [
		{
			id: "kb-1",
			name: "Repo",
			description: null,
			source_path: "/work/repo",
			source_type: "directory" as const,
			source_options: null,
			created_at: 1,
			updated_at: 2,
			chunk_count: 3,
			file_count: 1,
			embedding_model: "test",
			embedding_signature: null,
			embedding_dimension: null,
			status: "ready" as const,
		},
	],
	clearCalls: 0,
}));

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {}

		list(): typeof state.knowledgeBases {
			return state.knowledgeBases;
		}

		clear(): void {
			state.clearCalls++;
			state.knowledgeBases = [];
		}

		async statusSnapshotAsync(): Promise<{
			knowledge_bases: [];
			diagnostics: [];
			embeddings: [];
		}> {
			return { knowledge_bases: [], diagnostics: [], embeddings: [] };
		}

		async dispose(): Promise<void> {}
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount: () => 0,
	getActiveWatcherScanCount: () => 0,
	startWatcher: () => {},
	stopWatcher: () => {},
	stopAllWatchers: () => {},
	stopAllWatchersAndWait: async () => {},
}));

vi.mock("../../src/model-worker-client.ts", () => ({
	configureModelWorkerNodePath: () => process.execPath,
	shutdownModelWorker: () => {},
}));

beforeEach(() => {
	state.knowledgeBases = [
		{
			id: "kb-1",
			name: "Repo",
			description: null,
			source_path: "/work/repo",
			source_type: "directory",
			source_options: null,
			created_at: 1,
			updated_at: 2,
			chunk_count: 3,
			file_count: 1,
			embedding_model: "test",
			embedding_signature: null,
			embedding_dimension: null,
			status: "ready",
		},
	];
	state.clearCalls = 0;
});

describe("daemon coverage snapshot failure semantics", () => {
	it("reconciles at startup and does not roll back a successful mutation when rewriting fails", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const writes: unknown[] = [];
		let fail = false;
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "coverage-service",
				storageDir: "/tmp/coverage-service",
				runtimeDir: "/tmp/coverage-service/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			(_path, value) => {
				if (fail) throw Object.assign(new Error("/private/secret/path"), { code: "EACCES" });
				writes.push(value);
			},
		);
		await service.initialize(false);
		expect(writes).toHaveLength(1);
		fail = true;
		await expect(
			service.dispatch("clear", {}, { requestId: "clear", signal: new AbortController().signal, onProgress: () => {} }),
		).resolves.toBeUndefined();
		expect(state.clearCalls).toBe(1);
		const status = await service.dispatch(
			"status",
			{},
			{ requestId: "status", signal: new AbortController().signal, onProgress: () => {} },
		);
		expect(status).toMatchObject({ snapshot_error: "coverage snapshot write failed (EACCES)" });
		expect(JSON.stringify(status)).not.toContain("/private/secret/path");
		await service.dispose();
	});
});
