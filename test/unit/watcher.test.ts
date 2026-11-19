import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWatcher, stopAllWatchers } from "../../src/watcher/file-watcher.ts";

let testDir: string;

describe("file watcher exclusions", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		testDir = mkdtempSync(join(tmpdir(), "pk-test-watcher-"));
		mkdirSync(join(testDir, "node_modules"), { recursive: true });
		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 1;");
		writeFileSync(join(testDir, "node_modules", "pkg.js"), "export const IgnoredVendor = 1;");
	});

	afterEach(() => {
		stopAllWatchers();
		vi.useRealTimers();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("does not trigger updates for suggested-excluded files", async () => {
		const updates: string[] = [];
		await startWatcher("kb", testDir, (kbId) => updates.push(kbId));

		writeFileSync(join(testDir, "node_modules", "pkg.js"), "export const IgnoredVendor = 2;");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updates).toEqual([]);

		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 200; // changed");
		await vi.waitFor(() => expect(updates).toEqual(["kb"]), { timeout: 5_000, interval: 100 });
	});
	it("detects files created while the initial polling baseline is still scanning", async () => {
		const updates: string[] = [];
		const initialScan = startWatcher("baseline-race", testDir, (kbId) => updates.push(kbId));
		writeFileSync(join(testDir, "created-during-baseline.txt"), "new source");

		await initialScan;
		await vi.advanceTimersByTimeAsync(2_100);

		expect(updates).toEqual(["baseline-race"]);
	});
});
