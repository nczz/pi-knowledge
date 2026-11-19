import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../index.ts";
import { KnowledgeDaemonClient } from "../../src/daemon/client.ts";
import { McpHttpServer, type McpHttpServerOptions } from "../../src/mcp/http.ts";
import { MODERN_MCP_PROTOCOL } from "../../src/mcp/protocol.ts";
import type { KnowledgeProfile } from "../../src/profiles.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const servers: McpHttpServer[] = [];

function profile(): KnowledgeProfile {
	return {
		name: "default",
		id: "mcp-http-test-profile",
		storageDir: "/tmp/mcp-http-test-profile",
		runtimeDir: "/tmp/mcp-http-test-profile/.runtime",
		profileRoot: "/tmp",
		registryPath: "/tmp/mcp-http-test-profiles.json",
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

function createHttpServer(
	tools: ToolDefinition[],
	overrides: Partial<Pick<McpHttpServerOptions, "host" | "authToken" | "allowedOrigins">> = {},
): McpHttpServer {
	const selectedProfile = profile();
	const server = new McpHttpServer({
		profile: selectedProfile,
		client: new KnowledgeDaemonClient(selectedProfile),
		tools,
		serverVersion: "test",
		allowRoots: [],
		allowNetwork: false,
		allowWrite: false,
		allowAdmin: false,
		host: "127.0.0.1",
		port: 0,
		endpoint: "/mcp",
		allowedOrigins: [],
		authToken: TOKEN,
		...overrides,
	});
	servers.push(server);
	return server;
}

function modernParams(values: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...values,
		_meta: {
			"io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL,
			"io.modelcontextprotocol/clientCapabilities": {},
			...(typeof values._meta === "object" && values._meta !== null ? values._meta : {}),
		},
	};
}

function commonHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${TOKEN}`,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
}

function mirrored(value: string): string {
	return `=?base64?${Buffer.from(value).toString("base64")}?=`;
}

async function modernPost(
	url: string,
	request: Record<string, unknown>,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<Response> {
	const method = String(request.method);
	const params = request.params as Record<string, unknown> | undefined;
	return fetch(url, {
		method: "POST",
		headers: {
			...commonHeaders(),
			"MCP-Protocol-Version": MODERN_MCP_PROTOCOL,
			"Mcp-Method": method,
			...(method === "tools/call" ? { "Mcp-Name": String(params?.name) } : {}),
			...headers,
		},
		body: JSON.stringify(request),
		signal,
	});
}

function sseMessages(body: string): Record<string, unknown>[] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.restoreAllMocks();
});

describe("MCP Streamable HTTP transport", () => {
	it("enforces loopback, bearer, Origin, and modern mirrored request contracts", async () => {
		expect(() => createHttpServer([], { host: "0.0.0.0" })).toThrow("must be 127.0.0.1, ::1, or localhost");
		expect(() => createHttpServer([], { authToken: "short" })).toThrow("32-512 visible ASCII");

		const server = createHttpServer([tool("knowledge_search")]);
		const address = await server.start();
		const discovery = {
			jsonrpc: "2.0",
			id: "discover",
			method: "server/discover",
			params: modernParams(),
		};
		const unauthorized = await fetch(address.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": MODERN_MCP_PROTOCOL,
				"Mcp-Method": "server/discover",
			},
			body: JSON.stringify(discovery),
		});
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

		const forbiddenOrigin = await modernPost(address.url, discovery, { Origin: "https://hostile.example" });
		expect(forbiddenOrigin.status).toBe(403);

		const unsupportedVersion = "2099-01-01";
		const unsupported = await modernPost(
			address.url,
			{
				...discovery,
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": unsupportedVersion,
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			},
			{ "MCP-Protocol-Version": unsupportedVersion },
		);
		expect(unsupported.status).toBe(400);
		expect(await unsupported.json()).toMatchObject({
			id: "discover",
			error: {
				code: -32022,
				data: {
					requested: unsupportedVersion,
					supported: [MODERN_MCP_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"],
				},
			},
		});

		const response = await modernPost(address.url, discovery, {
			"MCP-Protocol-Version": mirrored(MODERN_MCP_PROTOCOL),
			"Mcp-Method": mirrored("server/discover"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: "discover",
			result: {
				resultType: "complete",
				supportedVersions: [MODERN_MCP_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"],
				_meta: {
					"io.modelcontextprotocol/serverInfo": { name: "pi-knowledge", version: "test" },
					"com.pi-knowledge/profile": "default",
				},
			},
		});
	});

	it("streams modern tool progress and the final result over request-scoped SSE", async () => {
		const search = tool("knowledge_search", "read", async (_id, _params, signal, onUpdate) => {
			expect(signal?.aborted).toBe(false);
			onUpdate?.({ content: [{ type: "text", text: "Searching" }] });
			return { content: [{ type: "text", text: "Found" }] };
		});
		const server = createHttpServer([search, tool("knowledge_add", "write")]);
		const address = await server.start();
		const response = await modernPost(address.url, {
			jsonrpc: "2.0",
			id: "search",
			method: "tools/call",
			params: modernParams({
				name: "knowledge_search",
				arguments: { query: "x" },
				_meta: { progressToken: "progress-1" },
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const messages = sseMessages(await response.text());
		expect(messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "progress-1", progress: 1, message: "Searching" },
		});
		expect(messages).toContainEqual(
			expect.objectContaining({
				id: "search",
				result: expect.objectContaining({
					resultType: "complete",
					content: [{ type: "text", text: "Found" }],
				}),
			}),
		);
	});

	it("supports negotiated legacy sessions and explicit session termination", async () => {
		const server = createHttpServer([tool("knowledge_search"), tool("knowledge_add", "write")]);
		const address = await server.start();
		const initialized = await fetch(address.url, {
			method: "POST",
			headers: commonHeaders(),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
			}),
		});
		expect(initialized.status).toBe(200);
		const sessionId = initialized.headers.get("mcp-session-id");
		expect(sessionId).toBeTruthy();
		expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });

		const sessionHeaders = {
			...commonHeaders(),
			"MCP-Session-Id": sessionId ?? "",
			"MCP-Protocol-Version": "2025-11-25",
		};
		const listed = await fetch(address.url, {
			method: "POST",
			headers: sessionHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ result: { tools: [{ name: "knowledge_search" }] } });

		const removed = await fetch(address.url, { method: "DELETE", headers: sessionHeaders });
		expect(removed.status).toBe(204);
		const expired = await fetch(address.url, {
			method: "POST",
			headers: sessionHeaders,
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
		});
		expect(expired.status).toBe(404);
	});

	it("aborts modern work on stream disconnect and closes idempotently", async () => {
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const search = tool("knowledge_search", "read", async (_id, _params, signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "Started" }] });
			started.resolve();
			await new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted.resolve();
			throw new Error("Cancelled");
		});
		const server = createHttpServer([search]);
		const address = await server.start();
		const controller = new AbortController();
		const response = await modernPost(
			address.url,
			{
				jsonrpc: "2.0",
				id: "long-search",
				method: "tools/call",
				params: modernParams({ name: "knowledge_search", arguments: {}, _meta: { progressToken: "p" } }),
			},
			{},
			controller.signal,
		);
		await started.promise;
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		controller.abort();
		await aborted.promise;

		const firstClose = server.close();
		expect(server.close()).toBe(firstClose);
		await firstClose;
		await expect(server.waitUntilClosed()).resolves.toBeUndefined();
	});

	it("closes a listener when shutdown races startup", async () => {
		const server = createHttpServer([tool("knowledge_search")]);
		const starting = server.start();
		const firstClose = server.close();
		expect(server.close()).toBe(firstClose);
		await expect(starting).rejects.toThrow("closed during startup");
		await firstClose;
		await expect(server.waitUntilClosed()).resolves.toBeUndefined();
	});
});
