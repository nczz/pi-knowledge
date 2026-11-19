import { randomUUID } from "node:crypto";
import {
	boundedCoverageSnapshotError,
	type CoverageSnapshotWriter,
	writeCoverageSnapshot,
} from "../coverage-snapshot.ts";
import type {
	AddOptions,
	DoctorReport,
	IndexPlan,
	KnowledgeStatusSnapshot,
	SearchOptions,
	SearchResponse,
	SymbolSearchOptions,
	SymbolSearchResponse,
} from "../engine.ts";
import { KnowledgeEngine } from "../engine.ts";
import type { FilesystemAccessPolicy } from "../filesystem-access.ts";
import { configureModelWorkerNodePath, shutdownModelWorker } from "../model-worker-client.ts";
import { configureDaemonNodePath, resolveDaemonNodePath } from "../node-runtime.ts";
import type { KnowledgeProfile } from "../profiles.ts";
import type { KnowledgeBase } from "../storage/sqlite.ts";
import { isObjectRecord } from "../type-guards.ts";
import {
	getActiveWatcherCount,
	getActiveWatcherScanCount,
	startWatcher,
	stopAllWatchers,
	stopAllWatchersAndWait,
	stopWatcher,
} from "../watcher/file-watcher.ts";
import type { DaemonMethod } from "./protocol.ts";

const MAX_RPC_KNOWLEDGE_BASES = 1_000;
const MAX_RPC_DIAGNOSTIC_PATHS = 2_000;
const MAX_RPC_OPTION_ITEMS = 128;
const MAX_RPC_OPTION_PATH_BYTES = 4_096;
const MAX_RPC_OPTIONS_BYTES = 64 * 1_024;
const SEARCH_MODES = [
	"auto",
	"fast",
	"semantic",
	"hybrid",
	"semantic_hybrid",
	"deep",
	"adaptive",
	"code",
	"config",
	"docs",
	"errors",
	"decision",
] as const;
const SEARCH_PROFILES = [
	"auto",
	"balanced",
	"low_token",
	"precision",
	"recall",
	"long_context",
	"code",
	"docs",
] as const;
const DIVERSITY_MODES = ["off", "balanced", "strong"] as const;
const SYMBOL_KINDS = [
	"function",
	"class",
	"interface",
	"type",
	"variable",
	"heading",
	"config_key",
	"env_var",
	"route",
] as const;
const RPC_STRING_LIMITS: Readonly<Record<string, number>> = {
	name: 512,
	target: 512,
	query: 64 * 1_024,
	input: 32 * 1_024,
	output: 32 * 1_024,
	source: 10 * 1_024 * 1_024 + 32 * 1_024,
	kb_id: 512,
	file_type: 1_024,
	path_pattern: MAX_RPC_OPTION_PATH_BYTES,
	file_pattern: MAX_RPC_OPTION_PATH_BYTES,
};

export interface DaemonServiceStatus {
	profile: { name: string; id: string };
	storage_path: string;
	watch_count: number;
	snapshot_error?: string;
	snapshot: KnowledgeStatusSnapshot;
}

export interface DaemonServiceDispatchContext {
	requestId: string;
	signal: AbortSignal;
	onProgress: (message: string) => void;
}

interface UpdateResult {
	added: number;
	removed: number;
	unchanged: number;
}

interface UpdateSubscriber {
	resolve: (result: UpdateResult) => void;
	reject: (error: Error) => void;
	onProgress: (message: string) => void;
	cleanup: () => void;
}

