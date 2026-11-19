import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { assertOwnedDirectory } from "../secure-files.ts";
import { isObjectRecord } from "../type-guards.ts";
import {
	type JsonRpcRequest,
	type JsonRpcResponseId,
	MAX_MCP_CONCURRENT_REQUESTS,
	MAX_MCP_INPUT_BYTES,
	MAX_MCP_OUTPUT_BYTES,
	MAX_MCP_OUTPUT_QUEUE_BYTES,
	MCP_SHUTDOWN_TIMEOUT_MS,
	McpProtocolError,
	McpProtocolSession,
	type McpServerOptions,
	mcpErrorMessage,
	mcpRpcError,
	parseMcpRequest,
} from "./protocol.ts";

export type McpTransport = "stdio" | "http";

export interface McpCliOptions {
	profileName?: string;
	allowRoots: string[];
	allowNetwork: boolean;
	allowWrite: boolean;
	allowAdmin: boolean;
	transport: McpTransport;
	httpHost: string;
	httpPort: number;
	httpEndpoint: string;
	allowOrigins: string[];
}

interface McpAdapterOptions extends McpServerOptions {
	profileName?: string;
	input: Readable;
	output: Writable;
	error: Writable;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout(false), timeoutMs);
		timer.unref();
	});
	const settled = promise.then(
		() => true,
		() => true,
	);
	try {
		return await Promise.race([settled, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function parsePort(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 to 65535");
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new Error("--port must be an integer from 0 to 65535");
	}
	return port;
}

function normalizeEndpoint(value: string): string {
	if (!value.startsWith("/") || value.startsWith("//") || /[?#\s]/.test(value)) {
		throw new Error("--endpoint must be one absolute HTTP path without query or fragment");
	}
	return value;
}

function normalizeHost(value: string): string {
	if (value !== "127.0.0.1" && value !== "::1" && value !== "localhost") {
		throw new Error("--host must be 127.0.0.1, ::1, or localhost");
	}
	return value;
}

function normalizeOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid --allow-origin value: ${value}`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(`--allow-origin must be an HTTP origin without path, credentials, query, or fragment: ${value}`);
	}
	return parsed.origin;
}

export function parseMcpArguments(argv: string[]): McpCliOptions {
	const options: McpCliOptions = {
		allowRoots: [],
		allowNetwork: false,
		allowWrite: false,
		allowAdmin: false,
		transport: "stdio",
		httpHost: "127.0.0.1",
		httpPort: 3210,
		httpEndpoint: "/mcp",
		allowOrigins: [],
	};
	let transportSpecified = false;
	let httpOptionSpecified = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--allow-network") options.allowNetwork = true;
		else if (argument === "--allow-write") options.allowWrite = true;
		else if (argument === "--allow-admin") options.allowAdmin = true;
		else if (
			argument === "--profile" ||
			argument === "--allow-root" ||
			argument === "--transport" ||
			argument === "--host" ||
			argument === "--port" ||
			argument === "--endpoint" ||
			argument === "--allow-origin"
		) {
			const value = argv[index + 1];
			if (!value) throw new Error(`Missing value for ${argument}`);
			if (argument === "--profile") {
				if (options.profileName !== undefined) throw new Error("--profile can only be specified once");
				options.profileName = value;
			} else if (argument === "--allow-root") options.allowRoots.push(value);
			else if (argument === "--transport") {
				if (transportSpecified) throw new Error("--transport can only be specified once");
				if (value !== "stdio" && value !== "http") throw new Error("--transport must be stdio or http");
				options.transport = value;
				transportSpecified = true;
			} else if (argument === "--host") {
				options.httpHost = normalizeHost(value);
				httpOptionSpecified = true;
			} else if (argument === "--port") {
				options.httpPort = parsePort(value);
				httpOptionSpecified = true;
			} else if (argument === "--endpoint") {
				options.httpEndpoint = normalizeEndpoint(value);
				httpOptionSpecified = true;
			} else {
				options.allowOrigins.push(normalizeOrigin(value));
				httpOptionSpecified = true;
			}
			index++;
		} else throw new Error(`Unknown MCP option: ${argument}`);
	}
	if (options.transport === "stdio" && httpOptionSpecified) {
		throw new Error("--host, --port, --endpoint, and --allow-origin require --transport http");
	}
	options.allowOrigins = [...new Set(options.allowOrigins)].sort();
	return options;
}

export function canonicalizeAllowedRoots(paths: string[]): string[] {
	const roots = new Set<string>();
	for (const input of paths) {
		const absolute = resolve(input);
		if (!existsSync(absolute)) throw new Error(`Allowed root does not exist: ${absolute}`);
		if (lstatSync(absolute).isSymbolicLink()) {
			throw new Error(`Allowed root must be a canonical directory: ${absolute}`);
		}
		const canonical = realpathSync.native(absolute);
		assertOwnedDirectory(canonical);
		roots.add(canonical);
	}
	return [...roots].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

class OutputSink {
	private chain = Promise.resolve();
	private queuedBytes = 0;
	private fatalError: Error | undefined;
	private readonly output: Writable;
	private readonly onFatal: (error: Error) => void;

	constructor(output: Writable, onFatal: (error: Error) => void) {
		this.output = output;
		this.onFatal = onFatal;
		output.on("error", (error: Error) => this.fail(error));
		output.on("close", () => this.fail(new Error("MCP output closed")));
	}

	private fail(error: Error): void {
		if (this.fatalError) return;
		this.fatalError = error;
		this.onFatal(error);
	}

	private writeLine(line: string): Promise<void> {
		if (this.fatalError) return Promise.reject(this.fatalError);
		if (this.output.destroyed || this.output.writableEnded) return Promise.reject(new Error("MCP output is closed"));
		const { promise, resolve: resolveWrite, reject } = Promise.withResolvers<void>();
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			this.output.off("drain", onDrain);
			this.output.off("error", onError);
			this.output.off("close", onClose);
			if (error) reject(error);
			else resolveWrite();
		};
		const onDrain = (): void => finish();
		const onError = (error: Error): void => finish(error);
		const onClose = (): void => finish(new Error("MCP output closed before draining"));
		this.output.once("error", onError);
		this.output.once("close", onClose);
		if (this.output.write(line)) finish();
		else this.output.once("drain", onDrain);
		return promise;
	}

	send(value: unknown): Promise<void> {
		const line = `${JSON.stringify(value)}\n`;
		const bytes = Buffer.byteLength(line);
		if (bytes > MAX_MCP_OUTPUT_BYTES) return Promise.reject(new Error("MCP response exceeds the output frame limit"));
		if (this.fatalError) return Promise.reject(this.fatalError);
		if (this.queuedBytes + bytes > MAX_MCP_OUTPUT_QUEUE_BYTES) {
			const error = new Error("MCP output queue is full");
			this.fail(error);
			this.output.destroy(error);
			return Promise.reject(error);
		}
		this.queuedBytes += bytes;
		const write = this.chain.then(() => this.writeLine(line));
		this.chain = write
			.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))))
			.finally(() => {
				this.queuedBytes -= bytes;
			});
		return write;
	}

	abort(error: Error): void {
		this.fail(error);
		if (!this.output.destroyed) this.output.destroy(error);
	}

	async flush(): Promise<void> {
		await this.chain;
		if (this.fatalError) throw this.fatalError;
	}
}

export class McpStdioAdapter {
	private readonly output: OutputSink;
	private readonly session: McpProtocolSession;
	private readonly active = new Set<Promise<void>>();
	private readonly inputFrame = Buffer.allocUnsafe(MAX_MCP_INPUT_BYTES);
	private inputBytes = 0;
	private closing = false;
	private readonly options: McpAdapterOptions;
	private overloadResponse: Promise<void> | undefined;

	constructor(options: McpAdapterOptions) {
		this.options = options;
		this.output = new OutputSink(options.output, (error) => {
			this.closing = true;
			options.input.destroy(error);
		});
		this.session = new McpProtocolSession({
			...options,
			onError: (error) => this.logError(error),
		});
	}

	private async sendError(id: JsonRpcResponseId, code: number, message: string): Promise<void> {
		await this.output.send(mcpRpcError(id, code, message));
	}

	private logError(error: unknown): void {
		this.options.error.write(`${mcpErrorMessage(error)}\n`);
	}

	private async handleValue(value: unknown): Promise<void> {
		let request: JsonRpcRequest;
		try {
			request = parseMcpRequest(value);
		} catch (error) {
			const code = error instanceof McpProtocolError ? error.code : -32600;
			await this.sendError(null, code, mcpErrorMessage(error));
			return;
		}
		const handled = await this.session.handleRequest(request, (message) => this.output.send(message));
		if (handled.response) await this.output.send(handled.response);
	}

	private rejectOverload(id: JsonRpcResponseId, code: number, message: string): void {
		if (this.overloadResponse) {
			this.closing = true;
			this.options.input.destroy();
			return;
		}
		const operation = this.sendError(id, code, message);
		this.overloadResponse = operation;
		this.active.add(operation);
		void operation.then(
			() => {
				this.active.delete(operation);
				if (this.overloadResponse === operation) this.overloadResponse = undefined;
			},
			(error: unknown) => {
				this.active.delete(operation);
				if (this.overloadResponse === operation) this.overloadResponse = undefined;
				this.logError(error);
			},
		);
	}

	private acceptLine(line: Buffer): void {
		let value: unknown;
		try {
			value = JSON.parse(line.toString("utf8"));
		} catch (error) {
			if (this.active.size >= MAX_MCP_CONCURRENT_REQUESTS) {
				this.rejectOverload(null, -32700, mcpErrorMessage(error));
				return;
			}
			const operation = this.sendError(null, -32700, mcpErrorMessage(error));
			this.active.add(operation);
			void operation.then(
				() => this.active.delete(operation),
				(candidate: unknown) => {
					this.active.delete(operation);
					this.logError(candidate);
				},
			);
			return;
		}
		if (
			isObjectRecord(value) &&
			(value.method === "notifications/cancelled" || value.method === "notifications/initialized")
		) {
			void this.handleValue(value).catch((error: unknown) => this.logError(error));
			return;
		}
		if (this.active.size >= MAX_MCP_CONCURRENT_REQUESTS) {
			const id = isObjectRecord(value) && "id" in value ? value.id : null;
			const responseId = typeof id === "string" || typeof id === "number" ? id : null;
			this.rejectOverload(responseId, -32000, "MCP adapter request limit reached");
			return;
		}
		const operation = this.handleValue(value);
		this.active.add(operation);
		void operation.catch((error: unknown) => this.logError(error)).finally(() => this.active.delete(operation));
	}

	private consumeChunk(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.byteLength : newline;
			const part = chunk.subarray(offset, end);
			if (this.inputBytes + part.byteLength > MAX_MCP_INPUT_BYTES) {
				throw new Error("MCP input frame exceeds the configured limit");
			}
			part.copy(this.inputFrame, this.inputBytes);
			this.inputBytes += part.byteLength;
			if (newline < 0) return;
			const line = this.inputFrame.subarray(0, this.inputBytes);
			this.inputBytes = 0;
			if (line.toString("utf8").trim()) this.acceptLine(line);
			offset = newline + 1;
		}
	}

	async run(): Promise<void> {
		let terminalError: unknown;
		try {
			for await (const chunk of this.options.input) {
				if (this.closing) break;
				this.consumeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const remainder = this.inputFrame.subarray(0, this.inputBytes);
			if (remainder.toString("utf8").trim()) this.acceptLine(remainder);
		} catch (error) {
			terminalError = error;
		}
		this.closing = true;
		this.session.abortAll();
		const cleanup = Promise.allSettled([...this.active]).then(() => this.output.flush());
		if (!(await settlesWithin(cleanup, MCP_SHUTDOWN_TIMEOUT_MS))) {
			const error = new Error("MCP shutdown timed out while draining output");
			this.output.abort(error);
			void cleanup.catch(() => undefined);
			terminalError ??= error;
		} else {
			try {
				await cleanup;
			} catch (error) {
				terminalError ??= error;
			}
		}
		if (terminalError !== undefined) throw terminalError;
	}
}
