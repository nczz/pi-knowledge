import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../index.ts";
import { KnowledgeDaemonClient } from "../../src/daemon/client.ts";
import { canonicalizeAllowedRoots, McpStdioAdapter, parseMcpArguments } from "../../src/mcp/server.ts";
import type { KnowledgeProfile } from "../../src/profiles.ts";
import { isObjectRecord } from "../../src/type-guards.ts";

const tempDirs: string[] = [];

function profile(): KnowledgeProfile {
	return {
		name: "default",
		id: "mcp-test-profile",
		storageDir: "/tmp/mcp-test-profile",
		runtimeDir: "/tmp/mcp-test-profile/.runtime",
		profileRoot: "/tmp",
		registryPath: "/tmp/mcp-test-profiles.json",
	};
}

function tool(name: string, approval: "read" | "write" = "read", execute?: ToolDefinition["execute"]): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		approval,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute,
	};
}

async function runAdapter(
	lines: Array<Record<string, unknown> | string>,
	tools: ToolDefinition[],
	options: { allowRoots?: string[]; allowNetwork?: boolean; allowWrite?: boolean; allowAdmin?: boolean } = {},
): Promise<Record<string, unknown>[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	const error = new PassThrough();
	let stdout = "";
	let stderr = "";
	output.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	error.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const selectedProfile = profile();
	const adapter = new McpStdioAdapter({
		profile: selectedProfile,
		client: new KnowledgeDaemonClient(selectedProfile),
		tools,
		input,
		output,
		error,
		serverVersion: "test",
		profileName: "default",
		allowRoots: options.allowRoots ?? [],
		allowNetwork: options.allowNetwork ?? false,
		allowWrite: options.allowWrite ?? false,
		allowAdmin: options.allowAdmin ?? false,
	});
	const run = adapter.run();
	input.end(`${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
	await run;
	if (stderr) throw new Error(stderr);
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resultFor(messages: Record<string, unknown>[], id: string | number): Record<string, unknown> {
	const message = messages.find((candidate) => candidate.id === id);
	if (!message) throw new Error(`Missing response ${String(id)}`);
	return message;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("MCP stdio adapter", () => {
	it("parses profile and capability flags strictly", () => {
		expect(
			parseMcpArguments([
				"--profile",
				"research",
				"--allow-root",
				"/one",
				"--allow-root",
				"/two",
				"--allow-network",
				"--allow-write",
				"--allow-admin",
			]),
		).toEqual({
			profileName: "research",
			allowRoots: ["/one", "/two"],
			allowNetwork: true,
			allowWrite: true,
			allowAdmin: true,
			transport: "stdio",
			httpHost: "127.0.0.1",
			httpPort: 3210,
			httpEndpoint: "/mcp",
			allowOrigins: [],
		});
		expect(
			parseMcpArguments([
				"--transport",
				"http",
				"--host",
				"localhost",
				"--port",
				"9876",
				"--endpoint",
				"/knowledge",
				"--allow-origin",
				"https://agent.example",
			]),
		).toMatchObject({
			transport: "http",
			httpHost: "localhost",
			httpPort: 9876,
			httpEndpoint: "/knowledge",
			allowOrigins: ["https://agent.example"],
		});
		expect(() => parseMcpArguments(["--host", "127.0.0.1"])).toThrow("require --transport http");
		expect(() => parseMcpArguments(["--transport", "http", "--host", "0.0.0.0"])).toThrow(
			"--host must be 127.0.0.1, ::1, or localhost",
		);
		expect(() => parseMcpArguments(["--unknown"])).toThrow("Unknown MCP option");
	});

	it("exposes only profile read tools by default through legacy initialize", async () => {
		const names = [
			"knowledge_plan",
			"knowledge_configure",
			"knowledge_add",
			"knowledge_search",
			"knowledge_symbol_search",
			"knowledge_update",
			"knowledge_status",
			"knowledge_doctor",
			"knowledge_show",
			"knowledge_remove",
			"knowledge_export",
			"knowledge_import",
			"knowledge_clear",
		];
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			],
			names.map((name) => tool(name, name.includes("search") || name.endsWith("status") ? "read" : "write")),
		);
		expect(resultFor(messages, 1)).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
		const list = resultFor(messages, 2);
		expect(list).toMatchObject({
			result: {
				tools: [{ name: "knowledge_search" }, { name: "knowledge_symbol_search" }, { name: "knowledge_show" }],
			},
		});
	});

	it("supports modern discovery, progress, and per-request metadata", async () => {
		const search = tool("knowledge_search", "read", async (_id, _params, signal, onUpdate) => {
			if (signal?.aborted) throw new Error("Cancelled");
			onUpdate?.({ content: [{ type: "text", text: "Searching" }] });
			return { content: [{ type: "text", text: "Found" }] };
		});
		const messages = await runAdapter(
			[
				{
					jsonrpc: "2.0",
					id: "discover",
					method: "server/discover",
					params: {
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				},
				{
					jsonrpc: "2.0",
					id: "list",
					method: "tools/list",
					params: {
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				},
				{
					jsonrpc: "2.0",
					id: "search",
					method: "tools/call",
					params: {
						name: "knowledge_search",
						arguments: { query: "x" },
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							progressToken: "p1",
						},
					},
				},
			],
			[search],
		);
		expect(resultFor(messages, "discover")).toMatchObject({
			result: {
				resultType: "complete",
				supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
				ttlMs: 300_000,
				cacheScope: "private",
				_meta: {
					"io.modelcontextprotocol/serverInfo": { name: "pi-knowledge", version: "test" },
					"com.pi-knowledge/profile": "default",
				},
			},
		});
		expect(resultFor(messages, "list")).toMatchObject({
			result: {
				resultType: "complete",
				ttlMs: 300_000,
				cacheScope: "private",
				tools: [{ name: "knowledge_search" }],
			},
		});
		expect(messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "p1", progress: 1, message: "Searching" },
		});
		expect(resultFor(messages, "search")).toMatchObject({
			result: {
				resultType: "complete",
				content: [{ type: "text", text: "Found" }],
				_meta: { "com.pi-knowledge/profile": "default" },
			},
		});
	});

	it("maps cancellation to the active tool AbortSignal", async () => {
		const search = tool("knowledge_search", "read", async (_id, _params, signal) => {
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Cancelled"));
					return;
				}
				signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
			});
			return { content: [{ type: "text", text: "unreachable" }] };
		});
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
				{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_search", arguments: {} } },
				{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
			],
			[search],
		);
		expect(resultFor(messages, 2)).toMatchObject({
			result: { content: [{ type: "text", text: "Cancelled" }], isError: true },
		});
	});

	it("opens plan and mutations only through explicit capabilities", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-mcp-root-"));
		tempDirs.push(root);
		const roots = canonicalizeAllowedRoots([root]);
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } },
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			],
			[
				tool("knowledge_plan"),
				tool("knowledge_add", "write"),
				tool("knowledge_update", "write"),
				tool("knowledge_import", "write"),
				tool("knowledge_export", "write"),
				tool("knowledge_status"),
				tool("knowledge_doctor"),
				tool("knowledge_remove", "write"),
				tool("knowledge_clear", "write"),
				tool("knowledge_configure", "write"),
			],
			{ allowRoots: roots, allowWrite: true, allowAdmin: true },
		);
		const response = resultFor(messages, 1);
		expect(response).toMatchObject({
			result: {
				tools: [
					{ name: "knowledge_plan" },
					{ name: "knowledge_add" },
					{ name: "knowledge_update" },
					{ name: "knowledge_import" },
					{ name: "knowledge_export" },
					{ name: "knowledge_status" },
					{ name: "knowledge_doctor" },
					{ name: "knowledge_remove" },
					{ name: "knowledge_clear" },
					{ name: "knowledge_configure" },
				],
			},
		});
	});

	it("executes local tools with canonical arguments and daemon-side access policy", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-mcp-access-"));
		tempDirs.push(root);
		const source = join(root, "source.md");
		writeFileSync(source, "content");
		const roots = canonicalizeAllowedRoots([root]);
		const canonicalSource = join(roots[0] ?? root, "source.md");
		const execute = vi.fn<NonNullable<ToolDefinition["execute"]>>(async (_id, params, _signal, _update, context) => {
			expect(params.source).toBe(canonicalSource);
			expect(context?.filesystemAccess).toEqual({ allowedRoots: roots, allowNetwork: false });
			return { content: [{ type: "text", text: "ok" }] };
		});
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "knowledge_add", arguments: { source, name: "test" } },
				},
			],
			[tool("knowledge_add", "write", execute)],
			{ allowRoots: roots, allowWrite: true },
		);
		expect(resultFor(messages, 2)).toMatchObject({ result: { content: [{ text: "ok" }] } });
		expect(execute).toHaveBeenCalledOnce();
	});

	it("resolves update targets by ID before name and executes the immutable ID", async () => {
		const root = mkdtempSync(join(tmpdir(), "pk-mcp-update-"));
		tempDirs.push(root);
		const localSource = join(root, "source.md");
		writeFileSync(localSource, "content");
		vi.spyOn(KnowledgeDaemonClient.prototype, "list").mockResolvedValue([
			{
				id: "local-id",
				name: "url-id",
				description: null,
				source_path: localSource,
				source_type: "file",
				source_options: null,
				created_at: 1,
				updated_at: 2,
				indexed_at: 2,
				chunk_count: 1,
				file_count: 1,
				embedding_model: "test",
				embedding_signature: null,
				embedding_dimension: null,
				status: "ready",
			},
			{
				id: "url-id",
				name: "remote",
				description: null,
				source_path: "https://example.test",
				source_type: "url",
				source_options: null,
				created_at: 1,
				updated_at: 1,
				indexed_at: 1,
				chunk_count: 1,
				file_count: 1,
				embedding_model: "test",
				embedding_signature: null,
				embedding_dimension: null,
				status: "ready",
			},
		]);
		const execute = vi.fn<NonNullable<ToolDefinition["execute"]>>(async () => ({
			content: [{ type: "text", text: "unreachable" }],
		}));
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "knowledge_update", arguments: { target: "url-id" } },
				},
			],
			[tool("knowledge_update", "write", execute)],
			{ allowRoots: canonicalizeAllowedRoots([root]), allowWrite: true },
		);
		expect(resultFor(messages, 2)).toMatchObject({
			result: { content: [{ text: "Updating this URL knowledge base requires --allow-network" }], isError: true },
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("returns valid tool execution failures as MCP tool errors", async () => {
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
				{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_search", arguments: {} } },
			],
			[
				tool("knowledge_search", "read", async () => {
					throw new Error("search failed");
				}),
			],
		);
		expect(resultFor(messages, 2)).toMatchObject({
			result: { content: [{ type: "text", text: "search failed" }], isError: true },
		});
	});

	it("returns one bounded overload error and closes cleanly for a request burst", async () => {
		const blockingSearch = tool("knowledge_search", "read", async (_id, _params, signal) => {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("Cancelled");
		});
		const calls = Array.from({ length: 20 }, (_, index) => ({
			jsonrpc: "2.0",
			id: index + 2,
			method: "tools/call",
			params: { name: "knowledge_search", arguments: {} },
		}));
		const messages = await runAdapter(
			[{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, ...calls],
			[blockingSearch],
		);

		expect(messages.some((message) => isObjectRecord(message.error) && message.error.code === -32000)).toBe(true);
	});

	it("closes cleanly when malformed input arrives during overload", async () => {
		const blockingSearch = tool("knowledge_search", "read", async (_id, _params, signal) => {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("Cancelled");
		});
		const calls = Array.from({ length: 16 }, (_, index) => ({
			jsonrpc: "2.0",
			id: index + 2,
			method: "tools/call",
			params: { name: "knowledge_search", arguments: {} },
		}));
		const messages = await runAdapter(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
				...calls,
				"{malformed",
			],
			[blockingSearch],
		);

		expect(
			messages.some(
				(message) => isObjectRecord(message.error) && (message.error.code === -32700 || message.error.code === -32000),
			),
		).toBe(true);
	});

	it("bounds EOF cleanup when stdout never drains", async () => {
		vi.useFakeTimers();
		class StalledWritable extends Writable {
			override _write(_chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {}
		}
		const input = new PassThrough();
		const output = new StalledWritable({ highWaterMark: 1 });
		const selectedProfile = profile();
		const adapter = new McpStdioAdapter({
			profile: selectedProfile,
			client: new KnowledgeDaemonClient(selectedProfile),
			tools: [],
			input,
			output,
			error: new PassThrough(),
			serverVersion: "test",
			profileName: "default",
			allowRoots: [],
			allowNetwork: false,
			allowWrite: false,
			allowAdmin: false,
		});
		const run = adapter.run();
		const rejected = expect(run).rejects.toThrow("timed out while draining output");
		input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
		await vi.advanceTimersByTimeAsync(5_001);
		await rejected;
		expect(output.destroyed).toBe(true);
		vi.useRealTimers();
	});
});
