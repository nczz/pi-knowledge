import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObjectRecord } from "../type-guards.ts";

export const DAEMON_PROTOCOL_VERSION = 1;
export const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_RPC_CONNECTIONS = 64;
export const MAX_RPC_IN_FLIGHT = 32;
export const MAX_PROGRESS_FRAMES = 1_000;
export const DAEMON_START_TIMEOUT_MS = 20_000;
export const DAEMON_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;
export const DAEMON_SHUTDOWN_GRACE_MS = 10_000;
export const DAEMON_SHUTDOWN_SETTLE_MS = 2_000;

const RUNTIME_SIGNATURE_EXCLUSIONS: Record<string, true> = {
	PI_KNOWLEDGE_AUTO_INJECT: true,
	PI_KNOWLEDGE_DIR: true,
	PI_KNOWLEDGE_MCP_HTTP_TOKEN: true,
	PI_KNOWLEDGE_PROFILE: true,
	PI_KNOWLEDGE_PROFILE_ROOT: true,
	PI_KNOWLEDGE_RUNTIME_DIR: true,
	PI_KNOWLEDGE_WATCH: true,
};

export type DaemonMethod =
	| "ping"
	| "shutdown"
	| "enable_watchers"
	| "plan"
	| "configure"
	| "add"
	| "update"
	| "remove"
	| "clear"
	| "import"
	| "export"
	| "search"
	| "symbol_search"
	| "list"
	| "status"
	| "doctor";

export type DaemonMethodScope = "read" | "source-read" | "write" | "admin";

export const DAEMON_METHOD_SCOPE: Record<DaemonMethod, DaemonMethodScope> = {
	ping: "read",
	shutdown: "admin",
	enable_watchers: "admin",
	plan: "source-read",
	configure: "admin",
	add: "write",
	update: "write",
	remove: "admin",
	clear: "admin",
	import: "write",
	export: "write",
	search: "read",
	symbol_search: "read",
	list: "read",
	status: "read",
	doctor: "read",
};

const DAEMON_METHODS: Record<DaemonMethod, true> = {
	ping: true,
	shutdown: true,
	enable_watchers: true,
	plan: true,
	configure: true,
	add: true,
	update: true,
	remove: true,
	clear: true,
	import: true,
	export: true,
	search: true,
	symbol_search: true,
	list: true,
	status: true,
	doctor: true,
};

export interface DaemonOwnerRecord {
	protocol_version: typeof DAEMON_PROTOCOL_VERSION;
	profile_id: string;
	instance_id: string;
	pid: number;
	started_at: number;
	endpoint: string;
}

export interface DaemonManifest extends DaemonOwnerRecord {
	profile_name: string;
	storage_dir: string;
	package_version: string;
	build_identity: string;
	auth_token: string;
	ready: boolean;
	watcher_enabled: boolean;
	runtime_configuration_signature: string;
	last_snapshot_error?: string;
}

export interface DaemonRequestFrame {
	type: "request";
	version: typeof DAEMON_PROTOCOL_VERSION;
	id: string;
	token: string;
	package_version: string;
	build_identity: string;
	method: DaemonMethod;
	params: Record<string, unknown>;
}

export interface DaemonCancelFrame {
	type: "cancel";
	version: typeof DAEMON_PROTOCOL_VERSION;
	id: string;
	token: string;
}

export type DaemonClientFrame = DaemonRequestFrame | DaemonCancelFrame;

export interface DaemonProgressFrame {
	type: "progress";
	id: string;
	message: string;
}

export interface DaemonResultFrame {
	type: "result";
	id: string;
	result: unknown;
}

export interface DaemonErrorFrame {
	type: "error";
	id: string;
	code: string;
	message: string;
}

export type DaemonServerFrame = DaemonProgressFrame | DaemonResultFrame | DaemonErrorFrame;

export function isDaemonMethod(value: unknown): value is DaemonMethod {
	return typeof value === "string" && Object.hasOwn(DAEMON_METHODS, value);
}

