import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertWindowsPathAncestorsTrusted, assertWindowsPathPrivate, hardenWindowsPath } from "./windows-security.ts";

export function assertOwnedDirectory(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`Expected a real directory owned by the current user: ${path}`);
	}
	if (process.platform === "win32") {
		assertWindowsPathPrivate(path);
		assertWindowsPathAncestorsTrusted(path);
	} else {
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			throw new Error(`Directory is not owned by the current user: ${path}`);
		}
		if ((info.mode & 0o022) !== 0) throw new Error(`Directory must not be group/world writable: ${path}`);
	}
	if (process.platform !== "win32" && typeof process.getuid === "function") {
		const uid = process.getuid();
		let current = realpathSync.native(path);
		while (true) {
			const ancestor = lstatSync(current);
			if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
				throw new Error(`Path ancestor is not a real directory: ${current}`);
			}
			if (ancestor.uid !== uid && ancestor.uid !== 0) {
				throw new Error(`Path ancestor is owned by an untrusted user: ${current}`);
			}
			if ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0) {
				throw new Error(`Path ancestor permits untrusted rename operations: ${current}`);
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
}

export function ensurePrivateDirectory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	hardenWindowsPath(path, true);
	assertOwnedDirectory(path);
	return realpathSync.native(path);
}

export function ensureOwnerOnlyDirectory(path: string): string {
	const canonical = ensurePrivateDirectory(path);
	if (process.platform !== "win32") {
		chmodSync(canonical, 0o700);
		const info = statSync(canonical);
		if ((info.mode & 0o077) !== 0) throw new Error(`Directory must use owner-only permissions: ${canonical}`);
	}
	return canonical;
}

export function fsyncDirectory(path: string): void {
	try {
		const fd = openSync(path, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Directory fsync is unavailable on some supported platforms.
	}
}

export interface SafeNewFile {
	outputPath: string;
	parentPath: string;
	parentDevice: number;
	parentInode: number;
	tempPath: string;
}

export function prepareSafeNewFile(path: string): SafeNewFile {
	const requested = resolve(path);
	const parentPath = realpathSync.native(dirname(requested));
	assertOwnedDirectory(parentPath);
	const outputPath = join(parentPath, basename(requested));
	if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
	const parent = statSync(parentPath);
	return {
		outputPath,
		parentPath,
		parentDevice: parent.dev,
		parentInode: parent.ino,
		tempPath: join(parentPath, `.${basename(requested)}.${randomUUID()}.tmp`),
	};
}

export function publishNewFile(tempPath: string, target: SafeNewFile): void {
	const currentParent = statSync(target.parentPath);
	if (currentParent.dev !== target.parentDevice || currentParent.ino !== target.parentInode) {
		throw new Error(`Export directory changed during publication: ${target.parentPath}`);
	}
	linkSync(tempPath, target.outputPath);
	fsyncDirectory(target.parentPath);
	rmSync(tempPath, { force: true });
}

export function hardenPrivateFile(path: string, label: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid ${label}: ${path}`);
	if (process.platform === "win32") {
		hardenWindowsPath(path, false);
	} else {
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			throw new Error(`${label} is not owned by the current user: ${path}`);
		}
		chmodSync(path, 0o600);
	}
}

export function readPrivateJson(path: string, label: string): unknown {
	assertOwnedDirectory(dirname(path));
	const direct = lstatSync(path);
	if (direct.isSymbolicLink() || !direct.isFile()) throw new Error(`Invalid ${label}: ${path}`);
	if (process.platform === "win32") {
		assertWindowsPathPrivate(path);
	} else {
		if (typeof process.getuid === "function" && direct.uid !== process.getuid()) {
			throw new Error(`${label} is not owned by the current user: ${path}`);
		}
		if ((direct.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad: ${path}`);
	}
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (opened.dev !== direct.dev || opened.ino !== direct.ino)
			throw new Error(`${label} changed while opening: ${path}`);
		return JSON.parse(readFileSync(fd, "utf8")) as unknown;
	} finally {
		closeSync(fd);
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	const parent = ensurePrivateDirectory(dirname(path));
	const temp = join(parent, `.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		hardenWindowsPath(path, false);
		fsyncDirectory(parent);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
	}
}

export function writeJsonExclusive(path: string, value: unknown): boolean {
	const parent = ensurePrivateDirectory(dirname(path));
	const temp = join(parent, `.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			linkSync(temp, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		hardenPrivateFile(path, "knowledge profile registry");
		fsyncDirectory(parent);
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
	}
}
