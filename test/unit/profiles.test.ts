import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKnowledgeProfile, selectedProfileName } from "../../src/profiles.ts";

const tempDirs: string[] = [];

function makeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "pk-profile-"));
	tempDirs.push(home);
	return home;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("knowledge profiles", () => {
	it("uses one default profile unless a named profile is selected", () => {
		const homeDir = makeHome();
		const env = {};
		const defaultProfile = resolveKnowledgeProfile("default", { env, homeDir });
		const namedProfile = resolveKnowledgeProfile("research", { env, homeDir });

		expect(defaultProfile.storageDir).toBe(realpathSync.native(join(homeDir, ".pi-knowledge", "profiles", "default")));
		expect(namedProfile.storageDir).toBe(realpathSync.native(join(homeDir, ".pi-knowledge", "profiles", "research")));
		expect(namedProfile.id).not.toBe(defaultProfile.id);
		expect(selectedProfileName({ PI_KNOWLEDGE_PROFILE: "research" })).toBe("research");
	});

	it("keeps default identity stable when only the named-profile root changes", () => {
		const homeDir = makeHome();
		const first = resolveKnowledgeProfile("default", { env: {}, homeDir });
		const second = resolveKnowledgeProfile("default", {
			env: { PI_KNOWLEDGE_PROFILE_ROOT: join(homeDir, "advanced-profiles") },
			homeDir,
		});
		const named = resolveKnowledgeProfile("advanced", {
			env: { PI_KNOWLEDGE_PROFILE_ROOT: join(homeDir, "advanced-profiles") },
			homeDir,
		});

		expect(second.storageDir).toBe(first.storageDir);
		expect(second.registryPath).toBe(first.registryPath);
		expect(named.storageDir).toBe(realpathSync.native(join(homeDir, "advanced-profiles", "advanced")));
	});

	it("adopts the only existing legacy database for the default profile", () => {
		const homeDir = makeHome();
		const legacy = join(homeDir, ".pi", "knowledge");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "knowledge.db"), "legacy");

		const profile = resolveKnowledgeProfile("default", { env: {}, homeDir });
		expect(profile.storageDir).toBe(realpathSync.native(legacy));

		const repeated = resolveKnowledgeProfile("default", { env: {}, homeDir });
		expect(repeated.storageDir).toBe(realpathSync.native(legacy));
	});

	it("fails closed when multiple legacy databases make migration ambiguous", () => {
		const homeDir = makeHome();
		for (const host of [".pi", ".omp"]) {
			const storage = join(homeDir, host, "knowledge");
			mkdirSync(storage, { recursive: true });
			writeFileSync(join(storage, "knowledge.db"), host);
		}

		expect(() => resolveKnowledgeProfile("default", { env: {}, homeDir })).toThrow(
			"Multiple legacy knowledge databases",
		);
	});

	it("preserves Pi host-directory precedence when both host variables are set", () => {
		const homeDir = makeHome();
		const piAgent = join(homeDir, "pi-host", "agent");
		const ompAgent = join(homeDir, "omp-host", "agent");
		for (const storage of [join(homeDir, "pi-host", "knowledge"), join(homeDir, "omp-host", "knowledge")]) {
			mkdirSync(storage, { recursive: true });
			writeFileSync(join(storage, "knowledge.db"), storage);
		}

		const profile = resolveKnowledgeProfile("default", {
			env: { PI_CODING_AGENT_DIR: piAgent, OMP_CODING_AGENT_DIR: ompAgent },
			homeDir,
		});
		expect(profile.storageDir).toBe(realpathSync.native(join(homeDir, "pi-host", "knowledge")));
	});

	it("rejects a registry whose permissions allow another user to read it", () => {
		const homeDir = makeHome();
		const profile = resolveKnowledgeProfile("default", { env: {}, homeDir });
		chmodSync(profile.registryPath, 0o644);

		expect(() => resolveKnowledgeProfile("default", { env: {}, homeDir })).toThrow("permissions are too broad");
	});

	it.skipIf(process.platform === "win32")("rejects named profiles backed by symbolic links", () => {
		const homeDir = makeHome();
		const root = join(homeDir, ".pi-knowledge", "profiles");
		const target = join(homeDir, "target");
		mkdirSync(root, { recursive: true });
		mkdirSync(target);
		symlinkSync(target, join(root, "linked"));

		expect(() => resolveKnowledgeProfile("linked", { env: {}, homeDir })).toThrow("cannot be a symbolic link");
	});

	it.skipIf(process.platform === "win32")("rejects case-fold collisions in a named profile root", () => {
		const homeDir = makeHome();
		const root = join(homeDir, ".pi-knowledge", "profiles");
		mkdirSync(join(root, "Research"), { recursive: true });

		expect(() => resolveKnowledgeProfile("research", { env: {}, homeDir })).toThrow("case-variant");
	});

	it.skipIf(process.platform === "win32")("rejects a case-fold collision for managed default storage", () => {
		const homeDir = makeHome();
		const root = join(homeDir, ".pi-knowledge", "profiles");
		mkdirSync(join(root, "Default"), { recursive: true });

		expect(() => resolveKnowledgeProfile("default", { env: {}, homeDir })).toThrow("case-variant");
	});

	it("keeps explicit storage overrides limited to the default profile", () => {
		const homeDir = makeHome();
		const storage = join(homeDir, "explicit");
		const env = { PI_KNOWLEDGE_DIR: storage };

		expect(resolveKnowledgeProfile("default", { env, homeDir }).storageDir).toBe(realpathSync.native(storage));
		expect(() => resolveKnowledgeProfile("other", { env, homeDir })).toThrow("can only override the default");
	});

	it.skipIf(process.platform === "win32")("hardens an existing explicit storage directory to owner-only", () => {
		const homeDir = makeHome();
		const storage = join(homeDir, "explicit-shared");
		mkdirSync(storage, { mode: 0o755 });
		chmodSync(storage, 0o755);

		const profile = resolveKnowledgeProfile("default", { env: { PI_KNOWLEDGE_DIR: storage }, homeDir });

		expect(profile.storageDir).toBe(realpathSync.native(storage));
		expect(statSync(storage).mode & 0o077).toBe(0);
	});

	it("rejects non-canonical and reserved profile names", () => {
		const homeDir = makeHome();
		for (const name of ["Team", "../escape", "con", "name.with-dot", ""]) {
			expect(() => resolveKnowledgeProfile(name, { env: {}, homeDir })).toThrow("Invalid knowledge profile name");
		}
	});
});
