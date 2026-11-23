import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDaemonClient, KnowledgeDaemonClient } from "../../src/daemon/client.ts";
import { MAX_RPC_FRAME_BYTES } from "../../src/daemon/protocol.ts";
import {
	acquireDaemonOwnership,
	DaemonLockExistsError,
	daemonLockPath,
	daemonManifestPath,
	readDaemonManifest,
	releaseDaemonOwnership,
} from "../../src/daemon/runtime.ts";
import { DaemonAlreadyRunningError, ProfileDaemonServer } from "../../src/daemon/server.ts";
import { configureDaemonNodePath } from "../../src/node-runtime.ts";
import type { KnowledgeProfile } from "../../src/profiles.ts";
import { ProviderError } from "../../src/provider-errors.ts";
import { writeJsonAtomic } from "../../src/secure-files.ts";

const tempDirs: string[] = [];
const originalKnowledgeDir = process.env.PI_KNOWLEDGE_DIR;
const originalRuntimeDir = process.env.PI_KNOWLEDGE_RUNTIME_DIR;

function makeProfile(name = "default"): KnowledgeProfile {
	const root = mkdtempSync(join(tmpdir(), "pk-daemon-"));
	tempDirs.push(root);
	const storageDir = join(root, "storage");
	return {
		name,
		id: `test-${name}`,
		storageDir,
		runtimeDir: join(storageDir, ".runtime"),
		profileRoot: root,
		registryPath: join(root, "profiles.json"),
	};
}
function rawRequest(
	endpoint: string,
	frame: Record<string, unknown>,
	splitWithin?: string,
): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const socket = createConnection(endpoint);
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	socket.once("connect", () => {
		const payload = Buffer.from(`${JSON.stringify(frame)}\n`);
		const marker = splitWithin ? payload.indexOf(Buffer.from(splitWithin)) : -1;
		if (marker < 0) {
			socket.write(payload);
			return;
		}
		socket.write(payload.subarray(0, marker + 1));
		socket.write(payload.subarray(marker + 1));
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		socket.destroy();
		resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
	});
	socket.once("error", reject);
	socket.once("close", () => {
		if (!buffer.includes("\n")) reject(new Error("Daemon connection closed without a response"));
	});
	return promise;
}

