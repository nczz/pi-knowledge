import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	ensureOwnerOnlyDirectory,
	ensurePrivateDirectory,
	readPrivateJson,
	writeJsonExclusive,
} from "./secure-files.ts";

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const WINDOWS_RESERVED_NAMES: Record<string, true> = {
	con: true,
	prn: true,
	aux: true,
	nul: true,
	com1: true,
	com2: true,
	com3: true,
	com4: true,
	com5: true,
	com6: true,
	com7: true,
	com8: true,
	com9: true,
	lpt1: true,
	lpt2: true,
	lpt3: true,
	lpt4: true,
	lpt5: true,
	lpt6: true,
	lpt7: true,
	lpt8: true,
	lpt9: true,
};

export interface KnowledgeProfile {
	name: string;
	id: string;
	storageDir: string;
	runtimeDir: string;
	profileRoot: string;
	registryPath: string;
}

interface ProfileRegistry {
	schema_version: 1;
	default_storage: string;
}

export interface ResolveProfileOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

function profileHome(homeDir: string): string {
	return join(homeDir, ".pi-knowledge");
}

function profileRoot(env: NodeJS.ProcessEnv, homeDir: string): string {
	const configured = env.PI_KNOWLEDGE_PROFILE_ROOT?.trim();
	return configured ? resolve(configured) : join(profileHome(homeDir), "profiles");
}

function registryPath(homeDir: string): string {
	return join(profileHome(homeDir), "profiles.json");
}

function assertProfileName(name: string): string {
	if (!PROFILE_NAME_PATTERN.test(name) || name !== name.toLowerCase() || name.endsWith(".") || name.endsWith(" ")) {
		throw new Error(
			`Invalid knowledge profile name "${name}". Use 1-63 lowercase ASCII letters, digits, underscores, or hyphens.`,
		);
	}
	const base = name.split(".")[0];
	if (base && WINDOWS_RESERVED_NAMES[base]) {
		throw new Error(`Invalid knowledge profile name "${name}": reserved device name`);
	}
	return name;
}

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function assertNoCaseFoldCollision(root: string, canonicalName: string): void {
	const collision = readdirSync(root, { withFileTypes: true }).find(
		(entry) => entry.name !== canonicalName && entry.name.toLowerCase() === canonicalName,
	);
	if (collision) {
		throw new Error(
			`Knowledge profile "${canonicalName}" conflicts with existing case-variant entry "${collision.name}"`,
		);
	}
}

function readRegistry(path: string): ProfileRegistry | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = readPrivateJson(path, "knowledge profile registry");
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("schema_version" in parsed) ||
		parsed.schema_version !== 1 ||
		!("default_storage" in parsed) ||
		typeof parsed.default_storage !== "string" ||
		!isAbsolute(parsed.default_storage)
	) {
		throw new Error(`Invalid knowledge profile registry: ${path}`);
	}
	return parsed as ProfileRegistry;
}

function existingDatabaseCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
	const candidates: string[] = [];
	const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim() || env.OMP_CODING_AGENT_DIR?.trim();
	if (configuredAgentDir) candidates.push(join(dirname(resolve(configuredAgentDir)), "knowledge"));
	candidates.push(join(homeDir, ".pi", "knowledge"), join(homeDir, ".omp", "knowledge"));
	const canonical = new Map<string, string>();
	for (const candidate of candidates) {
		if (!existsSync(join(candidate, "knowledge.db"))) continue;
		const resolved = realpathSync.native(candidate);
		canonical.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
	}
	return [...canonical.values()];
}

function resolveDefaultStorage(env: NodeJS.ProcessEnv, homeDir: string, root: string, registry: string): string {
	const explicit = env.PI_KNOWLEDGE_DIR?.trim() || env.OMP_KNOWLEDGE_DIR?.trim();
	if (explicit) return ensureOwnerOnlyDirectory(resolve(explicit));

	const persisted = readRegistry(registry);
	if (persisted) return ensureOwnerOnlyDirectory(persisted.default_storage);

	const legacy = existingDatabaseCandidates(env, homeDir);
	if (legacy.length > 1) {
		throw new Error(
			`Multiple legacy knowledge databases were found (${legacy.join(", ")}). Set PI_KNOWLEDGE_DIR to choose the default profile storage explicitly.`,
		);
	}
	if (legacy.length === 0) assertNoCaseFoldCollision(root, "default");
	const selected = legacy[0] ?? join(root, "default");
	const canonical = ensureOwnerOnlyDirectory(selected);
	const claimed = writeJsonExclusive(registry, {
		schema_version: 1,
		default_storage: canonical,
	} satisfies ProfileRegistry);
	if (claimed) return canonical;
	const winner = readRegistry(registry);
	if (!winner) throw new Error(`Knowledge profile registry claim disappeared: ${registry}`);
	return ensureOwnerOnlyDirectory(winner.default_storage);
}

export function selectedProfileName(env: NodeJS.ProcessEnv = process.env): string {
	return assertProfileName(env.PI_KNOWLEDGE_PROFILE?.trim() || "default");
}

export function resolveKnowledgeProfile(
	name = selectedProfileName(),
	options: ResolveProfileOptions = {},
): KnowledgeProfile {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? homedir();
	const canonicalName = assertProfileName(name);
	const defaultRoot = ensurePrivateDirectory(join(profileHome(homeDir), "profiles"));
	const root = canonicalName === "default" ? defaultRoot : ensurePrivateDirectory(profileRoot(env, homeDir));
	const registry = registryPath(homeDir);
	let storageDir: string;
	if (canonicalName === "default") {
		storageDir = resolveDefaultStorage(env, homeDir, root, registry);
	} else {
		if (env.PI_KNOWLEDGE_DIR?.trim() || env.OMP_KNOWLEDGE_DIR?.trim()) {
			throw new Error("PI_KNOWLEDGE_DIR/OMP_KNOWLEDGE_DIR can only override the default knowledge profile");
		}
		assertNoCaseFoldCollision(root, canonicalName);
		const candidate = join(root, canonicalName);
		if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
			throw new Error(`Named knowledge profile cannot be a symbolic link: ${candidate}`);
		}
		storageDir = ensureOwnerOnlyDirectory(candidate);
		if (basename(storageDir) !== canonicalName) {
			throw new Error(`Named knowledge profile does not round-trip to its canonical name: ${canonicalName}`);
		}
		if (!isWithin(storageDir, root)) {
			throw new Error(`Named knowledge profile escapes the configured profile root: ${canonicalName}`);
		}
	}
	const id = createHash("sha256").update(storageDir).digest("hex").slice(0, 24);
	return {
		name: canonicalName,
		id,
		storageDir,
		runtimeDir: join(storageDir, ".runtime"),
		profileRoot: root,
		registryPath: registry,
	};
}

export function profileHasDatabase(profile: KnowledgeProfile): boolean {
	return (
		existsSync(join(profile.storageDir, "knowledge.db")) && statSync(join(profile.storageDir, "knowledge.db")).isFile()
	);
}
