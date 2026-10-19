import { createHash } from "node:crypto";
import { embedInModelWorker, measureEmbeddingInputInModelWorker } from "../model-worker-client.ts";

export type EmbeddingProvider = "local" | "openai";
export type EmbeddingPrefix = "query" | "passage";
export type EmbeddingPrefixStrategy = "on" | "off";

export interface EmbeddingConfig {
	provider: EmbeddingProvider;
	model: string;
	baseUrl?: string;
	maxChars: number;
	queryPrefix: "query";
	documentPrefix: "passage";
	prefixes: EmbeddingPrefixStrategy;
	pooling: "mean";
	normalize: true;
}

export interface EmbeddingInputMeasurement {
	counts: number[];
	maximum: number;
	preferredMaximum: number;
	unit: "tokens" | "characters";
}

let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];

export const CURRENT_EMBEDDING_MODEL = "multilingual-e5-small";
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "multilingual-e5-small";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_MAX_EMBED_CHARS = 20_000;
const IDLE_TIMEOUT_MS = Number(process.env.PI_KNOWLEDGE_EMBEDDING_IDLE_MS ?? 30_000);
const ENABLE_NATIVE_IDLE_DISPOSE = process.env.PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE === "true";
const API_FALLBACK_TO_LOCAL = process.env.PI_KNOWLEDGE_EMBEDDING_API_FALLBACK === "local";

function localEmbeddingConfig(maxChars: number, prefixes: EmbeddingPrefixStrategy): EmbeddingConfig {
	return {
		provider: "local",
		model: DEFAULT_LOCAL_EMBEDDING_MODEL,
		maxChars,
		queryPrefix: "query",
		documentPrefix: "passage",
		prefixes,
		pooling: "mean",
		normalize: true,
	};
}
function cleanEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function clearIdleTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = null;
}

function scheduleIdleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearIdleTimer();
	if (!ENABLE_NATIVE_IDLE_DISPOSE) return;
	disposeTimer = setTimeout(() => dispose(), IDLE_TIMEOUT_MS);
}

function beginRun(): void {
	activeRuns++;
	clearIdleTimer();
}

function endRun(): void {
	activeRuns--;
	if (activeRuns > 0) return;
	for (const resolve of idleWaiters.splice(0)) resolve();
	if (!disposeRequested) scheduleIdleDispose();
}

function waitForNoActiveRuns(): Promise<void> {
	if (activeRuns === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

function providerInstanceHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function resolveEmbeddingPrefixStrategy(env: NodeJS.ProcessEnv): EmbeddingPrefixStrategy {
	const raw = cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_PREFIXES)?.toLowerCase();
	if (!raw) return "on";
	if (raw === "on" || raw === "off") return raw;
	throw new Error(`Unsupported embedding prefix strategy: ${raw}. Use PI_KNOWLEDGE_EMBEDDING_PREFIXES=on or off.`);
}

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
	const raw = cleanEnv(env.PI_KNOWLEDGE_EMBEDDING) ?? `local:${DEFAULT_LOCAL_EMBEDDING_MODEL}`;
	const separator = raw.indexOf(":");
	const provider = separator >= 0 ? raw.slice(0, separator).toLowerCase() : raw.toLowerCase();
	const model = separator >= 0 ? raw.slice(separator + 1).trim() : "";
	const maxCharsValue = Number(cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_MAX_CHARS) ?? DEFAULT_API_MAX_EMBED_CHARS);
	const maxChars =
		Number.isFinite(maxCharsValue) && maxCharsValue > 0 ? Math.trunc(maxCharsValue) : DEFAULT_API_MAX_EMBED_CHARS;
	const prefixes = resolveEmbeddingPrefixStrategy(env);
	if (provider === "local") {
		const localModel = model || DEFAULT_LOCAL_EMBEDDING_MODEL;
		if (localModel !== DEFAULT_LOCAL_EMBEDDING_MODEL) {
			throw new Error(`Unsupported local embedding model: ${localModel}`);
		}
		return localEmbeddingConfig(maxChars, prefixes);
	}
	if (provider === "openai") {
		return {
			provider: "openai",
			model: model || DEFAULT_OPENAI_EMBEDDING_MODEL,
			baseUrl:
				cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_BASE_URL) ?? cleanEnv(env.OPENAI_BASE_URL) ?? DEFAULT_OPENAI_BASE_URL,
			maxChars,
			queryPrefix: "query",
			documentPrefix: "passage",
			prefixes,
			pooling: "mean",
			normalize: true,
		};
	}
	throw new Error(`Unsupported embedding provider: ${provider}`);
}

export function embeddingConfigLabel(config: EmbeddingConfig): string {
	return config.provider === "local" ? config.model : `${config.provider}:${config.model}`;
}

export function embeddingSignature(config: EmbeddingConfig, dimension: number): string {
	const base = config.baseUrl ? `:base-sha256=${providerInstanceHash(config.baseUrl)}` : "";
	const parts = [
		`${config.provider}:${config.model}${base}`,
		`dim=${dimension}`,
		`apiMax=${config.provider === "openai" ? config.maxChars : "none"}`,
		`pooling=${config.pooling}`,
		`normalize=${config.normalize}`,
		`q=${config.queryPrefix}`,
		`d=${config.documentPrefix}`,
	];
	if (config.prefixes === "off") parts.push("prefixes=off");
	return parts.join(":");
}

