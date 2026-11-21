import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KnowledgeProfile } from "../profiles.ts";
import {
	assertOwnedDirectory,
	ensureOwnerOnlyDirectory,
	fsyncDirectory,
	readPrivateJson,
	writeJsonAtomic,
	writeJsonExclusive,
} from "../secure-files.ts";
import { isObjectRecord } from "../type-guards.ts";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonManifest,
	type DaemonOwnerRecord,
	packageBuildIdentity,
	packageVersion,
	runtimeConfigurationSignature,
} from "./protocol.ts";

export class DaemonLockExistsError extends Error {
	constructor() {
		super("Knowledge profile daemon ownership is already claimed");
		this.name = "DaemonLockExistsError";
	}
}

export interface DaemonOwnership {
	owner: DaemonOwnerRecord;
	authToken: string;
	lockPath: string;
	manifestPath: string;
}

function parseOwnerRecord(value: unknown): DaemonOwnerRecord {
	if (
		!isObjectRecord(value) ||
		value.protocol_version !== DAEMON_PROTOCOL_VERSION ||
		typeof value.profile_id !== "string" ||
		typeof value.instance_id !== "string" ||
		typeof value.pid !== "number" ||
		!Number.isInteger(value.pid) ||
		typeof value.started_at !== "number" ||
		typeof value.endpoint !== "string"
	) {
		throw new Error("Invalid daemon owner record");
	}
	return value as unknown as DaemonOwnerRecord;
}

function parseManifest(value: unknown): DaemonManifest {
	const owner = parseOwnerRecord(value);
	if (
		!isObjectRecord(value) ||
		typeof value.profile_name !== "string" ||
		typeof value.storage_dir !== "string" ||
		typeof value.package_version !== "string" ||
		typeof value.auth_token !== "string" ||
		typeof value.runtime_configuration_signature !== "string" ||
		typeof value.build_identity !== "string" ||
		typeof value.ready !== "boolean" ||
		typeof value.watcher_enabled !== "boolean" ||
		("last_snapshot_error" in value &&
			value.last_snapshot_error !== undefined &&
			typeof value.last_snapshot_error !== "string")
	) {
		throw new Error("Invalid daemon manifest");
	}
	return { ...owner, ...(value as Omit<DaemonManifest, keyof DaemonOwnerRecord>) };
}

export function daemonManifestPath(profile: KnowledgeProfile): string {
	return join(profile.runtimeDir, "daemon.json");
}

export function daemonLockPath(profile: KnowledgeProfile): string {
	return join(profile.runtimeDir, "daemon.lock");
}