interface CoordinatedUpdate {
	controller: AbortController;
	subscribers: Map<string, UpdateSubscriber>;
	promise: Promise<UpdateResult>;
	closing: boolean;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Missing or invalid ${key}`);
	const maxBytes = RPC_STRING_LIMITS[key];
	if (maxBytes !== undefined && Buffer.byteLength(value) > maxBytes) {
		throw new Error(`${key} exceeds the ${maxBytes}-byte RPC limit`);
	}
	return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`Invalid ${label}.${key}`);
	}
}

function boundedOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	if (candidate === undefined) return undefined;
	if (typeof candidate !== "string") throw new Error(`Invalid options.${key}`);
	const maxBytes = RPC_STRING_LIMITS[key] ?? MAX_RPC_OPTION_PATH_BYTES;
	if (Buffer.byteLength(candidate) > maxBytes) throw new Error(`options.${key} exceeds the ${maxBytes}-byte limit`);
	return candidate;
}

function boundedOptionalInteger(
	value: Record<string, unknown>,
	key: string,
	minimum: number,
	maximum: number,
): number | undefined {
	const candidate = value[key];
	if (candidate === undefined) return undefined;
	if (!Number.isInteger(candidate) || typeof candidate !== "number" || candidate < minimum || candidate > maximum) {
		throw new Error(`Invalid options.${key}`);
	}
	return candidate;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function boundedStringArray(value: unknown, key: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_RPC_OPTION_ITEMS) throw new Error(`Invalid options.${key}`);
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || Buffer.byteLength(item) > MAX_RPC_OPTION_PATH_BYTES) {
			throw new Error(`Invalid options.${key}`);
		}
		normalized.push(item);
	}
	return normalized;
}

function optionsRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
	const value = params.options;
	if (value === undefined) return undefined;
	if (!isObjectRecord(value)) throw new Error("Invalid options");
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_RPC_OPTIONS_BYTES) {
		throw new Error(`options exceed the ${MAX_RPC_OPTIONS_BYTES}-byte limit`);
	}
	return value;
}

function parseAddOptions(params: Record<string, unknown>): AddOptions | undefined {
	const value = optionsRecord(params);
	if (!value) return undefined;
	assertKnownKeys(value, ["include_suggested_text", "include_paths", "exclude_paths"], "options");
	const includeSuggestedText = value.include_suggested_text;
	if (includeSuggestedText !== undefined && typeof includeSuggestedText !== "boolean") {
		throw new Error("Invalid options.include_suggested_text");
	}
	return {
		include_suggested_text: includeSuggestedText,
		include_paths: boundedStringArray(value.include_paths, "include_paths"),
		exclude_paths: boundedStringArray(value.exclude_paths, "exclude_paths"),
	};
}
function parseFilesystemAccess(params: Record<string, unknown>): FilesystemAccessPolicy | undefined {
	const value = params.access;
	if (value === undefined) return undefined;
	if (!isObjectRecord(value)) throw new Error("Invalid access policy");
	assertKnownKeys(value, ["allowed_roots", "allow_network"], "access");
	if (value.allow_network !== true && value.allow_network !== false) {
		throw new Error("Invalid access.allow_network");
	}
	if (!Array.isArray(value.allowed_roots) || value.allowed_roots.length > MAX_RPC_OPTION_ITEMS) {
		throw new Error("Invalid access.allowed_roots");
	}
	const allowedRoots: string[] = [];
	for (const root of value.allowed_roots) {
		if (typeof root !== "string" || Buffer.byteLength(root) > MAX_RPC_OPTION_PATH_BYTES) {
			throw new Error("Invalid access.allowed_roots");
		}
		allowedRoots.push(root);
	}
	return { allowedRoots, allowNetwork: value.allow_network };
}

function parseSearchOptions(params: Record<string, unknown>): SearchOptions | undefined {
	const value = optionsRecord(params);
	if (!value) return undefined;
	assertKnownKeys(value, ["mode", "profile", "limit", "offset", "kb_id", "filters", "diversity"], "options");
	if (value.mode !== undefined && !isOneOf(value.mode, SEARCH_MODES)) throw new Error("Invalid options.mode");
	if (value.profile !== undefined && !isOneOf(value.profile, SEARCH_PROFILES))
		throw new Error("Invalid options.profile");
	if (value.diversity !== undefined && !isOneOf(value.diversity, DIVERSITY_MODES)) {
		throw new Error("Invalid options.diversity");
	}
	let filters: SearchOptions["filters"];
	if (value.filters !== undefined) {
		if (!isObjectRecord(value.filters)) throw new Error("Invalid options.filters");
		assertKnownKeys(value.filters, ["file_type", "path_pattern"], "options.filters");
		filters = {
			file_type: boundedOptionalString(value.filters, "file_type"),
			path_pattern: boundedOptionalString(value.filters, "path_pattern"),
		};
	}
	return {
		mode: value.mode,
		profile: value.profile,
		limit: boundedOptionalInteger(value, "limit", 1, 50),
		offset: boundedOptionalInteger(value, "offset", 0, 799),
		kb_id: boundedOptionalString(value, "kb_id"),
		filters,
		diversity: value.diversity,
	};
}

function parseSymbolSearchOptions(params: Record<string, unknown>): SymbolSearchOptions | undefined {
	const value = optionsRecord(params);
	if (!value) return undefined;
	assertKnownKeys(value, ["kb_id", "kind", "file_pattern", "limit", "offset", "exact"], "options");
	if (value.kind !== undefined && !isOneOf(value.kind, SYMBOL_KINDS)) throw new Error("Invalid options.kind");
	if (value.exact !== undefined && typeof value.exact !== "boolean") throw new Error("Invalid options.exact");
	return {
		kb_id: boundedOptionalString(value, "kb_id"),
		kind: value.kind,
		file_pattern: boundedOptionalString(value, "file_pattern"),
		limit: boundedOptionalInteger(value, "limit", 1, 200),
		offset: boundedOptionalInteger(value, "offset", 0, 799),
		exact: value.exact,
	};
}

function scanOptionsFromSourceOptions(raw: string | null): {
	includeSuggestedText?: boolean;
	includePaths?: string[];
	excludePaths?: string[];
} {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as {
			include_suggested_text?: unknown;
			include_paths?: unknown;
			exclude_paths?: unknown;
		};
		return {
			includeSuggestedText: parsed.include_suggested_text === true,
			includePaths: Array.isArray(parsed.include_paths)
				? parsed.include_paths.filter((item): item is string => typeof item === "string")
				: undefined,
			excludePaths: Array.isArray(parsed.exclude_paths)
				? parsed.exclude_paths.filter((item): item is string => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

function waitForSettlement(run: Promise<unknown>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		resolve();
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		reject(new Error("Cancelled"));
	};
	signal?.addEventListener("abort", abort, { once: true });
	void run.then(finish, finish);
	return promise;
}

export class KnowledgeDaemonService {
	private readonly engine = new KnowledgeEngine();
	private readonly updates = new Map<string, CoordinatedUpdate>();
	private readonly watcherDirty = new Set<string>();
	private readonly watcherRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly profile: KnowledgeProfile;
	private readonly snapshotWriter: CoverageSnapshotWriter | undefined;
	private readonly onSnapshotStateChange: (() => void) | undefined;
	private initialized = false;
	private watchersEnabled = false;
	private shuttingDown = false;
	private lastSnapshotError: string | undefined;

	constructor(
		profile: KnowledgeProfile,
		snapshotWriter: CoverageSnapshotWriter | undefined = undefined,
		onSnapshotStateChange: (() => void) | undefined = undefined,
	) {
		this.profile = profile;
		this.snapshotWriter = snapshotWriter;
		this.onSnapshotStateChange = onSnapshotStateChange;
	}

	async initialize(watchersEnabled: boolean): Promise<void> {
		if (this.initialized) return;
		await this.engine.initialize(this.profile.storageDir);
		this.initialized = true;
		this.refreshCoverageSnapshot();
		if (watchersEnabled) this.enableWatchers();
	}

	private refreshCoverageSnapshot(): void {
		try {
			writeCoverageSnapshot(this.profile, this.engine.list(), this.snapshotWriter);
			this.lastSnapshotError = undefined;
		} catch (error) {
			this.lastSnapshotError = boundedCoverageSnapshotError(error);
			console.error(this.lastSnapshotError);
		} finally {
			this.onSnapshotStateChange?.();
		}
	}

	coverageSnapshotError(): string | undefined {
		return this.lastSnapshotError;
	}

	private assertReady(): void {
		if (!this.initialized) throw new Error("Knowledge profile daemon is still initializing");
		if (this.shuttingDown) throw new Error("Knowledge profile daemon is shutting down");
	}

	private triggerWatcherUpdate(kbId: string): void {
		if (this.shuttingDown) return;
		if (this.updates.has(kbId)) {
			this.watcherDirty.add(kbId);
			return;
		}
		void this.coordinateUpdate(`watcher:${randomUUID()}`, kbId, undefined, () => {}).catch((error: unknown) => {
			if (this.shuttingDown) return;
			const blockedByMutation = error instanceof Error && error.message.includes("already running");
			if (!blockedByMutation) {
				this.watcherDirty.delete(kbId);
				console.error("Watcher update failed; waiting for a new filesystem change");
				return;
			}
			this.watcherDirty.add(kbId);
			if (this.watcherRetryTimers.has(kbId)) return;
			const timer = setTimeout(() => {
				this.watcherRetryTimers.delete(kbId);
				if (this.watcherDirty.delete(kbId)) this.triggerWatcherUpdate(kbId);
			}, 250);
			timer.unref();
			this.watcherRetryTimers.set(kbId, timer);
		});
	}

	private startWatcherFor(kb: KnowledgeBase): void {
		if (!this.watchersEnabled || !kb.source_path || kb.source_type !== "directory") return;
		startWatcher(
			kb.id,
			kb.source_path,
			(kbId) => this.triggerWatcherUpdate(kbId),
			scanOptionsFromSourceOptions(kb.source_options),
		);
	}

	enableWatchers(): number {
		this.assertReady();
		if (!this.watchersEnabled) {
			this.watchersEnabled = true;
			for (const kb of this.engine.list()) this.startWatcherFor(kb);
		}
		return getActiveWatcherCount();
	}

	private resolveKnowledgeBase(target: string): KnowledgeBase {
		const knowledgeBases = this.engine.list();
		const kb =
			knowledgeBases.find((candidate) => candidate.id === target) ??
			knowledgeBases.find((candidate) => candidate.name === target);
		if (!kb) throw new Error(`Knowledge base not found: ${target}`);
		return kb;
	}

	private coordinateUpdate(
		subscriberId: string,
		target: string,
		signal: AbortSignal | undefined,
		onProgress: (message: string) => void,
		access?: FilesystemAccessPolicy,
	): Promise<UpdateResult> {
		this.assertReady();
		if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
		const kb = this.resolveKnowledgeBase(target);
		let operation = this.updates.get(kb.id);
		if (operation?.closing) {
			return waitForSettlement(operation.promise, signal).then(() =>
				this.coordinateUpdate(subscriberId, target, signal, onProgress, access),
			);
		}
		if (!operation) {
			const controller = new AbortController();
			const subscribers = new Map<string, UpdateSubscriber>();
			const promise = this.engine
				.update(
					kb.id,
					(message) => {
						for (const subscriber of subscribers.values()) subscriber.onProgress(message);
					},
					controller.signal,
					access,
				)
				.then((result) => {
					this.refreshCoverageSnapshot();
					return result;
				})
				.finally(() => {
					if (this.updates.get(kb.id)?.promise !== promise) return;
					this.updates.delete(kb.id);
					if (this.watcherDirty.delete(kb.id) && !this.shuttingDown) {
						queueMicrotask(() => this.triggerWatcherUpdate(kb.id));
					}
				});
			operation = { controller, subscribers, promise, closing: false };
			this.updates.set(kb.id, operation);
		}

		const active = operation;
		const { promise, resolve, reject } = Promise.withResolvers<UpdateResult>();
		let settled = false;
		const abort = (): void => {
			if (settled) return;
			settled = true;
			active.subscribers.delete(subscriberId);
			signal?.removeEventListener("abort", abort);
			reject(new Error("Cancelled"));
			if (active.subscribers.size === 0) {
				active.closing = true;
				active.controller.abort();
			}
		};
		const cleanup = (): void => signal?.removeEventListener("abort", abort);
		active.subscribers.set(subscriberId, { resolve, reject, onProgress, cleanup });
		signal?.addEventListener("abort", abort, { once: true });
		void active.promise.then(
			(result) => {
				const subscriber = active.subscribers.get(subscriberId);
				if (!subscriber || settled) return;
				settled = true;
				active.subscribers.delete(subscriberId);
				subscriber.cleanup();
				subscriber.resolve(result);
			},
			(error: unknown) => {
				const subscriber = active.subscribers.get(subscriberId);
				if (!subscriber || settled) return;
				settled = true;
				active.subscribers.delete(subscriberId);
				subscriber.cleanup();
				subscriber.reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
		return promise;
	}

	async dispatch(
		method: DaemonMethod,
		params: Record<string, unknown>,
		context: DaemonServiceDispatchContext,
	): Promise<unknown> {
		this.assertReady();
		switch (method) {
			case "plan":
				return this.engine.planAsync(
					requiredString(params, "source"),
					parseAddOptions(params),
					context.signal,
					parseFilesystemAccess(params),
				);
			case "configure": {
				if (params.node_path !== undefined && typeof params.node_path !== "string") {
					throw new Error("Invalid node_path");
				}
				const nodePath =
					params.node_path === undefined
						? resolveDaemonNodePath(this.profile)
						: configureDaemonNodePath(this.profile, params.node_path);
				return { node_path: configureModelWorkerNodePath(nodePath) };
			}
			case "add": {
				const result = await this.engine.add(
					requiredString(params, "source"),
					requiredString(params, "name"),
					context.onProgress,
					context.signal,
					parseAddOptions(params),
					parseFilesystemAccess(params),
				);
				this.startWatcherFor(result.kb);
				this.refreshCoverageSnapshot();
				return result;
			}
			case "update":
				return this.coordinateUpdate(
					context.requestId,
					requiredString(params, "target"),
					context.signal,
					context.onProgress,
					parseFilesystemAccess(params),
				);
			case "remove": {
				const target = requiredString(params, "target");
				const kb = this.engine.list().find((candidate) => candidate.id === target || candidate.name === target);
				const removed = this.engine.remove(target);
				if (removed && kb) {
					this.watcherDirty.delete(kb.id);
					const timer = this.watcherRetryTimers.get(kb.id);
					if (timer) clearTimeout(timer);
					this.watcherRetryTimers.delete(kb.id);
					stopWatcher(kb.id);
				}
				if (removed) this.refreshCoverageSnapshot();
				return removed;
			}
			case "clear":
				this.engine.clear();
				this.watcherDirty.clear();
				for (const timer of this.watcherRetryTimers.values()) clearTimeout(timer);
				this.watcherRetryTimers.clear();
				stopAllWatchers();
				this.refreshCoverageSnapshot();
				return undefined;
			case "import": {
				const result = await this.engine.importKB(
					requiredString(params, "input"),
					context.onProgress,
					context.signal,
					parseFilesystemAccess(params),
				);
				this.refreshCoverageSnapshot();
				return result;
			}
			case "export":
				return this.engine.exportKB(
					requiredString(params, "target"),
					requiredString(params, "output"),
					context.signal,
					context.onProgress,
					parseFilesystemAccess(params),
				);
			case "search":
				return this.engine.search(requiredString(params, "query"), parseSearchOptions(params), context.signal);
			case "symbol_search":
				return this.engine.symbolSearch(
					requiredString(params, "query"),
					parseSymbolSearchOptions(params),
					context.signal,
				);
			case "list": {
				const knowledgeBases = this.engine.list(context.signal, MAX_RPC_KNOWLEDGE_BASES + 1);
				if (knowledgeBases.length > MAX_RPC_KNOWLEDGE_BASES) {
					throw new Error(`Knowledge list exceeds the ${MAX_RPC_KNOWLEDGE_BASES}-knowledge-base RPC limit`);
				}
				return knowledgeBases;
			}
			case "status":
				return {
					profile: { name: this.profile.name, id: this.profile.id },
					storage_path: this.profile.storageDir,
					watch_count: getActiveWatcherCount(),
					snapshot_error: this.lastSnapshotError,
					snapshot: await this.engine.statusSnapshotAsync(
						context.signal,
						MAX_RPC_KNOWLEDGE_BASES,
						MAX_RPC_DIAGNOSTIC_PATHS,
					),
				} satisfies DaemonServiceStatus;
			case "doctor":
				return this.engine.doctorAsync(context.signal, MAX_RPC_KNOWLEDGE_BASES, MAX_RPC_DIAGNOSTIC_PATHS);
			case "enable_watchers":
				return { watch_count: this.enableWatchers() };
			case "ping":
				return { ready: true };
			case "shutdown":
				throw new Error("Shutdown must be handled by the daemon server");
		}
	}

	abortOperations(): void {
		this.shuttingDown = true;
		stopAllWatchers();
		this.watcherDirty.clear();
		for (const timer of this.watcherRetryTimers.values()) clearTimeout(timer);
		this.watcherRetryTimers.clear();
		for (const operation of this.updates.values()) operation.controller.abort();
	}

	forceTerminateModelWorker(): void {
		shutdownModelWorker();
	}

	activeUpdateCount(): number {
		return this.updates.size + getActiveWatcherScanCount();
	}

	async dispose(): Promise<void> {
		this.shuttingDown = true;
		stopAllWatchers();
		await stopAllWatchersAndWait();
		await this.engine.dispose();
		this.initialized = false;
	}
}

export type { DoctorReport, IndexPlan, KnowledgeBase, KnowledgeStatusSnapshot, SearchResponse, SymbolSearchResponse };
