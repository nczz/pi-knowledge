import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultKnowledgeDir, resolveHostKnowledgeDir } from "../../src/storage/sqlite.ts";

describe("knowledge storage path", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses an explicit PI_KNOWLEDGE_DIR override", () => {
		vi.stubEnv("PI_KNOWLEDGE_DIR", "/tmp/custom-knowledge");
		vi.stubEnv("OMP_KNOWLEDGE_DIR", "/tmp/omp-knowledge");

		expect(getDefaultKnowledgeDir()).toBe("/tmp/custom-knowledge");
	});

	it("derives host storage from PI_CODING_AGENT_DIR", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/Users/example/.omp/agent");

		expect(getDefaultKnowledgeDir()).toBe(join(dirname("/Users/example/.omp/agent"), "knowledge"));
	});

	it("derives host storage from OMP_CODING_AGENT_DIR", () => {
		vi.stubEnv("OMP_CODING_AGENT_DIR", "/Users/example/.omp/work-agent");

		expect(getDefaultKnowledgeDir()).toBe(join(dirname("/Users/example/.omp/work-agent"), "knowledge"));
	});

	it("preserves an existing Pi knowledge dir only for the default home OMP root", () => {
		const hostRoot = join(homedir(), ".omp");
		const legacyPiDir = join(homedir(), ".pi", "knowledge");
		const exists = (path: string): boolean => path === legacyPiDir;

		expect(
			resolveHostKnowledgeDir(hostRoot, {
				legacyPiDir,
				exists,
			}),
		).toBe(legacyPiDir);
		expect(
			resolveHostKnowledgeDir("/tmp/project/.omp", {
				legacyPiDir: "/home/me/.pi/knowledge",
				exists,
			}),
		).toBe("/tmp/project/.omp/knowledge");
	});

	it("keeps the existing Pi storage root by default", () => {
		vi.stubEnv("OMP_PROFILE", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		vi.stubEnv("PI_KNOWLEDGE_DIR", "");
		vi.stubEnv("OMP_KNOWLEDGE_DIR", "");

		expect(getDefaultKnowledgeDir()).toMatch(/[/\\]\.pi[/\\]knowledge$/);
	});
});
