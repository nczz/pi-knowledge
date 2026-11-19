import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertOpenedPathAuthorized,
	assertOutputPathAuthorized,
	authorizeExistingPath,
	authorizeOutputPath,
	type FilesystemAccessPolicy,
} from "../../src/filesystem-access.ts";

function policy(root: string): FilesystemAccessPolicy {
	return { allowedRoots: [root], allowNetwork: false };
}

describe.skipIf(process.platform === "win32")("filesystem access binding", () => {
	it("rejects an opened object that does not match the authorized path", () => {
		const workspace = mkdtempSync(join(tmpdir(), "pk-access-open-"));
		try {
			const allowed = join(workspace, "allowed");
			const outside = join(workspace, "outside.txt");
			mkdirSync(allowed);
			const authorized = join(allowed, "source.txt");
			writeFileSync(authorized, "allowed");
			writeFileSync(outside, "outside");
			const canonical = authorizeExistingPath(authorized, policy(allowed));
			const fd = openSync(outside, "r");
			try {
				const opened = fstatSync(fd);
				expect(() => assertOpenedPathAuthorized(canonical, opened.dev, opened.ino, policy(allowed))).toThrow(
					"changed after opening",
				);
			} finally {
				closeSync(fd);
			}
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects an output parent replaced by a symlink after authorization", () => {
		const workspace = mkdtempSync(join(tmpdir(), "pk-access-output-"));
		try {
			const allowed = join(workspace, "allowed");
			const slot = join(allowed, "slot");
			const moved = join(allowed, "moved");
			const outside = join(workspace, "outside");
			mkdirSync(slot, { recursive: true });
			mkdirSync(outside);
			const output = authorizeOutputPath(join(slot, "export.jsonl"), policy(allowed));
			const parent = statSync(slot);
			renameSync(slot, moved);
			symlinkSync(outside, slot);

			expect(() => assertOutputPathAuthorized(output, parent.dev, parent.ino, policy(allowed))).toThrow(
				"outside the allowed filesystem roots",
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects allowed roots below a non-sticky writable ancestor", () => {
		const workspace = mkdtempSync(join(tmpdir(), "pk-access-ancestor-"));
		try {
			const unsafeAncestor = join(workspace, "shared");
			const allowed = join(unsafeAncestor, "allowed");
			mkdirSync(allowed, { recursive: true });
			chmodSync(unsafeAncestor, 0o777);

			expect(() => authorizeExistingPath(allowed, policy(allowed))).toThrow("untrusted rename operations");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
