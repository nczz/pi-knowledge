import { type Dirent, existsSync, type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const snapshots = new Map<string, Map<string, string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;
const POLL_MS = 2000;

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

function scanSnapshot(dirPath: string): Map<string, string> {
	const snapshot = new Map<string, string>();

	function scan(dir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			try {
				const stat = statSync(fullPath);
				if (entry.isDirectory()) {
					scan(fullPath);
				} else if (entry.isFile()) {
					snapshot.set(fullPath, `${stat.mtimeMs}:${stat.size}`);
				}
			} catch {
				/* file disappeared or is unreadable */
			}
		}
	}

	if (existsSync(dirPath)) scan(dirPath);
	return snapshot;
}

function snapshotsDiffer(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return true;
	for (const [path, value] of a) {
		if (b.get(path) !== value) return true;
	}
	return false;
}

function startPoller(kbId: string, dirPath: string, onUpdate: (kbId: string) => void): void {
	snapshots.set(kbId, scanSnapshot(dirPath));
	pollers.set(
		kbId,
		setInterval(() => {
			const previous = snapshots.get(kbId) ?? new Map<string, string>();
			const next = scanSnapshot(dirPath);
			if (snapshotsDiffer(previous, next)) {
				snapshots.set(kbId, next);
				scheduleUpdate(kbId, onUpdate);
			}
		}, POLL_MS),
	);
}

export function startWatcher(kbId: string, dirPath: string, onUpdate: (kbId: string) => void): void {
	stopWatcher(kbId);
	startPoller(kbId, dirPath, onUpdate);
	try {
		const watcher = watch(dirPath, { recursive: true }, () => {
			snapshots.set(kbId, scanSnapshot(dirPath));
			scheduleUpdate(kbId, onUpdate);
		});
		watcher.on("error", () => {
			watchers.get(kbId)?.close();
			watchers.delete(kbId);
		});
		watchers.set(kbId, watcher);
	} catch {
		/* polling fallback remains active */
	}
}

export function stopWatcher(kbId: string): void {
	watchers.get(kbId)?.close();
	watchers.delete(kbId);
	const poller = pollers.get(kbId);
	if (poller) {
		clearInterval(poller);
		pollers.delete(kbId);
	}
	snapshots.delete(kbId);
	const t = debounceTimers.get(kbId);
	if (t) {
		clearTimeout(t);
		debounceTimers.delete(kbId);
	}
}

export function stopAllWatchers(): void {
	const ids = new Set([...watchers.keys(), ...pollers.keys()]);
	for (const id of ids) stopWatcher(id);
}

export function getActiveWatcherCount(): number {
	return new Set([...watchers.keys(), ...pollers.keys()]).size;
}
