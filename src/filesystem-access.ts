import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertOwnedDirectory } from "./secure-files.ts";

const MAX_ALLOWED_ROOTS = 128;
const MAX_ALLOWED_ROOT_BYTES = 4_096;

export interface FilesystemAccessPolicy {
	allowedRoots: string[];
	allowNetwork: boolean;
}

interface BoundRoot {
	path: string;
	device: number;
	inode: number;
}

function isWithin(path: string, root: string): boolean {
	const relation = relative(root, path);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function bindRoots(policy: FilesystemAccessPolicy): BoundRoot[] {
	if (policy.allowedRoots.length > MAX_ALLOWED_ROOTS) throw new Error("Too many allowed filesystem roots");
	return policy.allowedRoots.map((input) => {
		if (typeof input !== "string" || Buffer.byteLength(input) > MAX_ALLOWED_ROOT_BYTES) {
			throw new Error("Invalid allowed filesystem root");
		}
		const requested = resolve(input);
		const direct = lstatSync(requested);
		if (direct.isSymbolicLink() || !direct.isDirectory()) {
			throw new Error(`Allowed root is not a regular directory: ${requested}`);
		}
		const canonical = realpathSync.native(requested);
		assertOwnedDirectory(canonical);
		const info = statSync(canonical);
		return { path: canonical, device: info.dev, inode: info.ino };
	});
}

function assertRootStable(root: BoundRoot): void {
	const direct = lstatSync(root.path);
	const canonical = realpathSync.native(root.path);
	if (
		direct.isSymbolicLink() ||
		!direct.isDirectory() ||
		direct.dev !== root.device ||
		direct.ino !== root.inode ||
		canonical !== root.path
	) {
		throw new Error(`Allowed root changed during the operation: ${root.path}`);
	}
}

function selectRoot(path: string, roots: readonly BoundRoot[]): BoundRoot {
	const root = roots.find((candidate) => isWithin(path, candidate.path));
	if (!root) throw new Error(`Path is outside the allowed filesystem roots: ${path}`);
	assertRootStable(root);
	return root;
}

export function authorizeExistingPath(input: string, policy: FilesystemAccessPolicy | undefined): string {
	const requested = resolve(input);
	if (!policy) return requested;
	const roots = bindRoots(policy);
	if (roots.length === 0) throw new Error("No allowed filesystem root permits local paths");
	const canonical = realpathSync.native(requested);
	const root = selectRoot(canonical, roots);
	const direct = lstatSync(canonical);
	if (direct.isSymbolicLink()) throw new Error(`Path is not a regular non-symlink path: ${canonical}`);
	assertRootStable(root);
	if (realpathSync.native(canonical) !== canonical)
		throw new Error(`Path changed while authorizing access: ${canonical}`);
	return canonical;
}

export function authorizeOutputPath(input: string, policy: FilesystemAccessPolicy | undefined): string {
	const requested = resolve(input);
	if (!policy) return requested;
	const roots = bindRoots(policy);
	if (roots.length === 0) throw new Error("No allowed filesystem root permits local paths");
	const parent = realpathSync.native(dirname(requested));
	const root = selectRoot(parent, roots);
	assertRootStable(root);
	if (realpathSync.native(parent) !== parent)
		throw new Error(`Output directory changed while authorizing access: ${parent}`);
	return join(parent, basename(requested));
}
export function assertOpenedPathAuthorized(
	path: string,
	device: number,
	inode: number,
	policy: FilesystemAccessPolicy | undefined,
): void {
	if (!policy) return;
	const canonical = authorizeExistingPath(path, policy);
	const current = lstatSync(canonical);
	if (!current.isFile() || current.dev !== device || current.ino !== inode) {
		throw new Error(`Path changed after opening: ${canonical}`);
	}
}

export function assertOutputPathAuthorized(
	path: string,
	parentDevice: number,
	parentInode: number,
	policy: FilesystemAccessPolicy | undefined,
): void {
	if (!policy) return;
	const canonical = authorizeOutputPath(path, policy);
	if (canonical !== path) throw new Error(`Output path changed while authorizing access: ${path}`);
	const current = statSync(dirname(canonical));
	if (current.dev !== parentDevice || current.ino !== parentInode) {
		throw new Error(`Output directory changed while authorizing access: ${dirname(canonical)}`);
	}
}

export function assertNetworkAccess(policy: FilesystemAccessPolicy | undefined): void {
	if (policy && !policy.allowNetwork) throw new Error("Network access is not allowed for this operation");
}
