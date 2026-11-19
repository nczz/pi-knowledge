import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, parse } from "node:path";
import type { KnowledgeProfile } from "./profiles.ts";
import { readRuntimeConfig, writeRuntimeConfig } from "./runtime-config.ts";
import { assertWindowsExecutableTrusted } from "./windows-security.ts";

const MIN_NODE_MAJOR = 22;

function parseNodeMajor(version: string): number | undefined {
	const match = /^v?(?<major>\d+)\./.exec(version.trim());
	if (!match?.groups?.major) return undefined;
	const major = Number(match.groups.major);
	return Number.isInteger(major) ? major : undefined;
}

function assertTrustedExecutable(path: string): string {
	if (!isAbsolute(path)) throw new Error(`Daemon Node executable must be an absolute path: ${path}`);
	const directInfo = lstatSync(path);
	if (!directInfo.isFile() && !directInfo.isSymbolicLink()) {
		throw new Error(`Daemon Node executable is not a file: ${path}`);
	}
	const canonical = realpathSync.native(path);
	const info = statSync(canonical);
	if (!info.isFile()) throw new Error(`Daemon Node executable is not a regular file: ${canonical}`);
	if (process.platform === "win32") {
		assertWindowsExecutableTrusted(canonical);
	} else {
		if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) {
			throw new Error(`Daemon Node executable is not owned by the current user or root: ${canonical}`);
		}
		if ((info.mode & 0o022) !== 0) {
			throw new Error(`Daemon Node executable must not be group/world writable: ${canonical}`);
		}
		const root = parse(canonical).root;
		let parent = dirname(canonical);
		while (parent !== root) {
			const parentInfo = lstatSync(parent);
			if (!parentInfo.isDirectory()) throw new Error(`Daemon Node parent is not a directory: ${parent}`);
			if (typeof process.getuid === "function" && parentInfo.uid !== process.getuid() && parentInfo.uid !== 0) {
				throw new Error(`Daemon Node parent is not owned by the current user or root: ${parent}`);
			}
			if ((parentInfo.mode & 0o022) !== 0) {
				throw new Error(`Daemon Node parent must not be group/world writable: ${parent}`);
			}
			parent = dirname(parent);
		}
	}
	const version = execFileSync(canonical, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5_000,
		windowsHide: true,
	}).trim();
	const major = parseNodeMajor(version);
	if (major === undefined || major < MIN_NODE_MAJOR) {
		throw new Error(`Node ${MIN_NODE_MAJOR}+ is required for the profile daemon; ${canonical} reported ${version}`);
	}
	return canonical;
}

export function resolveDaemonNodePath(profile: KnowledgeProfile): string {
	const executableName = basename(process.execPath).toLowerCase();
	if (executableName === "node" || executableName === "node.exe") {
		const major = parseNodeMajor(process.version);
		if (major !== undefined && major >= MIN_NODE_MAJOR) return assertTrustedExecutable(process.execPath);
	}
	const persisted = readRuntimeConfig(profile.storageDir).node_path?.trim();
	if (persisted) return assertTrustedExecutable(persisted);
	throw new Error(
		`No trusted Node ${MIN_NODE_MAJOR}+ runtime is configured for knowledge profile "${profile.name}". Call knowledge_configure with an explicit absolute node_path before starting the daemon.`,
	);
}

export function configureDaemonNodePath(profile: KnowledgeProfile, nodePath: string): string {
	const configured = assertTrustedExecutable(nodePath.trim());
	writeRuntimeConfig({ node_path: configured }, profile.storageDir);
	return configured;
}