export function readDaemonManifest(profile: KnowledgeProfile): DaemonManifest | undefined {
	const path = daemonManifestPath(profile);
	try {
		if (!existsSync(path)) return undefined;
		const manifest = parseManifest(readPrivateJson(path, "daemon runtime file"));
		if (manifest.profile_id !== profile.id || manifest.storage_dir !== profile.storageDir) {
			throw new Error(`Daemon manifest does not belong to knowledge profile "${profile.name}"`);
		}
		return manifest;
	} catch (error) {
		if (!existsSync(path) || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function readDaemonOwner(profile: KnowledgeProfile): DaemonOwnerRecord | undefined {
	const path = daemonLockPath(profile);
	try {
		if (!existsSync(path)) return undefined;
		const owner = parseOwnerRecord(readPrivateJson(path, "daemon runtime file"));
		if (owner.profile_id !== profile.id) throw new Error("Daemon lock belongs to a different knowledge profile");
		return owner;
	} catch (error) {
		if (!existsSync(path) || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function runtimeSocketRoot(): string {
	if (process.platform === "win32") return "";
	const configured = process.env.PI_KNOWLEDGE_RUNTIME_DIR?.trim();
	const preferred = configured || join(homedir(), ".pi-knowledge", "run");
	const suffixLength = 1 + 12 + 1 + 43 + 5;
	const candidates = [
		preferred,
		join(tmpdir(), `pi-knowledge-${process.getuid?.() ?? "user"}`),
		join("/tmp", `pk-${process.getuid?.() ?? "user"}`),
	];
	for (const candidate of candidates) {
		if (Buffer.byteLength(candidate) + suffixLength > 96) continue;
		const canonical = ensureOwnerOnlyDirectory(candidate);
		if (Buffer.byteLength(canonical) + suffixLength <= 96) return canonical;
	}
	throw new Error("Unable to create a bounded Unix daemon socket path");
}

function createEndpoint(profile: KnowledgeProfile): string {
	const random = randomBytes(32).toString("base64url");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-knowledge-${profile.id}-${random}`;
	return join(runtimeSocketRoot(), `${profile.id.slice(0, 12)}-${random}.sock`);
}

export function acquireDaemonOwnership(profile: KnowledgeProfile): DaemonOwnership {
	ensureOwnerOnlyDirectory(profile.runtimeDir);
	const owner: DaemonOwnerRecord = {
		protocol_version: DAEMON_PROTOCOL_VERSION,
		profile_id: profile.id,
		instance_id: randomUUID(),
		pid: process.pid,
		started_at: Date.now(),
		endpoint: createEndpoint(profile),
	};
	const lockPath = daemonLockPath(profile);
	if (!writeJsonExclusive(lockPath, owner)) throw new DaemonLockExistsError();
	return {
		owner,
		authToken: randomBytes(32).toString("hex"),
		lockPath,
		manifestPath: daemonManifestPath(profile),
	};
}

export function publishDaemonManifest(
	profile: KnowledgeProfile,
	ownership: DaemonOwnership,
	state: { ready: boolean; watcherEnabled: boolean; lastSnapshotError?: string },
): DaemonManifest {
	const manifest: DaemonManifest = {
		...ownership.owner,
		profile_name: profile.name,
		storage_dir: profile.storageDir,
		package_version: packageVersion(),
		build_identity: packageBuildIdentity(),
		auth_token: ownership.authToken,
		runtime_configuration_signature: runtimeConfigurationSignature(),
		ready: state.ready,
		watcher_enabled: state.watcherEnabled,
		last_snapshot_error: state.lastSnapshotError,
	};
	writeJsonAtomic(ownership.manifestPath, manifest);
	return manifest;
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function removeUnixEndpoint(endpoint: string): void {
	if (process.platform === "win32" || !existsSync(endpoint)) return;
	assertOwnedDirectory(dirname(endpoint));
	const info = lstatSync(endpoint);
	if (!info.isSocket()) throw new Error(`Refusing to remove a non-socket daemon endpoint: ${endpoint}`);
	rmSync(endpoint);
}

export function removeStaleOwnership(profile: KnowledgeProfile, expected: DaemonOwnerRecord): void {
	const current = readDaemonOwner(profile);
	if (!current || current.instance_id !== expected.instance_id || current.endpoint !== expected.endpoint) {
		throw new Error("Daemon ownership changed during stale recovery");
	}
	if (processIsAlive(current.pid)) throw new Error(`Daemon owner PID ${current.pid} is still alive`);
	const stale = join(profile.runtimeDir, `.daemon-lock-stale-${randomUUID()}`);
	renameSync(daemonLockPath(profile), stale);
	fsyncDirectory(profile.runtimeDir);
	const manifest = readDaemonManifest(profile);
	if (manifest?.instance_id === expected.instance_id) rmSync(daemonManifestPath(profile), { force: true });
	rmSync(stale, { force: true });
	fsyncDirectory(profile.runtimeDir);
	// A stale endpoint uses a per-instance random path. Leave it in place: unlinking after a liveness
	// check has an unavoidable bind/unlink race that could remove a foreign live socket.
}

export function releaseDaemonOwnership(
	profile: KnowledgeProfile,
	ownership: DaemonOwnership,
	options: { removeEndpoint?: boolean } = {},
): void {
	const current = readDaemonOwner(profile);
	if (!current || current.instance_id !== ownership.owner.instance_id) return;
	if (options.removeEndpoint !== false) removeUnixEndpoint(ownership.owner.endpoint);
	const manifest = readDaemonManifest(profile);
	if (manifest?.instance_id === ownership.owner.instance_id) rmSync(ownership.manifestPath, { force: true });
	rmSync(ownership.lockPath, { force: true });
}
