import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type JsonRpcRequest,
	type JsonRpcResponseId,
	MAX_MCP_CONCURRENT_REQUESTS,
	MAX_MCP_INPUT_BYTES,
	MAX_MCP_OUTPUT_BYTES,
	MAX_MCP_OUTPUT_QUEUE_BYTES,
	MCP_SHUTDOWN_TIMEOUT_MS,
	type McpHandledMessage,
	McpProtocolError,
	McpProtocolSession,
	type McpServerOptions,
	mcpErrorMessage,
	mcpRpcError,
	modernProtocolVersion,
	parseMcpRequest,
	validateModernRequestMetadata,
} from "./protocol.ts";

const MAX_HTTP_SESSIONS = 128;
const LEGACY_SESSION_IDLE_MS = 30 * 60 * 1_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

interface LegacyHttpSession {
	session: McpProtocolSession;
	lastUsed: number;
}

export interface McpHttpServerOptions extends McpServerOptions {
	host: string;
	port: number;
	endpoint: string;
	allowedOrigins: string[];
	authToken: string;
}

export interface McpHttpAddress {
	host: string;
	port: number;
	endpoint: string;
	url: string;
}

class HttpRequestError extends Error {
	readonly status: number;
	readonly response: Record<string, unknown>;

	constructor(status: number, code: number, message: string, data?: unknown, id: JsonRpcResponseId = null) {
		super(message);
		this.name = "HttpRequestError";
		this.status = status;
		this.response = mcpRpcError(id, code, message, data);
	}
}

function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function hostForUrl(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function mediaTypes(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((part) => part.split(";", 1)[0]?.trim().toLowerCase())
			.filter((part): part is string => Boolean(part)),
	);
}

function secureTokenMatches(header: string | undefined, expected: string): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const actual = Buffer.from(header.slice("Bearer ".length));
	const target = Buffer.from(expected);
	return actual.byteLength === target.byteLength && timingSafeEqual(actual, target);
}

function decodeMirroredHeader(value: string): string {
	const sentinel = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
	if (!sentinel) {
		if (!/^[\x20-\x7e]+$/.test(value) || value !== value.trim()) {
			throw new HttpRequestError(400, -32020, "HeaderMismatch: invalid mirrored MCP header value");
		}
		return value;
	}
	const encoded = sentinel[1] ?? "";
	const decoded = Buffer.from(encoded, "base64");
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
		if (decoded.toString("base64") !== encoded || !text) throw new Error("Invalid mirrored value");
		return text;
	} catch {
		throw new HttpRequestError(400, -32020, "HeaderMismatch: invalid mirrored MCP base64 value");
	}
}

function writeSecurityHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendEmpty(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
	if (response.headersSent || response.destroyed) return;
	writeSecurityHeaders(response);
	response.writeHead(status, headers);
	response.end();
}

function sendJson(
	response: ServerResponse,
	status: number,
	value: Record<string, unknown>,
	headers: Record<string, string> = {},
): void {
	if (response.headersSent || response.destroyed) return;
	let body = JSON.stringify(value);
	if (Buffer.byteLength(body) > MAX_MCP_OUTPUT_BYTES) {
		status = 500;
		body = JSON.stringify(mcpRpcError(null, -32603, "MCP response exceeds the output frame limit"));
	}
	writeSecurityHeaders(response);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(Buffer.byteLength(body)),
		...headers,
	});
	response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const declared = headerValue(request, "content-length");
	if (declared !== undefined) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0) throw new HttpRequestError(400, -32600, "Invalid Content-Length");
		if (length > MAX_MCP_INPUT_BYTES) throw new HttpRequestError(413, -32600, "MCP HTTP body exceeds the input limit");
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_MCP_INPUT_BYTES) {
			request.resume();
			throw new HttpRequestError(413, -32600, "MCP HTTP body exceeds the input limit");
		}
		chunks.push(buffer);
	}
	if (bytes === 0) throw new HttpRequestError(400, -32700, "MCP HTTP body is empty");
	try {
		return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
	} catch {
		throw new HttpRequestError(400, -32700, "Invalid JSON request body");
	}
}