export async function dispose(): Promise<void> {
	clearIdleTimer();
	if (disposePromise) return disposePromise;
	disposeRequested = true;
	await waitForNoActiveRuns();
	disposePromise = Promise.resolve().finally(() => {
		disposePromise = null;
		disposeRequested = false;
	});
	return disposePromise;
}

export async function prepareForShutdown(): Promise<void> {
	clearIdleTimer();
	await waitForNoActiveRuns();
}

function applyEmbeddingPrefix(text: string, prefix: EmbeddingPrefix, config: EmbeddingConfig): string {
	return config.prefixes === "on" ? `${prefix}: ${text}` : text;
}

export async function measureEmbeddingInputs(
	texts: string[],
	prefix: EmbeddingPrefix,
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<EmbeddingInputMeasurement> {
	if (signal?.aborted) throw new Error("Cancelled");
	if (config.provider === "openai") {
		return {
			counts: texts.map((text) => applyEmbeddingPrefix(text, prefix, config).length),
			maximum: config.maxChars,
			preferredMaximum: Math.max(1, Math.floor(config.maxChars * 0.875)),
			unit: "characters",
		};
	}
	beginRun();
	try {
		const measurement = await measureEmbeddingInputInModelWorker(texts, prefix, config.prefixes, signal);
		return {
			...measurement,
			preferredMaximum: Math.max(1, Math.floor(measurement.maximum * 0.875)),
			unit: "tokens",
		};
	} finally {
		endRun();
	}
}

async function assertEmbeddingInputsWithinBudget(
	texts: string[],
	prefix: EmbeddingPrefix,
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<void> {
	const measurement = await measureEmbeddingInputs(texts, prefix, config, signal);
	for (let index = 0; index < measurement.counts.length; index++) {
		const count = measurement.counts[index];
		if (count !== undefined && count > measurement.maximum) {
			throw new Error(
				`${config.provider} embedding ${prefix} input ${index + 1} is ${count} ${measurement.unit}; maximum is ${measurement.maximum}. Split the input before embedding.`,
			);
		}
	}
}

async function embedViaAPI(
	texts: string[],
	prefix: EmbeddingPrefix,
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	const safeTexts = texts.map((text) => applyEmbeddingPrefix(text, prefix, config));
	const apiKey = cleanEnv(process.env.PI_KNOWLEDGE_EMBEDDING_API_KEY) ?? cleanEnv(process.env.OPENAI_API_KEY);
	if (!config.baseUrl) throw new Error("OpenAI embedding base URL is not configured");
	const endpoint = new URL("embeddings", `${config.baseUrl.replace(/\/+$/, "")}/`);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ input: safeTexts, model: config.model }),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`OpenAI embedding API error: ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
	}
	const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return data.data.map((d) => new Float32Array(d.embedding));
}

export async function embedTextsWithConfig(
	texts: string[],
	prefix: EmbeddingPrefix,
	signal?: AbortSignal,
	options: { allowApiFallback?: boolean } = {},
): Promise<{ vectors: Float32Array[]; config: EmbeddingConfig }> {
	const config = resolveEmbeddingConfig();
	let actualConfig = config;
	if (config.provider === "openai") {
		await assertEmbeddingInputsWithinBudget(texts, prefix, config, signal);
		if (signal?.aborted) throw new Error("Cancelled");
		try {
			return { vectors: await embedViaAPI(texts, prefix, config, signal), config };
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw new Error("Cancelled");
			if (!API_FALLBACK_TO_LOCAL || !options.allowApiFallback) throw error;
			console.warn(
				`pi-knowledge: embedding API failed; falling back to local model because PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local (${error instanceof Error ? error.message : String(error)})`,
			);
			actualConfig = localEmbeddingConfig(config.maxChars, config.prefixes);
		}
	}
	await assertEmbeddingInputsWithinBudget(texts, prefix, actualConfig, signal);
	beginRun();
	try {
		return { vectors: await embedInModelWorker(texts, prefix, actualConfig.prefixes, signal), config: actualConfig };
	} finally {
		endRun();
	}
}

export async function embedTexts(
	texts: string[],
	prefix: EmbeddingPrefix,
	signal?: AbortSignal,
	options: { allowApiFallback?: boolean } = {},
): Promise<Float32Array[]> {
	return (await embedTextsWithConfig(texts, prefix, signal, options)).vectors;
}

export async function embedQueryWithConfig(
	text: string,
	signal?: AbortSignal,
): Promise<{ vector: Float32Array; config: EmbeddingConfig }> {
	const { vectors, config } = await embedTextsWithConfig([text], "query", signal, { allowApiFallback: true });
	return { vector: vectors[0], config };
}

export async function embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
	return (await embedQueryWithConfig(text, signal)).vector;
}

export async function embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	return embedTexts(texts, "passage", signal, { allowApiFallback: false });
}
