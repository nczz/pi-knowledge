import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	watcherCallback: undefined as ((kbId: string) => void) | undefined,
	updates: [] as Array<ReturnType<typeof Promise.withResolvers<{ added: number; removed: number; unchanged: number }>>>,
	updateCalls: 0,
	rejectNextUpdate: false,
}));

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {}

		list(): unknown[] {
			return [
				{
					id: "watched-kb",
					name: "Watched",
					source_type: "directory",
					source_path: "/tmp/watched",
					source_options: null,
				},
			];
		}

		update(): Promise<{ added: number; removed: number; unchanged: number }> {
			state.updateCalls++;
			if (state.rejectNextUpdate) {
				state.rejectNextUpdate = false;
				return Promise.reject(new Error("Mutation for another knowledge base is already running"));
			}
			const deferred = Promise.withResolvers<{ added: number; removed: number; unchanged: number }>();
			state.updates.push(deferred);
			return deferred.promise;
		}

		async dispose(): Promise<void> {}
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount(): number {
		return state.watcherCallback ? 1 : 0;
	},
	getActiveWatcherScanCount(): number {
		return 0;
	},
	startWatcher(_kbId: string, _path: string, callback: (kbId: string) => void): void {
		state.watcherCallback = callback;
	},
	stopWatcher(): void {},
	stopAllWatchers(): void {
		state.watcherCallback = undefined;
	},
	async stopAllWatchersAndWait(): Promise<void> {
		state.watcherCallback = undefined;
	},
}));

vi.mock("../../src/model-worker-client.ts", () => ({
	configureModelWorkerNodePath(): string {
		return process.execPath;
	},
	shutdownModelWorker(): void {},
}));

beforeEach(() => {
	state.watcherCallback = undefined;
	state.updates = [];
	state.updateCalls = 0;
	state.rejectNextUpdate = false;
});

describe("daemon watcher update coordination", () => {
	it("runs one follow-up update when a watcher event arrives during an active update", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(true);
		if (!state.watcherCallback) throw new Error("Watcher callback was not registered");

		state.watcherCallback("watched-kb");
		state.watcherCallback("watched-kb");
		expect(state.updates).toHaveLength(1);

		state.updates[0]?.resolve({ added: 1, removed: 0, unchanged: 0 });
		await vi.waitFor(() => expect(state.updates).toHaveLength(2));
		state.updates[1]?.resolve({ added: 1, removed: 0, unchanged: 0 });
		await service.dispose();
	});

	it("runs a follow-up when a watcher event overlaps a manual update", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(true);
		if (!state.watcherCallback) throw new Error("Watcher callback was not registered");
		const controller = new AbortController();

		const manual = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "manual", signal: controller.signal, onProgress: () => {} },
		);
		state.watcherCallback("watched-kb");
		expect(state.updates).toHaveLength(1);

		state.updates[0]?.resolve({ added: 1, removed: 0, unchanged: 0 });
		await manual;
		await vi.waitFor(() => expect(state.updates).toHaveLength(2));
		state.updates[1]?.resolve({ added: 1, removed: 0, unchanged: 0 });
		await service.dispose();
	});

	it("retries a watcher update rejected by another global mutation", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(true);
		if (!state.watcherCallback) throw new Error("Watcher callback was not registered");
		state.rejectNextUpdate = true;

		state.watcherCallback("watched-kb");
		await vi.waitFor(() => expect(state.updateCalls).toBe(2));
		state.updates[0]?.resolve({ added: 1, removed: 0, unchanged: 0 });
		await service.dispose();
	});

	it("does not attach a new subscriber to an update whose last subscriber cancelled", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(false);
		const firstController = new AbortController();
		const first = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "cancelled", signal: firstController.signal, onProgress: () => {} },
		);
		firstController.abort();
		await expect(first).rejects.toThrow("Cancelled");

		const second = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "replacement", signal: new AbortController().signal, onProgress: () => {} },
		);
		expect(state.updates).toHaveLength(1);
		state.updates[0]?.resolve({ added: 0, removed: 0, unchanged: 1 });
		await vi.waitFor(() => expect(state.updates).toHaveLength(2));
		state.updates[1]?.resolve({ added: 1, removed: 0, unchanged: 0 });

		await expect(second).resolves.toEqual({ added: 1, removed: 0, unchanged: 0 });
		await service.dispose();
	});

	it("cancels a replacement subscriber while the closing update is still settling", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(false);
		const firstController = new AbortController();
		const first = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "first-cancelled", signal: firstController.signal, onProgress: () => {} },
		);
		firstController.abort();
		await expect(first).rejects.toThrow("Cancelled");

		const replacementController = new AbortController();
		const replacement = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "replacement-cancelled", signal: replacementController.signal, onProgress: () => {} },
		);
		replacementController.abort();
		await expect(replacement).rejects.toThrow("Cancelled");
		state.updates[0]?.resolve({ added: 0, removed: 0, unchanged: 1 });
		await state.updates[0]?.promise;
		expect(state.updates).toHaveLength(1);
		await service.dispose();
	});
	it("keeps a coalesced update running when one of two subscribers cancels", async () => {
		const { KnowledgeDaemonService } = await import("../../src/daemon/service.ts");
		const service = new KnowledgeDaemonService(
			{
				name: "default",
				id: "test-profile",
				storageDir: "/tmp/storage",
				runtimeDir: "/tmp/storage/.runtime",
				profileRoot: "/tmp",
				registryPath: "/tmp/profiles.json",
			},
			() => {},
		);
		await service.initialize(false);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "first-subscriber", signal: firstController.signal, onProgress: () => {} },
		);
		const second = service.dispatch(
			"update",
			{ target: "watched-kb" },
			{ requestId: "second-subscriber", signal: secondController.signal, onProgress: () => {} },
		);
		firstController.abort();
		await expect(first).rejects.toThrow("Cancelled");
		expect(state.updateCalls).toBe(1);

		state.updates[0]?.resolve({ added: 1, removed: 0, unchanged: 2 });
		await expect(second).resolves.toEqual({ added: 1, removed: 0, unchanged: 2 });
		expect(state.updateCalls).toBe(1);
		await service.dispose();
	});
});