class SseSink {
	private chain = Promise.resolve();
	private queuedBytes = 0;
	private failed: Error | undefined;
	private readonly response: ServerResponse;

	constructor(response: ServerResponse) {
		this.response = response;
		response.on("error", (error: Error) => {
			this.failed ??= error;
		});
	}

	start(): void {
		writeSecurityHeaders(this.response);
		this.response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Accel-Buffering": "no",
			Connection: "keep-alive",
		});
		this.response.flushHeaders();
	}

	private writeEvent(event: string): Promise<void> {
		if (this.failed) return Promise.reject(this.failed);
		if (this.response.destroyed || this.response.writableEnded) {
			return Promise.reject(new Error("MCP HTTP response stream is closed"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			this.response.off("drain", onDrain);
			this.response.off("error", onError);
			this.response.off("close", onClose);
			if (error) reject(error);
			else resolve();
		};
		const onDrain = (): void => finish();
		const onError = (error: Error): void => finish(error);
		const onClose = (): void => finish(new Error("MCP HTTP response stream closed before draining"));
		this.response.once("error", onError);
		this.response.once("close", onClose);
		if (this.response.write(event)) finish();
		else this.response.once("drain", onDrain);
		return promise;
	}

	send(message: Record<string, unknown>): Promise<void> {
		const event = `data: ${JSON.stringify(message)}\n\n`;
		const bytes = Buffer.byteLength(event);
		if (bytes > MAX_MCP_OUTPUT_BYTES) return Promise.reject(new Error("MCP SSE event exceeds the output frame limit"));
		if (this.failed) return Promise.reject(this.failed);
		if (this.queuedBytes + bytes > MAX_MCP_OUTPUT_QUEUE_BYTES) {
			this.failed = new Error("MCP SSE output queue is full");
			return Promise.reject(this.failed);
		}
		this.queuedBytes += bytes;
		const write = this.chain.then(() => this.writeEvent(event));
		this.chain = write
			.catch((error: unknown) => {
				this.failed ??= error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				this.queuedBytes -= bytes;
			});
		return write;
	}

	async finish(): Promise<void> {
		await this.chain;
		if (this.failed) throw this.failed;
		if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
	}
}

export class McpHttpServer {
	private readonly options: McpHttpServerOptions;
	private readonly server: Server;
	private readonly sessions = new Map<string, LegacyHttpSession>();
	private readonly requestSessions = new Set<McpProtocolSession>();
	private readonly operations = new Set<Promise<void>>();
	private activeRequests = 0;
	private accepting = false;
	private started = false;
	private closePromise: Promise<void> | undefined;
	private startWaiter: Promise<void> | undefined;
	private addressValue: McpHttpAddress | undefined;
	private readonly closedPromise: Promise<void>;
	private readonly resolveClosed: () => void;
	private readonly rejectClosed: (error: Error) => void;

	constructor(options: McpHttpServerOptions) {
		if (!isLoopbackHost(options.host)) throw new Error("MCP HTTP host must be 127.0.0.1, ::1, or localhost");
		if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
			throw new Error("MCP HTTP port must be an integer from 0 to 65535");
		}
		if (!options.endpoint.startsWith("/") || options.endpoint.startsWith("//") || /[?#\s]/.test(options.endpoint)) {
			throw new Error("MCP HTTP endpoint must be one absolute path without query or fragment");
		}
		if (!/^[\x21-\x7e]{32,512}$/.test(options.authToken)) {
			throw new Error("PI_KNOWLEDGE_MCP_HTTP_TOKEN must contain 32-512 visible ASCII characters");
		}
		this.options = options;
		const closed = Promise.withResolvers<void>();
		this.closedPromise = closed.promise;
		this.resolveClosed = closed.resolve;
		this.rejectClosed = closed.reject;
		this.server = createServer((request, response) => {
			const operation = this.handleHttpRequest(request, response).catch((error: unknown) => {
				this.options.onError?.(error);
				if (!response.headersSent) sendJson(response, 500, mcpRpcError(null, -32603, "Internal MCP server error"));
				else if (!response.destroyed) response.destroy();
			});
			this.operations.add(operation);
			void operation.finally(() => this.operations.delete(operation));
		});
		this.server.maxConnections = 64;
		this.server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
		this.server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
		this.server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
		this.server.on("close", () => this.resolveClosed());
		this.server.on("error", (error: Error) => {
			if (this.accepting) this.rejectClosed(error);
		});
	}

	get address(): McpHttpAddress | undefined {
		return this.addressValue;
	}

	private serverOptions(): McpServerOptions {
		return {
			profile: this.options.profile,
			client: this.options.client,
			tools: this.options.tools,
			serverVersion: this.options.serverVersion,
			allowRoots: this.options.allowRoots,
			allowNetwork: this.options.allowNetwork,
			allowWrite: this.options.allowWrite,
			allowAdmin: this.options.allowAdmin,
			onError: this.options.onError,
		};
	}

	private pruneSessions(now = Date.now()): void {
		for (const [id, entry] of this.sessions) {
			if (entry.session.activeRequestCount === 0 && now - entry.lastUsed > LEGACY_SESSION_IDLE_MS) {
				entry.session.abortAll();
				this.sessions.delete(id);
			}
		}
	}

	private validateOrigin(request: IncomingMessage): void {
		const origin = headerValue(request, "origin");
		if (!origin) return;
		const ownOrigin = this.addressValue ? new URL(this.addressValue.url).origin : undefined;
		if (origin !== ownOrigin && !this.options.allowedOrigins.includes(origin)) {
			throw new HttpRequestError(403, -32600, "Forbidden Origin header");
		}
	}

	private validateCommonPostHeaders(request: IncomingMessage): void {
		const contentType = mediaTypes(headerValue(request, "content-type"));
		if (!contentType.has("application/json")) {
			throw new HttpRequestError(415, -32600, "Content-Type must be application/json");
		}
		const accept = mediaTypes(headerValue(request, "accept"));
		if (!accept.has("application/json") || !accept.has("text/event-stream")) {
			throw new HttpRequestError(406, -32600, "Accept must include application/json and text/event-stream");
		}
	}

	private validateModernHeaders(request: IncomingMessage, rpc: JsonRpcRequest): void {
		try {
			validateModernRequestMetadata(rpc.params ?? {});
		} catch (error) {
			if (!(error instanceof McpProtocolError)) throw error;
			throw new HttpRequestError(error.httpStatus ?? 400, error.code, error.message, error.data, rpc.id ?? null);
		}
		const version = modernProtocolVersion(rpc);
		const protocolHeader = headerValue(request, "mcp-protocol-version");
		if (protocolHeader === undefined || decodeMirroredHeader(protocolHeader) !== version) {
			throw new HttpRequestError(
				400,
				-32020,
				"HeaderMismatch: MCP-Protocol-Version does not match request metadata",
				undefined,
				rpc.id ?? null,
			);
		}
		const methodHeader = headerValue(request, "mcp-method");
		if (methodHeader === undefined || decodeMirroredHeader(methodHeader) !== rpc.method) {
			throw new HttpRequestError(
				400,
				-32020,
				"HeaderMismatch: Mcp-Method does not match request method",
				undefined,
				rpc.id ?? null,
			);
		}
		if (rpc.method === "tools/call") {
			const bodyName = rpc.params?.name;
			const nameHeader = headerValue(request, "mcp-name");
			if (typeof bodyName !== "string" || nameHeader === undefined || decodeMirroredHeader(nameHeader) !== bodyName) {
				throw new HttpRequestError(
					400,
					-32020,
					"HeaderMismatch: Mcp-Name does not match tool name",
					undefined,
					rpc.id ?? null,
				);
			}
		}
	}

	private validateLegacyVersion(request: IncomingMessage, entry: LegacyHttpSession): void {
		const header = headerValue(request, "mcp-protocol-version");
		if (header !== entry.session.legacyProtocolVersion) {
			throw new HttpRequestError(400, -32600, "MCP-Protocol-Version does not match the legacy session");
		}
	}

	private async executeProtocolRequest(
		response: ServerResponse,
		rpc: JsonRpcRequest,
		session: McpProtocolSession,
		modern: boolean,
	): Promise<McpHandledMessage> {
		const stream = rpc.id !== undefined && rpc.method === "tools/call";
		if (!stream) return session.handleRequest(rpc, async () => undefined);
		const abortController = new AbortController();
		let completed = false;
		const onClose = (): void => {
			if (!completed && modern) abortController.abort();
		};
		response.once("close", onClose);
		const sink = new SseSink(response);
		sink.start();
		try {
			const handled = await session.handleRequest(rpc, (message) => sink.send(message), abortController.signal);
			if (handled.response) await sink.send(handled.response);
			completed = true;
			await sink.finish();
			return handled;
		} finally {
			response.off("close", onClose);
		}
	}

	private async initializeLegacy(response: ServerResponse, rpc: JsonRpcRequest): Promise<void> {
		this.pruneSessions();
		if (this.sessions.size >= MAX_HTTP_SESSIONS) {
			throw new HttpRequestError(503, -32603, "MCP HTTP legacy session limit reached");
		}
		const session = new McpProtocolSession(this.serverOptions());
		const handled = await session.handleRequest(rpc, async () => undefined);
		if (!handled.response || !session.legacyProtocolVersion) {
			sendJson(
				response,
				handled.httpStatus ?? 400,
				handled.response ?? mcpRpcError(rpc.id ?? null, -32602, "Invalid initialize request"),
			);
			return;
		}
		const id = randomUUID();
		this.sessions.set(id, { session, lastUsed: Date.now() });
		sendJson(response, 200, handled.response, {
			"Mcp-Session-Id": id,
			"MCP-Protocol-Version": session.legacyProtocolVersion,
		});
	}

	private async handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
		this.validateCommonPostHeaders(request);
		const value = await readJsonBody(request);
		let rpc: JsonRpcRequest;
		try {
			rpc = parseMcpRequest(value);
		} catch (error) {
			const protocol = error instanceof McpProtocolError ? error : undefined;
			throw new HttpRequestError(protocol?.httpStatus ?? 400, protocol?.code ?? -32600, mcpErrorMessage(error));
		}
		const sessionId = headerValue(request, "mcp-session-id");
		if (rpc.method === "initialize") {
			if (sessionId)
				throw new HttpRequestError(
					400,
					-32600,
					"Initialize must not include MCP-Session-Id",
					undefined,
					rpc.id ?? null,
				);
			await this.initializeLegacy(response, rpc);
			return;
		}
		let session: McpProtocolSession;
		let modern = false;
		if (sessionId) {
			const entry = this.sessions.get(sessionId);
			if (!entry)
				throw new HttpRequestError(404, -32600, "Unknown or expired MCP-Session-Id", undefined, rpc.id ?? null);
			this.validateLegacyVersion(request, entry);
			entry.lastUsed = Date.now();
			session = entry.session;
		} else {
			this.validateModernHeaders(request, rpc);
			modern = true;
			session = new McpProtocolSession(this.serverOptions());
			this.requestSessions.add(session);
		}
		try {
			const handled = await this.executeProtocolRequest(response, rpc, session, modern);
			if (response.headersSent) return;
			if (!handled.response) {
				sendEmpty(response, 202);
				return;
			}
			sendJson(response, handled.httpStatus ?? 200, handled.response);
		} finally {
			if (modern) {
				session.abortAll();
				this.requestSessions.delete(session);
			}
		}
	}

	private deleteLegacySession(request: IncomingMessage, response: ServerResponse): void {
		const sessionId = headerValue(request, "mcp-session-id");
		if (!sessionId) throw new HttpRequestError(400, -32600, "MCP-Session-Id is required for DELETE");
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new HttpRequestError(404, -32600, "Unknown or expired MCP-Session-Id");
		this.validateLegacyVersion(request, entry);
		entry.session.abortAll();
		this.sessions.delete(sessionId);
		sendEmpty(response, 204);
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.accepting) throw new HttpRequestError(503, -32603, "MCP HTTP server is not accepting requests");
			if (request.url !== this.options.endpoint) throw new HttpRequestError(404, -32601, "MCP endpoint not found");
			this.validateOrigin(request);
			if (!secureTokenMatches(headerValue(request, "authorization"), this.options.authToken)) {
				writeSecurityHeaders(response);
				response.setHeader("WWW-Authenticate", 'Bearer realm="pi-knowledge-mcp"');
				throw new HttpRequestError(401, -32600, "Bearer authentication required");
			}
			if (this.activeRequests >= MAX_MCP_CONCURRENT_REQUESTS) {
				response.setHeader("Retry-After", "1");
				throw new HttpRequestError(429, -32603, "MCP HTTP request limit reached");
			}
			this.activeRequests++;
			try {
				if (request.method === "POST") await this.handlePost(request, response);
				else if (request.method === "DELETE") this.deleteLegacySession(request, response);
				else {
					response.setHeader("Allow", "POST, DELETE");
					throw new HttpRequestError(405, -32601, "Method not allowed");
				}
			} finally {
				this.activeRequests--;
			}
		} catch (error) {
			if (response.headersSent) {
				if (!response.destroyed && !response.writableEnded) response.destroy();
				return;
			}
			if (error instanceof HttpRequestError) sendJson(response, error.status, error.response);
			else throw error;
		}
	}

	async start(): Promise<McpHttpAddress> {
		if (this.started) throw new Error("MCP HTTP server is already started");
		if (this.closePromise) throw new Error("MCP HTTP server is closing");
		this.started = true;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onError = (error: Error): void => reject(error);
		this.server.once("error", onError);
		this.startWaiter = promise;
		this.server.listen(this.options.port, this.options.host, () => resolve());
		try {
			await promise;
		} catch (error) {
			this.started = false;
			throw error;
		} finally {
			this.server.off("error", onError);
		}
		if (this.closePromise) throw new Error("MCP HTTP server closed during startup");
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("MCP HTTP server did not publish a TCP address");
		const port = (address as AddressInfo).port;
		this.addressValue = {
			host: this.options.host,
			port,
			endpoint: this.options.endpoint,
			url: `http://${hostForUrl(this.options.host)}:${port}${this.options.endpoint}`,
		};
		this.accepting = true;
		return this.addressValue;
	}

	waitUntilClosed(): Promise<void> {
		return this.closedPromise;
	}

	private async closeInternal(): Promise<void> {
		for (const entry of this.sessions.values()) entry.session.abortAll();
		for (const session of this.requestSessions) session.abortAll();
		this.sessions.clear();
		await this.startWaiter?.catch(() => {});
		if (!this.started || !this.server.listening) {
			this.resolveClosed();
			return;
		}
		const serverClosed = new Promise<void>((resolve) => {
			this.server.close(() => resolve());
		});
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), MCP_SHUTDOWN_TIMEOUT_MS);
			timer.unref();
		});
		const closed = await Promise.race([serverClosed.then(() => true), timeout]);
		if (timer) clearTimeout(timer);
		if (!closed) {
			this.server.closeAllConnections();
			await serverClosed;
		}
		const operations = Promise.allSettled([...this.operations]);
		let operationTimer: NodeJS.Timeout | undefined;
		const operationTimeout = new Promise<void>((resolve) => {
			operationTimer = setTimeout(resolve, MCP_SHUTDOWN_TIMEOUT_MS);
			operationTimer.unref();
		});
		await Promise.race([operations, operationTimeout]);
		if (operationTimer) clearTimeout(operationTimer);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.accepting = false;
		const closing = Promise.withResolvers<void>();
		this.closePromise = closing.promise;
		void this.closeInternal().then(closing.resolve, closing.reject);
		return this.closePromise;
	}
}