export function parseDaemonClientFrame(value: unknown): DaemonClientFrame {
	if (!isObjectRecord(value) || value.version !== DAEMON_PROTOCOL_VERSION || typeof value.type !== "string") {
		throw new Error("Invalid daemon RPC frame");
	}
	if (value.type === "cancel") {
		if (typeof value.id !== "string" || typeof value.token !== "string") throw new Error("Invalid daemon cancel frame");
		return value as unknown as DaemonCancelFrame;
	}
	if (
		value.type !== "request" ||
		typeof value.id !== "string" ||
		typeof value.token !== "string" ||
		typeof value.package_version !== "string" ||
		typeof value.build_identity !== "string" ||
		!isDaemonMethod(value.method) ||
		!isObjectRecord(value.params)
	) {
		throw new Error("Invalid daemon request frame");
	}
	return value as unknown as DaemonRequestFrame;
}

export function parseDaemonServerFrame(value: unknown): DaemonServerFrame {
	if (!isObjectRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
		throw new Error("Invalid daemon response frame");
	}
	if (value.type === "progress" && typeof value.message === "string") return value as unknown as DaemonProgressFrame;
	if (value.type === "result" && "result" in value) return value as unknown as DaemonResultFrame;
	if (value.type === "error" && typeof value.code === "string" && typeof value.message === "string") {
		return value as unknown as DaemonErrorFrame;
	}
	throw new Error("Invalid daemon response frame");
}

export function runtimeConfigurationSignature(env: NodeJS.ProcessEnv = process.env): string {
	const entries = Object.entries(env)
		.filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				(entry[0].startsWith("PI_KNOWLEDGE_") || entry[0].startsWith("OPENAI_")) &&
				!RUNTIME_SIGNATURE_EXCLUSIONS[entry[0]],
		)
		.sort(([left], [right]) => left.localeCompare(right));
	const hash = createHash("sha256");
	for (const [key, value] of entries) hash.update(key).update("\0").update(value).update("\0");
	return hash.digest("hex");
}

let cachedPackageRoot: string | undefined;
let cachedPackageBuildIdentity: string | undefined;

function packageRoot(): string {
	if (cachedPackageRoot) return cachedPackageRoot;
	let current = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth++) {
		const candidate = join(current, "package.json");
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
			if (parsed.name === "pi-knowledge") {
				cachedPackageRoot = current;
				return current;
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error("Unable to resolve pi-knowledge package root");
}

function executableFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && (path.endsWith(".js") || path.endsWith(".ts"))) files.push(path);
		}
	};
	visit(root);
	return files;
}

export function packageBuildIdentity(): string {
	if (cachedPackageBuildIdentity) return cachedPackageBuildIdentity;
	const root = packageRoot();
	const compiledRoot = join(root, "dist");
	const sourceRoot = join(root, "src");
	const hash = createHash("sha256");
	const roots =
		fileURLToPath(import.meta.url).endsWith(".js") && existsSync(compiledRoot) ? [compiledRoot] : [sourceRoot];
	const rootEntry = join(root, fileURLToPath(import.meta.url).endsWith(".js") ? "extension.js" : "index.ts");
	const files = [...(existsSync(rootEntry) ? [rootEntry] : []), ...roots.flatMap(executableFiles)];
	for (const path of files) {
		hash.update(path.slice(root.length)).update("\0").update(readFileSync(path)).update("\0");
	}
	cachedPackageBuildIdentity = hash.digest("hex");
	return cachedPackageBuildIdentity;
}

let cachedPackageVersion: string | undefined;

export function packageVersion(): string {
	if (cachedPackageVersion) return cachedPackageVersion;
	const candidate = join(packageRoot(), "package.json");
	const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
	if (typeof parsed.version === "string") {
		cachedPackageVersion = parsed.version;
		return parsed.version;
	}
	throw new Error("Unable to resolve pi-knowledge package version");
}