afterEach(() => {
	if (originalKnowledgeDir === undefined) delete process.env.PI_KNOWLEDGE_DIR;
	else process.env.PI_KNOWLEDGE_DIR = originalKnowledgeDir;
	if (originalRuntimeDir === undefined) delete process.env.PI_KNOWLEDGE_RUNTIME_DIR;
	else process.env.PI_KNOWLEDGE_RUNTIME_DIR = originalRuntimeDir;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("profile daemon lifecycle", () => {
	it("serves one profile through a private manifest and releases ownership on shutdown", async () => {
		const profile = makeProfile();
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		const client = new KnowledgeDaemonClient(profile);

		expect(manifest.ready).toBe(true);
		expect(existsSync(daemonManifestPath(profile))).toBe(true);
		await expect(client.ping()).resolves.toMatchObject({
			ready: true,
			profile: { name: profile.name, id: profile.id },
			instance_id: manifest.instance_id,
		});
		await expect(client.status()).resolves.toMatchObject({
			profile: { name: profile.name, id: profile.id },
			storage_path: profile.storageDir,
		});
		await client.enableWatchers();
		expect(readDaemonManifest(profile)?.watcher_enabled).toBe(true);

		await expect(client.shutdown()).resolves.toEqual({ accepted: true });
		await server.waitUntilStopped();
		expect(existsSync(daemonManifestPath(profile))).toBe(false);
	});

	it("round-trips structured provider failures through daemon RPC", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:test-embedding");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "https://embedding.example/v1");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("provider overloaded", { status: 503, statusText: "Unavailable" })),
		);
		const profile = makeProfile("provider-error");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		try {
			const client = new KnowledgeDaemonClient(profile);
			let failure: unknown;
			try {
				await client.add("Provider error RPC fixture", "Provider Error RPC");
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ProviderError);
			expect(failure).toMatchObject({
				message: "OpenAI embedding API error: 503 provider overloaded",
				provider: "embedding",
				operation: "embed_documents",
				kind: "http",
				status: 503,
				providerFailure: {
					provider: "embedding",
					operation: "embed_documents",
					kind: "http",
					status: 503,
				},
			});
		} finally {
			await server.shutdown();
		}
	}, 30_000);

	it("exposes the active mutation owner through lightweight daemon ping", async () => {
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING", "openai:test-embedding");
		vi.stubEnv("PI_KNOWLEDGE_EMBEDDING_BASE_URL", "https://embedding.example/v1");
		const providerResponse = Promise.withResolvers<Response>();
		const fetchMock = vi.fn(() => providerResponse.promise);
		vi.stubGlobal("fetch", fetchMock);
		const profile = makeProfile("active-owner");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		try {
			const client = new KnowledgeDaemonClient(profile);
			const add = client.add("Active owner RPC fixture", "Active Owner RPC");
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

			await expect(client.ping()).resolves.toMatchObject({
				ready: true,
				active_mutations: [
					{
						id: expect.any(String),
						operation: "add",
						target: "Active Owner RPC",
						started_at: expect.any(Number),
					},
				],
			});

			providerResponse.resolve(new Response("provider overloaded", { status: 503, statusText: "Unavailable" }));
			await expect(add).rejects.toThrow("OpenAI embedding API error: 503 provider overloaded");
			await expect(client.ping()).resolves.toMatchObject({ active_mutations: [] });
		} finally {
			providerResponse.resolve(new Response("provider interrupted", { status: 503, statusText: "Unavailable" }));
			await server.shutdown();
		}
	}, 30_000);

	it("refuses a second live daemon for the same profile", async () => {
		const profile = makeProfile("singleton");
		const first = new ProfileDaemonServer(profile);
		const second = new ProfileDaemonServer(profile);
		await first.start();
		try {
			await expect(second.start()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
		} finally {
			await first.shutdown();
		}
	});

	it("never replaces an existing ownership path during election", () => {
		const profile = makeProfile("exclusive-lock");
		const lockPath = daemonLockPath(profile);
		mkdirSync(lockPath, { recursive: true });

		expect(() => acquireDaemonOwnership(profile)).toThrow(DaemonLockExistsError);
		expect(existsSync(lockPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("does not claim ownership when endpoint creation fails", () => {
		const profile = makeProfile("endpoint-failure");
		const shortRoot = mkdtempSync("/tmp/x");
		tempDirs.push(shortRoot);
		const invalidRuntimeRoot = join(shortRoot, "not-a-directory");
		writeFileSync(invalidRuntimeRoot, "blocked");
		process.env.PI_KNOWLEDGE_RUNTIME_DIR = invalidRuntimeRoot;

		expect(() => acquireDaemonOwnership(profile)).toThrow();
		expect(existsSync(daemonLockPath(profile))).toBe(false);
	});

	it("shares concurrent shutdown and removes readiness before yielding", async () => {
		const profile = makeProfile("shutdown");
		const server = new ProfileDaemonServer(profile);
		await server.start();

		const first = server.shutdown();
		const second = server.shutdown();
		expect(second).toBe(first);
		expect(readDaemonManifest(profile)?.ready).toBe(false);
		await first;
	});

	it("cancels startup before ownership can become ready when shutdown wins the race", async () => {
		const profile = makeProfile("startup-shutdown");
		const server = new ProfileDaemonServer(profile);

		const startup = server.start();
		const shutdown = server.shutdown();

		await expect(startup).rejects.toThrow("cancelled by shutdown");
		await shutdown;
		expect(existsSync(daemonManifestPath(profile))).toBe(false);
	});

	it("accepts concurrent authenticated shutdown requests", async () => {
		const profile = makeProfile("rpc-shutdown");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		const client = new KnowledgeDaemonClient(profile);

		const results = await Promise.all([client.shutdown(), client.shutdown()]);
		expect(results).toEqual([{ accepted: true }, { accepted: true }]);
		await server.waitUntilStopped();
	});

	it("keeps authenticated shutdown reachable when idle peers occupy reserved control candidates", async () => {
		const profile = makeProfile("overload-shutdown");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		const sockets = Array.from({ length: 68 }, () => createConnection(manifest.endpoint));
		try {
			await Promise.all(
				sockets.map(
					(socket) =>
						new Promise<void>((resolve, reject) => {
							socket.once("connect", resolve);
							socket.once("error", reject);
						}),
				),
			);
			await expect(new KnowledgeDaemonClient(profile).shutdown()).resolves.toEqual({ accepted: true });
			await server.waitUntilStopped();
		} finally {
			for (const socket of sockets) socket.destroy();
			await server.shutdown();
		}
	});

	it("keeps serving after an oversized connection-local frame", async () => {
		const profile = makeProfile("oversized-frame");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		try {
			await new Promise<void>((resolve) => {
				const socket = createConnection(manifest.endpoint);
				socket.once("connect", () => socket.write(Buffer.alloc(MAX_RPC_FRAME_BYTES + 1, 0x61)));
				socket.once("close", () => resolve());
				socket.once("error", () => {});
			});
			await expect(new KnowledgeDaemonClient(profile).ping()).resolves.toMatchObject({ ready: true });
		} finally {
			await server.shutdown();
		}
	});

	it.skipIf(process.platform === "win32")(
		"uses a bounded Unix socket fallback when configured paths are too long",
		() => {
			const profile = makeProfile("socket-path");
			process.env.PI_KNOWLEDGE_RUNTIME_DIR = join(profile.profileRoot, "x".repeat(160));
			const ownership = acquireDaemonOwnership(profile);
			try {
				expect(Buffer.byteLength(ownership.owner.endpoint)).toBeLessThanOrEqual(96);
			} finally {
				releaseDaemonOwnership(profile, ownership, { removeEndpoint: false });
			}
		},
	);

	it("recovers an atomic pre-manifest lock only after its owner is dead", async () => {
		const profile = makeProfile("stale");
		const stale = acquireDaemonOwnership(profile);
		writeJsonAtomic(daemonLockPath(profile), {
			...stale.owner,
			pid: 999_999_999,
		});
		const server = new ProfileDaemonServer(profile);
		await server.start();
		try {
			expect((await new KnowledgeDaemonClient(profile).ping()).ready).toBe(true);
		} finally {
			await server.shutdown();
		}
	});

	it("serializes and enforces filesystem capabilities at the daemon boundary", async () => {
		const profile = makeProfile("filesystem-access");
		const allowedRoot = join(profile.profileRoot, "allowed");
		const source = join(allowedRoot, "source.md");
		mkdirSync(allowedRoot, { recursive: true });
		writeFileSync(source, "# Daemon access\n");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		try {
			const client = new KnowledgeDaemonClient(profile);
			await expect(
				client.plan(source, {}, undefined, { allowedRoots: [allowedRoot], allowNetwork: false }),
			).resolves.toMatchObject({ source_type: "file", scannable_files: 1 });
			await expect(
				client.plan(source, {}, undefined, {
					allowedRoots: [profile.storageDir],
					allowNetwork: false,
				}),
			).rejects.toThrow("outside the allowed filesystem roots");
		} finally {
			await server.shutdown();
		}
	});

	it("does not take over an unresponsive owner while its PID is alive", async () => {
		const profile = makeProfile("unresponsive");
		const ownership = acquireDaemonOwnership(profile);
		const server = new ProfileDaemonServer(profile);
		try {
			await expect(server.start()).rejects.toThrow("alive but unresponsive");
		} finally {
			releaseDaemonOwnership(profile, ownership, { removeEndpoint: false });
		}
	});

	it("rejects invalid credentials and package identities at the RPC boundary", async () => {
		const profile = makeProfile("authentication");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		try {
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "bad-token",
					token: "invalid",
					package_version: manifest.package_version,
					build_identity: manifest.build_identity,
					method: "ping",
					params: {},
				}),
			).resolves.toMatchObject({ type: "error", code: "unauthorized" });
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "bad-package",
					token: manifest.auth_token,
					package_version: "0.0.0-mismatch",
					build_identity: manifest.build_identity,
					method: "ping",
					params: {},
				}),
			).resolves.toMatchObject({ type: "error", code: "version_mismatch" });
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "bad-build",
					token: manifest.auth_token,
					package_version: manifest.package_version,
					build_identity: "mismatch",
					method: "ping",
					params: {},
				}),
			).resolves.toMatchObject({ type: "error", code: "build_mismatch" });
			await expect(
				rawRequest(
					manifest.endpoint,
					{
						type: "request",
						version: 1,
						id: "多位元請求",
						token: manifest.auth_token,
						package_version: manifest.package_version,
						build_identity: manifest.build_identity,
						method: "ping",
						params: {},
					},
					"多",
				),
			).resolves.toMatchObject({ type: "result", id: "多位元請求" });
		} finally {
			await server.shutdown();
		}
	});

	it("rejects clients whose engine configuration differs from the live daemon", async () => {
		const profile = makeProfile("configuration");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		const original = process.env.PI_KNOWLEDGE_RERANKER;
		try {
			process.env.PI_KNOWLEDGE_RERANKER = "hf:configuration-mismatch";
			await expect(ensureDaemonClient(profile)).rejects.toThrow("different runtime configuration");
		} finally {
			if (original === undefined) delete process.env.PI_KNOWLEDGE_RERANKER;
			else process.env.PI_KNOWLEDGE_RERANKER = original;
			await server.shutdown();
		}
	});

	it("keeps MCP transport credentials outside daemon configuration identity", async () => {
		const profile = makeProfile("mcp-transport-credential");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		const original = process.env.PI_KNOWLEDGE_MCP_HTTP_TOKEN;
		try {
			process.env.PI_KNOWLEDGE_MCP_HTTP_TOKEN = "0123456789abcdef0123456789abcdef";
			await expect(ensureDaemonClient(profile)).resolves.toBeInstanceOf(KnowledgeDaemonClient);
		} finally {
			if (original === undefined) delete process.env.PI_KNOWLEDGE_MCP_HTTP_TOKEN;
			else process.env.PI_KNOWLEDGE_MCP_HTTP_TOKEN = original;
			await server.shutdown();
		}
	});

	it("persists an explicit trusted Node runtime without opening the knowledge database", () => {
		const profile = makeProfile("bootstrap");
		const configured = configureDaemonNodePath(profile, process.execPath);

		expect(configured).toBe(process.execPath);
		expect(existsSync(join(profile.storageDir, "config.json"))).toBe(true);
		expect(existsSync(join(profile.storageDir, "knowledge.db"))).toBe(false);
	});

	it("rejects relative Node executable paths through the daemon configuration boundary", async () => {
		const profile = makeProfile("configure-policy");
		const server = new ProfileDaemonServer(profile);
		await server.start();
		try {
			await expect(new KnowledgeDaemonClient(profile).configure("node")).rejects.toThrow("must be an absolute path");
		} finally {
			await server.shutdown();
		}
	});

	it("rejects malformed node_path values instead of treating them as omitted", async () => {
		const profile = makeProfile("configure-shape");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		try {
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "bad-configure",
					token: manifest.auth_token,
					package_version: manifest.package_version,
					build_identity: manifest.build_identity,
					method: "configure",
					params: { node_path: 22 },
				}),
			).resolves.toMatchObject({ type: "error", code: "operation_failed", message: "Invalid node_path" });
		} finally {
			await server.shutdown();
		}
	});
	it("accepts authenticated shutdown across package and build identity changes", async () => {
		const profile = makeProfile("compatibility-retirement");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();

		await expect(
			rawRequest(manifest.endpoint, {
				type: "request",
				version: 1,
				id: "retire-old-build",
				token: manifest.auth_token,
				package_version: "next-version",
				build_identity: "next-build",
				method: "shutdown",
				params: {},
			}),
		).resolves.toMatchObject({ type: "result", result: { accepted: true } });
		await server.waitUntilStopped();
	});

	it("makes a server instance terminal after startup fails", async () => {
		const profile = makeProfile("failed-start-terminal");
		const owner = new ProfileDaemonServer(profile);
		const failed = new ProfileDaemonServer(profile);
		await owner.start();
		await expect(failed.start()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
		await owner.shutdown();

		await expect(failed.start()).rejects.toThrow("cannot restart after failed startup");
	});

	it("rejects inherited method names and oversized nested scan options", async () => {
		const profile = makeProfile("rpc-option-validation");
		const server = new ProfileDaemonServer(profile);
		const manifest = await server.start();
		try {
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "prototype-method",
					token: manifest.auth_token,
					package_version: manifest.package_version,
					build_identity: manifest.build_identity,
					method: "constructor",
					params: {},
				}),
			).resolves.toMatchObject({ type: "error", code: "invalid_request" });
			await expect(
				rawRequest(manifest.endpoint, {
					type: "request",
					version: 1,
					id: "oversized-options",
					token: manifest.auth_token,
					package_version: manifest.package_version,
					build_identity: manifest.build_identity,
					method: "plan",
					params: {
						source: profile.storageDir,
						options: { include_paths: Array.from({ length: 129 }, (_, index) => `src/${index}.ts`) },
					},
				}),
			).resolves.toMatchObject({
				type: "error",
				code: "operation_failed",
				message: "Invalid options.include_paths",
			});
		} finally {
			await server.shutdown();
		}
	});
});
