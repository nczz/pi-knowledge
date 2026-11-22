import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertWindowsPathAncestorsTrusted,
	assertWindowsPathPrivate,
	ensureWindowsPathPrivate,
} from "../../src/windows-security.ts";

function readDirectoryGroup(path: string): string {
	const powershell = join(
		process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	return execFileSync(
		powershell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$item=Get-Item -LiteralPath $env:PK_TEST_SECURITY_PATH -Force; $acl=([System.IO.DirectoryInfo]$item).GetAccessControl([Security.AccessControl.AccessControlSections]::Group); $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value",
		],
		{
			encoding: "utf8",
			env: { ...process.env, PK_TEST_SECURITY_PATH: path },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	).trim();
}

describe.skipIf(process.platform !== "win32")("Windows path security", { timeout: 20_000 }, () => {
	it("hardens directory and file paths containing spaces, apostrophes, and Unicode", () => {
		const root = mkdtempSync(join(homedir(), "pk acl ' 測試 "));
		const file = join(root, "private file ' 測試.json");
		try {
			ensureWindowsPathPrivate(root, true);
			ensureWindowsPathPrivate(root, true);
			assertWindowsPathPrivate(root, true);

			writeFileSync(file, "{}\n", { mode: 0o600 });
			ensureWindowsPathPrivate(file, false);
			ensureWindowsPathPrivate(file, false);
			assertWindowsPathPrivate(file, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves mandatory integrity labels while replacing only owner and DACL state", () => {
		const root = mkdtempSync(join(homedir(), "pk-integrity-"));
		try {
			execFileSync("icacls.exe", [root, "/setintegritylevel", "(OI)(CI)L"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const before = execFileSync("icacls.exe", [root], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			expect(before).toContain("(NW)");
			const groupBefore = readDirectoryGroup(root);

			ensureWindowsPathPrivate(root, true);
			ensureWindowsPathPrivate(root, true);

			const after = execFileSync("icacls.exe", [root], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			expect(after).toContain("(NW)");
			expect(readDirectoryGroup(root)).toBe(groupBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an ancestor that grants delete-child rights to an untrusted principal", () => {
		const root = mkdtempSync(join(homedir(), "pk-acl-reject-"));
		const parent = join(root, "parent");
		const child = join(parent, "child");
		try {
			ensureWindowsPathPrivate(root, true);
			mkdirSync(child, { recursive: true });
			execFileSync("icacls.exe", [parent, "/grant", "*S-1-5-32-545:(DC)"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			expect(() => assertWindowsPathAncestorsTrusted(child, true)).toThrow(
				"Windows path or ancestor is controlled by an untrusted principal",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces PowerShell stderr for invalid paths", () => {
		const root = mkdtempSync(join(homedir(), "pk-acl-missing-"));
		try {
			expect(() => assertWindowsPathPrivate(join(root, "missing"), false)).toThrow(
				/Windows security command failed: .+/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
