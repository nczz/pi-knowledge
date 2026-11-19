import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;

const watchState = vi.hoisted(() => ({
	callbacks: [] as WatchCallback[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: (_path: unknown, _options: unknown, callback: WatchCallback) => {
			watchState.callbacks.push(callback);
			return {
				close(): void {},
				on(): unknown {
					return this;
				},
			};
		},
	};
});

const tempDirs: string[] = [];

afterEach(async () => {
	const { stopAllWatchersAndWait } = await import("../../src/watcher/file-watcher.ts");
	await stopAllWatchersAndWait();
	vi.useRealTimers();
	watchState.callbacks = [];
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("watcher baseline race", () => {
	it("preserves a relevant native event delivered during the initial snapshot", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "pk-watcher-race-"));
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "src.ts"), "export const InitialValue = 1;");
		const { startWatcher } = await import("../../src/watcher/file-watcher.ts");
		const updates: string[] = [];

		const initialScan = startWatcher("race", root, (kbId) => updates.push(kbId));
		writeFileSync(join(root, "src.ts"), "export const InitialValue = 200; // changed");
		const callback = watchState.callbacks.at(-1);
		if (!callback) throw new Error("Native watcher callback was not registered");
		callback("change", "src.ts");
		await initialScan;
		await vi.advanceTimersByTimeAsync(2_100);

		expect(updates).toEqual(["race"]);
	});

	it("ignores native callbacks from a replaced watcher generation", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "pk-watcher-generation-"));
		tempDirs.push(root);
		writeFileSync(join(root, "src.ts"), "export const value = 1;");
		const { startWatcher } = await import("../../src/watcher/file-watcher.ts");
		const updates: string[] = [];

		await startWatcher("generation", root, (kbId) => updates.push(`old:${kbId}`));
		const staleCallback = watchState.callbacks.at(-1);
		await startWatcher("generation", root, (kbId) => updates.push(`new:${kbId}`));
		if (!staleCallback) throw new Error("Old native watcher callback was not registered");
		staleCallback("change", "src.ts");
		await vi.advanceTimersByTimeAsync(2_100);

		expect(updates).toEqual([]);
	});
});
