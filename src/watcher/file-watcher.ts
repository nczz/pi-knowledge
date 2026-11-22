import { existsSync, type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createSkippedScanStats, iterateScannableFileVisitsAsync, type ScanOptions } from "../indexer/chunker.ts";

const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const snapshots = new Map<string, Map<string, string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const scanRuns = new Map<string, Promise<void>>();
const scanControllers = new Map<string, AbortController>();
const scanGenerations = new Map<string, object>();
const scanRequested = new Set<string>();
const eventPaths = new Map<string, Set<string | undefined>>();
const baselineRootStamps = new Map<string, string | undefined>();
let scanPermit = Promise.resolve();
const generations = new Map<string, object>();
const DEBOUNCE_MS = 2000;
const POLL_MS = 2000;
const SCAN_YIELD_ENTRIES = 50;
const MAX_EVENT_PATHS = 1_024;

function scheduleUpdate(kbId: string, onUpdate: (kbId: string) => void): void {
	const existing = debounceTimers.get(kbId);
	if (existing) clearTimeout(existing);
	debounceTimers.set(
		kbId,
		setTimeout(() => {
			debounceTimers.delete(kbId);
			onUpdate(kbId);
		}, DEBOUNCE_MS),
	);
}
function rootStamp(path: string): string | undefined {
	try {
		const info = statSync(path);
		return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
	} catch {
		return undefined;
	}
}

async function scanSnapshot(
	dirPath: string,
	options: ScanOptions = {},
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	if (!existsSync(dirPath)) return snapshot;
	if (signal?.aborted) return snapshot;
	const skipped = createSkippedScanStats();
	let processed = 0;
	for await (const file of iterateScannableFileVisitsAsync(dirPath, skipped, options, signal)) {
		if (signal?.aborted) return snapshot;
		if (file) {
			snapshot.set(file.path, `${file.mtimeMs}:${file.ctimeMs}:${file.size}:${file.inode}`);
		}
		processed++;
		if (processed % SCAN_YIELD_ENTRIES === 0) {
			await yieldToEventLoop();
			if (signal?.aborted) return snapshot;
		}
	}
	return snapshot;
}
async function withScanPermit<T>(operation: () => Promise<T>): Promise<T> {
	const previous = scanPermit;
	let release = (): void => {};
	scanPermit = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous.catch(() => {});
	try {
		return await operation();
	} finally {
		release();
	}
}

function snapshotsDiffer(left: Map<string, string>, right: Map<string, string>): boolean {
	if (left.size !== right.size) return true;
	for (const [path, value] of left) {
		if (right.get(path) !== value) return true;
	}
	return false;
}

function eventTouchesSnapshot(path: string | undefined, snapshot: Map<string, string> | undefined): boolean {
	if (path === undefined) return true;
	if (!snapshot) return false;
	if (snapshot.has(path)) return true;
	const prefix = `${path}/`;
	for (const candidate of snapshot.keys()) {
		if (candidate.startsWith(prefix)) return true;
	}
	return false;
}

