import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "../../index.ts";
import type { KnowledgeDaemonClient } from "../daemon/client.ts";
import type { KnowledgeProfile } from "../profiles.ts";
import { isObjectRecord } from "../type-guards.ts";

export const MODERN_MCP_PROTOCOL = "2026-07-28";
export const LEGACY_MCP_PROTOCOLS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"] as const);
export const SUPPORTED_MCP_PROTOCOLS = Object.freeze([MODERN_MCP_PROTOCOL, ...LEGACY_MCP_PROTOCOLS]);
export const MAX_MCP_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_OUTPUT_QUEUE_BYTES = 128 * 1024 * 1024;
export const MAX_MCP_CONCURRENT_REQUESTS = 16;
export const MCP_SHUTDOWN_TIMEOUT_MS = 5_000;

const MAX_PROGRESS_NOTIFICATIONS = 100;
const MAX_PROGRESS_MESSAGE_BYTES = 4 * 1024;
const MODERN_STATIC_LIST_TTL_MS = 5 * 60 * 1_000;
const READ_TOOL_NAMES = new Set(["knowledge_search", "knowledge_symbol_search", "knowledge_show"]);
const WRITE_TOOL_NAMES = new Set(["knowledge_add", "knowledge_update", "knowledge_import", "knowledge_export"]);
const ADMIN_TOOL_NAMES = new Set([
	"knowledge_configure",
	"knowledge_status",
	"knowledge_doctor",
	"knowledge_remove",
	"knowledge_clear",
]);

export type JsonRpcId = string | number;
export type JsonRpcResponseId = JsonRpcId | null;
export type McpProtocolEra = "legacy" | "modern";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
}

export interface McpServerOptions {
	profile: KnowledgeProfile;
	client: KnowledgeDaemonClient;
	tools: ToolDefinition[];
	serverVersion: string;
	allowRoots: string[];
	allowNetwork: boolean;
	allowWrite: boolean;
	allowAdmin: boolean;
	onError?: (error: unknown) => void;
}

export interface McpHandledMessage {
	request: JsonRpcRequest;
	era?: McpProtocolEra;
	response?: Record<string, unknown>;
	httpStatus?: number;
}

export type McpMessageEmitter = (message: Record<string, unknown>) => Promise<void>;

export class McpProtocolError extends Error {
	readonly code: number;
	readonly data?: unknown;
	readonly httpStatus?: number;

	constructor(code: number, message: string, options: { data?: unknown; httpStatus?: number } = {}) {
		super(message);
		this.name = "McpProtocolError";
		this.code = code;
		this.data = options.data;
		this.httpStatus = options.httpStatus;
	}
}

export function truncateMcpText(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	const suffix = "…";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
	const buffer = Buffer.from(value);
	let end = Math.min(buffer.byteLength, budget);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (end > 0) {
		try {
			return `${decoder.decode(buffer.subarray(0, end))}${suffix}`;
		} catch {
			end--;
		}
	}
	return suffix;
}

export function mcpErrorMessage(error: unknown): string {
	return truncateMcpText(error instanceof Error ? error.message : String(error), 4_096);
}

export function mcpRpcError(
	id: JsonRpcResponseId,
	code: number,
	message: string,
	data?: unknown,
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

export function parseMcpRequest(value: unknown): JsonRpcRequest {
	if (!isObjectRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
		throw new McpProtocolError(-32600, "Invalid JSON-RPC request", { httpStatus: 400 });
	}
	let id: JsonRpcId | undefined;
	if ("id" in value) {
		const rawId = value.id;
		if (typeof rawId !== "string" && typeof rawId !== "number") {
			throw new McpProtocolError(-32600, "Invalid JSON-RPC request id", { httpStatus: 400 });
		}
		id = rawId;
	}
	const params = value.params;
	if ("params" in value && params !== undefined && !isObjectRecord(params)) {
		throw new McpProtocolError(-32602, "Invalid JSON-RPC params", { httpStatus: 400 });
	}
	return {
		jsonrpc: "2.0",
		id,
		method: value.method,
		params: isObjectRecord(params) ? params : undefined,
	};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) throw new McpProtocolError(-32602, `Missing or invalid ${key}`);
	return value;
}

function requestKey(id: JsonRpcId): string {
	return `${typeof id}:${String(id)}`;
}

