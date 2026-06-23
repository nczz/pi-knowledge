import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
	let resolveInitializeStarted: (() => void) | undefined;
	let resolveInitialize: (() => void) | undefined;
	const state = {
		initializeStarted: Promise.resolve(),
		initializeFinished: Promise.resolve(),
		resolveInitializeStarted: () => resolveInitializeStarted?.(),
		resolveInitialize: () => resolveInitialize?.(),
		initializeCount: 0,
		disposeCount: 0,
		stopWatcherCount: 0,
		reset(): void {
			state.initializeStarted = new Promise<void>((resolve) => {
				resolveInitializeStarted = resolve;
			});
			state.initializeFinished = new Promise<void>((resolve) => {
				resolveInitialize = resolve;
			});
			state.initializeCount = 0;
			state.disposeCount = 0;
			state.stopWatcherCount = 0;
		},
	};
	state.reset();
	return state;
});

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {
			lifecycle.initializeCount += 1;
			lifecycle.resolveInitializeStarted();
			await lifecycle.initializeFinished;
		}

		list(): [] {
			return [];
		}

		async dispose(): Promise<void> {
			lifecycle.disposeCount += 1;
		}
	},
}));

vi.mock("../../src/storage/sqlite.ts", () => ({
	getDefaultKnowledgeDir(): string {
		return "/tmp/pi-knowledge-extension-lifecycle";
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount(): number {
		return 0;
	},
	startWatcher(): void {},
	stopAllWatchers(): void {
		lifecycle.stopWatcherCount += 1;
	},
}));

describe("extension lifecycle", () => {
	beforeEach(() => {
		vi.resetModules();
		lifecycle.reset();
	});

	it("waits for in-flight startup before shutdown cleanup", async () => {
		const { default: extension } = await import("../../index.ts");
		const handlers: Record<string, Array<(event?: unknown, ctx?: unknown) => unknown>> = {};
		const pi = {
			on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			registerTool(): void {},
		} as Parameters<typeof extension>[0];

		extension(pi);
		const startHandler = handlers.session_start?.[0];
		const shutdownHandler = handlers.session_shutdown?.[0];
		if (!startHandler || !shutdownHandler) throw new Error("Lifecycle handlers were not registered");

		const start = Promise.resolve(startHandler());
		await lifecycle.initializeStarted;
		const shutdown = Promise.resolve(shutdownHandler());

		lifecycle.resolveInitialize();
		await Promise.all([start, shutdown]);

		expect(lifecycle.initializeCount).toBe(1);
		expect(lifecycle.stopWatcherCount).toBe(1);
		expect(lifecycle.disposeCount).toBe(1);
	});
});