function requestScan(
	kbId: string,
	generation: object,
	dirPath: string,
	onUpdate: (kbId: string) => void,
	options: ScanOptions,
	followUpIfActive = true,
): Promise<void> {
	if (generations.get(kbId) !== generation) return Promise.resolve();
	const existing = scanRuns.get(kbId);
	if (existing) {
		if (scanGenerations.get(kbId) === generation) {
			if (followUpIfActive) scanRequested.add(kbId);
			return existing;
		}
		return existing.then(
			() => requestScan(kbId, generation, dirPath, onUpdate, options, followUpIfActive),
			() => requestScan(kbId, generation, dirPath, onUpdate, options, followUpIfActive),
		);
	}
	const controller = new AbortController();
	const run = (async () => {
		do {
			if (generations.get(kbId) !== generation) return;
			scanRequested.delete(kbId);
			const next = await withScanPermit(() => scanSnapshot(dirPath, options, controller.signal));
			if (controller.signal.aborted) return;
			if (generations.get(kbId) !== generation) return;
			const previous = snapshots.get(kbId);
			snapshots.set(kbId, next);
			const baselineStamp = baselineRootStamps.get(kbId);
			baselineRootStamps.delete(kbId);
			const baselineChanged =
				previous === undefined && baselineStamp !== undefined && rootStamp(dirPath) !== baselineStamp;
			const events = eventPaths.get(kbId);
			eventPaths.delete(kbId);
			const eventRelevant =
				events !== undefined &&
				[...events].some((path) => eventTouchesSnapshot(path, previous) || eventTouchesSnapshot(path, next));
			if (baselineChanged || (previous && snapshotsDiffer(previous, next)) || eventRelevant) {
				scheduleUpdate(kbId, onUpdate);
			}
		} while (scanRequested.has(kbId));
	})().finally(() => {
		if (scanRuns.get(kbId) === run) {
			scanRuns.delete(kbId);
			scanControllers.delete(kbId);
			scanGenerations.delete(kbId);
		}
	});
	scanRuns.set(kbId, run);
	scanControllers.set(kbId, controller);
	scanGenerations.set(kbId, generation);
	void run.catch(() => {
		/* transient scan errors are retried by the polling fallback */
	});
	return run;
}

function startPoller(
	kbId: string,
	generation: object,
	dirPath: string,
	onUpdate: (kbId: string) => void,
	options: ScanOptions = {},
): Promise<void> {
	const initialScan = requestScan(kbId, generation, dirPath, onUpdate, options, false);
	pollers.set(
		kbId,
		setInterval(() => requestScan(kbId, generation, dirPath, onUpdate, options, false), POLL_MS),
	);
	return initialScan;
}

export function startWatcher(
	kbId: string,
	dirPath: string,
	onUpdate: (kbId: string) => void,
	options: ScanOptions = {},
): Promise<void> {
	stopWatcher(kbId);
	baselineRootStamps.set(kbId, rootStamp(dirPath));
	const generation = {};
	generations.set(kbId, generation);
	const initialScan = startPoller(kbId, generation, dirPath, onUpdate, options);
	try {
		const eventRoot = realpathSync.native(dirPath);
		const watcher = watch(dirPath, { recursive: true }, (_event, filename) => {
			if (generations.get(kbId) !== generation) return;
			const paths = eventPaths.get(kbId) ?? new Set<string | undefined>();
			if (!paths.has(undefined)) {
				if (filename === null || paths.size >= MAX_EVENT_PATHS) {
					paths.clear();
					paths.add(undefined);
				} else {
					paths.add(resolve(eventRoot, filename.toString()));
				}
			}
			eventPaths.set(kbId, paths);
			void requestScan(kbId, generation, dirPath, onUpdate, options);
		});
		watcher.on("error", () => {
			if (watchers.get(kbId) !== watcher || generations.get(kbId) !== generation) return;
			watcher.close();
			watchers.delete(kbId);
		});
		watchers.set(kbId, watcher);
	} catch {
		/* polling fallback remains active */
	}
	return initialScan;
}

export function stopWatcher(kbId: string): void {
	generations.delete(kbId);
	scanControllers.get(kbId)?.abort();
	watchers.get(kbId)?.close();
	watchers.delete(kbId);
	const poller = pollers.get(kbId);
	if (poller) {
		clearInterval(poller);
		pollers.delete(kbId);
	}
	scanRequested.delete(kbId);
	snapshots.delete(kbId);
	const timer = debounceTimers.get(kbId);
	if (timer) {
		clearTimeout(timer);
		debounceTimers.delete(kbId);
	}
	eventPaths.delete(kbId);
	baselineRootStamps.delete(kbId);
}

export function stopAllWatchers(): void {
	const ids = new Set([...watchers.keys(), ...pollers.keys(), ...scanRuns.keys()]);
	for (const id of ids) stopWatcher(id);
}

export async function stopAllWatchersAndWait(): Promise<void> {
	stopAllWatchers();
	await Promise.allSettled([...scanRuns.values()]);
}

export function getActiveWatcherScanCount(): number {
	return scanRuns.size;
}

export function getActiveWatcherCount(): number {
	return new Set([...watchers.keys(), ...pollers.keys()]).size;
}
