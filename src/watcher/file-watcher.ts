import { watch, type FSWatcher } from "node:fs";

const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;

export function startWatcher(kbId: string, dirPath: string, onUpdate: (kbId: string) => void): void {
	stopWatcher(kbId);
	try {
		const watcher = watch(dirPath, { recursive: true }, () => {
			const existing = debounceTimers.get(kbId);
			if (existing) clearTimeout(existing);
			debounceTimers.set(kbId, setTimeout(() => {
				debounceTimers.delete(kbId);
				onUpdate(kbId);
			}, DEBOUNCE_MS));
		});
		watcher.on("error", () => stopWatcher(kbId));
		watchers.set(kbId, watcher);
	} catch { /* fail silently if recursive watch not supported */ }
}

export function stopWatcher(kbId: string): void {
	watchers.get(kbId)?.close();
	watchers.delete(kbId);
	const t = debounceTimers.get(kbId);
	if (t) { clearTimeout(t); debounceTimers.delete(kbId); }
}

export function stopAllWatchers(): void {
	for (const [id] of watchers) stopWatcher(id);
}

export function getActiveWatcherCount(): number {
	return watchers.size;
}
