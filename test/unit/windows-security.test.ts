import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertWindowsPathAncestorsTrusted,
	assertWindowsPathPrivate,
	hardenWindowsPath,
} from "../../src/windows-security.ts";

describe.skipIf(process.platform !== "win32")("Windows path security", { timeout: 20_000 }, () => {
	it("hardens directory and file paths containing spaces, apostrophes, and Unicode", () => {
		const root = mkdtempSync(join(homedir(), "pk acl ' 測試 "));
		const file = join(root, "private file ' 測試.json");
		try {
			hardenWindowsPath(root, true);
			hardenWindowsPath(root, true);
			assertWindowsPathPrivate(root);
			assertWindowsPathAncestorsTrusted(root);

			writeFileSync(file, "{}\n", { mode: 0o600 });
			hardenWindowsPath(file, false);
			hardenWindowsPath(file, false);
			assertWindowsPathPrivate(file);
			assertWindowsPathAncestorsTrusted(file);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an ancestor that grants delete-child rights to an untrusted principal", () => {
		const root = mkdtempSync(join(homedir(), "pk-acl-reject-"));
		const parent = join(root, "parent");
		const child = join(parent, "child");
		try {
			hardenWindowsPath(root, true);
			mkdirSync(child, { recursive: true });
			execFileSync("icacls.exe", [parent, "/grant", "*S-1-5-32-545:(DC)"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			expect(() => assertWindowsPathAncestorsTrusted(child)).toThrow(
				"Windows path or ancestor is controlled by an untrusted principal",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces PowerShell stderr for invalid paths", () => {
		const root = mkdtempSync(join(homedir(), "pk-acl-missing-"));
		try {
			expect(() => assertWindowsPathPrivate(join(root, "missing"))).toThrow(/Windows security command failed: .+/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