function isWithin(path: string, root: string): boolean {
	const relation = relative(root, path);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function validateModernRequestMetadata(params: Record<string, unknown>): Record<string, unknown> {
	const meta = params._meta;
	if (!isObjectRecord(meta)) {
		throw new McpProtocolError(-32602, "Modern MCP requests require params._meta", { httpStatus: 400 });
	}
	const version = meta["io.modelcontextprotocol/protocolVersion"];
	const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
	if (typeof version !== "string" || !isObjectRecord(capabilities)) {
		throw new McpProtocolError(-32602, "Modern MCP request metadata is incomplete", { httpStatus: 400 });
	}
	if (version !== MODERN_MCP_PROTOCOL) {
		throw new McpProtocolError(-32022, "Unsupported protocol version", {
			httpStatus: 400,
			data: { supported: [...SUPPORTED_MCP_PROTOCOLS], requested: version },
		});
	}
	const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
	if (
		clientInfo !== undefined &&
		(!isObjectRecord(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string")
	) {
		throw new McpProtocolError(-32602, "Invalid modern MCP clientInfo", { httpStatus: 400 });
	}
	return meta;
}

export function modernProtocolVersion(request: JsonRpcRequest): string | undefined {
	const meta = request.params?._meta;
	if (!isObjectRecord(meta)) return undefined;
	const version = meta["io.modelcontextprotocol/protocolVersion"];
	return typeof version === "string" ? version : undefined;
}

export class McpProtocolSession {
	private readonly options: McpServerOptions;
	private readonly toolsByName = new Map<string, ToolDefinition>();
	private readonly controllers = new Map<string, AbortController>();
	private legacyProtocolVersionValue: string | undefined;

	constructor(options: McpServerOptions) {
		this.options = options;
		for (const tool of options.tools) {
			if (this.isToolEnabled(tool.name)) this.toolsByName.set(tool.name, tool);
		}
	}

	get legacyProtocolVersion(): string | undefined {
		return this.legacyProtocolVersionValue;
	}

	get activeRequestCount(): number {
		return this.controllers.size;
	}

	abortAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
	}

	private isToolEnabled(name: string): boolean {
		if (READ_TOOL_NAMES.has(name)) return true;
		if (name === "knowledge_plan") return this.options.allowRoots.length > 0 || this.options.allowNetwork;
		if (WRITE_TOOL_NAMES.has(name)) return this.options.allowWrite;
		if (ADMIN_TOOL_NAMES.has(name)) return this.options.allowAdmin;
		return false;
	}

	private async authorizeExistingPath(input: string): Promise<string> {
		if (this.options.allowRoots.length === 0) throw new Error("No --allow-root capability permits local paths");
		const canonical = realpathSync.native(resolve(input));
		if (!this.options.allowRoots.some((root) => isWithin(canonical, root))) {
			throw new Error(`Local path is outside the configured --allow-root scope: ${input}`);
		}
		return canonical;
	}

	private async authorizeOutputPath(input: string): Promise<string> {
		if (this.options.allowRoots.length === 0) throw new Error("No --allow-root capability permits local paths");
		const absolute = resolve(input);
		const canonical = existsSync(absolute)
			? realpathSync.native(absolute)
			: resolve(realpathSync.native(dirname(absolute)), basename(absolute));
		if (!this.options.allowRoots.some((root) => isWithin(canonical, root))) {
			throw new Error(`Output path is outside the configured --allow-root scope: ${input}`);
		}
		return canonical;
	}

	private async authorizeSource(source: string): Promise<string> {
		if (/^https?:\/\//i.test(source)) {
			if (!this.options.allowNetwork) throw new Error("URL access requires --allow-network");
			return source;
		}
		const absolute = resolve(source);
		if (existsSync(absolute)) return this.authorizeExistingPath(absolute);
		const pathLike =
			source.startsWith(".") ||
			source.startsWith("/") ||
			source.startsWith("~") ||
			/^[A-Za-z]:[\\/]/.test(source) ||
			(!source.includes("\n") && /[\\/]/.test(source));
		if (pathLike) throw new Error(`Local source does not exist or is outside authorized roots: ${source}`);
		return source;
	}

	private async authorizeUpdate(target: string, signal: AbortSignal): Promise<string> {
		const knowledgeBases = await this.options.client.list(signal);
		const kb =
			knowledgeBases.find((candidate) => candidate.id === target) ??
			knowledgeBases.find((candidate) => candidate.name === target);
		if (!kb) throw new Error(`Knowledge base not found: ${target}`);
		if (kb.source_type === "url" || (kb.source_path && /^https?:\/\//i.test(kb.source_path))) {
			if (!this.options.allowNetwork) throw new Error("Updating this URL knowledge base requires --allow-network");
		} else if (kb.source_path) {
			await this.authorizeExistingPath(kb.source_path);
		}
		return kb.id;
	}

	private async authorizeToolCall(
		name: string,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		switch (name) {
			case "knowledge_plan":
			case "knowledge_add":
				return {
					...argumentsValue,
					source: await this.authorizeSource(requiredString(argumentsValue, "source")),
				};
			case "knowledge_update":
				return {
					...argumentsValue,
					target: await this.authorizeUpdate(requiredString(argumentsValue, "target"), signal),
				};
			case "knowledge_import":
				return {
					...argumentsValue,
					input: await this.authorizeExistingPath(requiredString(argumentsValue, "input")),
				};
			case "knowledge_export":
				return {
					...argumentsValue,
					output: await this.authorizeOutputPath(requiredString(argumentsValue, "output")),
				};
			default:
				return argumentsValue;
		}
	}

	private toolList(): Record<string, unknown>[] {
		return [...this.toolsByName.values()].map((tool) => ({
			name: tool.name,
			title: tool.label,
			description: tool.description,
			inputSchema: tool.parameters,
			annotations: {
				readOnlyHint: tool.approval === "read",
				destructiveHint: tool.name === "knowledge_remove" || tool.name === "knowledge_clear",
			},
		}));
	}

	private serverInfo(): Record<string, string> {
		return { name: "pi-knowledge", version: this.options.serverVersion };
	}

	private modernResult(result: Record<string, unknown>): Record<string, unknown> {
		const existingMeta = isObjectRecord(result._meta) ? result._meta : {};
		return {
			...result,
			resultType: "complete",
			_meta: {
				...existingMeta,
				"io.modelcontextprotocol/serverInfo": this.serverInfo(),
				"com.pi-knowledge/profile": this.options.profile.name,
			},
		};
	}

	private modernCacheableResult(result: Record<string, unknown>): Record<string, unknown> {
		return this.modernResult({
			...result,
			ttlMs: MODERN_STATIC_LIST_TTL_MS,
			cacheScope: "private",
		});
	}

	private legacyHandshake(protocolVersion: string): Record<string, unknown> {
		return {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: this.serverInfo(),
			instructions:
				"Use knowledge_symbol_search for exact identifiers, then knowledge_search for broader context. Mutating tools follow the server launch capabilities.",
		};
	}

	private modernDiscovery(): Record<string, unknown> {
		return this.modernCacheableResult({
			supportedVersions: [...SUPPORTED_MCP_PROTOCOLS],
			capabilities: { tools: { listChanged: false } },
			instructions:
				"Use knowledge_symbol_search for exact identifiers, then knowledge_search for broader context. Mutating tools follow the server launch capabilities.",
		});
	}

	private async callTool(
		request: JsonRpcRequest,
		params: Record<string, unknown>,
		era: McpProtocolEra,
		emit: McpMessageEmitter,
		externalSignal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (request.id === undefined) throw new McpProtocolError(-32600, "Tool calls require a request id");
		const name = requiredString(params, "name");
		const tool = this.toolsByName.get(name);
		if (!tool || !tool.execute) throw new Error(`MCP tool is not enabled: ${name}`);
		const argumentsValue = params.arguments;
		if (argumentsValue !== undefined && !isObjectRecord(argumentsValue)) throw new Error("Invalid tool arguments");
		const controller = new AbortController();
		const key = requestKey(request.id);
		if (this.controllers.has(key)) throw new Error(`MCP request id is already active: ${String(request.id)}`);
		this.controllers.set(key, controller);
		const abort = (): void => controller.abort();
		if (externalSignal?.aborted) controller.abort();
		else externalSignal?.addEventListener("abort", abort, { once: true });
		let progressCount = 0;
		const meta = isObjectRecord(params._meta) ? params._meta : undefined;
		const progressToken =
			meta && (typeof meta.progressToken === "string" || typeof meta.progressToken === "number")
				? meta.progressToken
				: undefined;
		try {
			const authorizedArguments = await this.authorizeToolCall(name, argumentsValue ?? {}, controller.signal);
			const result = await tool.execute(
				key,
				authorizedArguments,
				controller.signal,
				(update) => {
					if (progressToken === undefined || progressCount >= MAX_PROGRESS_NOTIFICATIONS || controller.signal.aborted)
						return;
					const message = update.content.map((item) => item.text).join("\n");
					if (!message) return;
					progressCount++;
					const bounded = truncateMcpText(message, MAX_PROGRESS_MESSAGE_BYTES);
					void emit({
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken, progress: progressCount, message: bounded },
					}).catch((error: unknown) => this.options.onError?.(error));
				},
				{
					profile: this.options.profile.name,
					filesystemAccess: {
						allowedRoots: this.options.allowRoots,
						allowNetwork: this.options.allowNetwork,
					},
				},
			);
			const normalized = result as Record<string, unknown>;
			return era === "modern" ? this.modernResult(normalized) : normalized;
		} catch (error) {
			const failed = {
				content: [{ type: "text", text: mcpErrorMessage(error) }],
				isError: true,
			};
			return era === "modern" ? this.modernResult(failed) : failed;
		} finally {
			externalSignal?.removeEventListener("abort", abort);
			this.controllers.delete(key);
		}
	}

	private requestEra(request: JsonRpcRequest): McpProtocolEra {
		if (request.method === "initialize") return "legacy";
		if (this.legacyProtocolVersionValue) return "legacy";
		validateModernRequestMetadata(request.params ?? {});
		return "modern";
	}

	private notificationEra(request: JsonRpcRequest): McpProtocolEra | undefined {
		if (this.legacyProtocolVersionValue) return "legacy";
		try {
			validateModernRequestMetadata(request.params ?? {});
			return "modern";
		} catch (error) {
			this.options.onError?.(error);
			return undefined;
		}
	}

	private async dispatch(
		request: JsonRpcRequest,
		era: McpProtocolEra,
		emit: McpMessageEmitter,
		externalSignal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const params = request.params ?? {};
		if (request.method === "initialize") {
			if (this.legacyProtocolVersionValue) throw new McpProtocolError(-32602, "MCP protocol is already initialized");
			const requested = requiredString(params, "protocolVersion");
			if (!(LEGACY_MCP_PROTOCOLS as readonly string[]).includes(requested)) {
				throw new McpProtocolError(-32602, `Unsupported legacy MCP protocol version: ${requested}`);
			}
			this.legacyProtocolVersionValue = requested;
			return this.legacyHandshake(requested);
		}
		if (era === "legacy" && !this.legacyProtocolVersionValue) {
			throw new McpProtocolError(-32602, "MCP protocol is not initialized");
		}
		switch (request.method) {
			case "server/discover":
				if (era !== "modern")
					throw new McpProtocolError(-32601, "Method not found: server/discover", { httpStatus: 404 });
				return this.modernDiscovery();
			case "ping":
				return era === "modern" ? this.modernResult({}) : {};
			case "tools/list": {
				const result = { tools: this.toolList() };
				return era === "modern" ? this.modernCacheableResult(result) : result;
			}
			case "tools/call":
				return this.callTool(request, params, era, emit, externalSignal);
			default:
				throw new McpProtocolError(-32601, `Method not found: ${request.method}`, {
					httpStatus: era === "modern" ? 404 : undefined,
				});
		}
	}

	private cancel(params: Record<string, unknown>): void {
		const id = params.requestId;
		if (typeof id !== "string" && typeof id !== "number") return;
		this.controllers.get(requestKey(id))?.abort();
	}

	async handleRequest(
		request: JsonRpcRequest,
		emit: McpMessageEmitter,
		externalSignal?: AbortSignal,
	): Promise<McpHandledMessage> {
		if (request.method === "notifications/cancelled") {
			const era = this.notificationEra(request);
			if (era) this.cancel(request.params ?? {});
			return { request, era };
		}
		if (request.method === "notifications/initialized") {
			return { request, era: this.notificationEra(request) };
		}
		if (request.id === undefined) return { request, era: this.notificationEra(request) };
		let era: McpProtocolEra | undefined;
		try {
			era = this.requestEra(request);
			const result = await this.dispatch(request, era, emit, externalSignal);
			return { request, era, response: { jsonrpc: "2.0", id: request.id, result } };
		} catch (error) {
			const protocolError = error instanceof McpProtocolError ? error : undefined;
			const code = protocolError?.code ?? -32602;
			return {
				request,
				era,
				httpStatus: protocolError?.httpStatus,
				response: mcpRpcError(request.id, code, mcpErrorMessage(error), protocolError?.data),
			};
		}
	}
}
